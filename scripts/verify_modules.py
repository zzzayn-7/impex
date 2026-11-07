#!/usr/bin/env python3
"""End-to-end check of Module Management (Step 19) against the RUNNING stack.

    docker compose up -d                      # stack must be running; impex_organizations at 0005
    python scripts/verify_modules.py
    python scripts/verify_modules.py --skip-outage     # do not stop the Organization and Sales services

It creates throwaway organizations ("Module Check ..."), their administrators and a few business records, and drives the system as people do:
the Super Admin reviews and applies module changes in the Super Admin portal, the organization's administrator uses the Organization Portal
(pages, menu, API routes) AND the Inventory, Purchasing and Sales services directly with their own token (to show that the services enforce
the rules themselves, whatever a menu shows). It proves: the defaults and the migration of existing organizations, enabling/disabling, the
dependency rules, that business records are kept and come back, that operations in progress are never stranded (refused while posting, and a
posting that was already started can still be finished), that an outage never grants access, that concurrent changes cannot overwrite each
other, who may change what, tenant isolation, first-time setup, Help & Support (always open, never changes a module) and the append-only history.

Everything it created is deleted afterwards, by exact id. Organizations and records that existed before are not touched.
"""
import argparse
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402

AUTH, ORG, INVENTORY, SALES, PURCHASING, SUPPORT, SA_PORTAL, TENANT_PORTAL = 8000, 8001, 8002, 8003, 8004, 8005, 3000, 3001
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
results = []


def find_docker() -> str:
    found = shutil.which("docker")
    if found:
        return found
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DockerDesktop" / "resources" / "bin" / "docker.exe"
    if candidate.exists():
        return str(candidate)
    sys.exit("docker was not found on PATH. Open a new terminal (or start Docker Desktop) and retry.")


DOCKER = find_docker()


def docker(*args: str) -> str:
    return subprocess.run([DOCKER, *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def psql(db: str, sql: str) -> str:
    return docker("exec", "impex-postgres", "sh", "-c", f'psql -U $POSTGRES_USER -d {db} -tAc "{sql}"')


def psql_with_errors(db: str, sql: str) -> str:
    return docker("exec", "impex-postgres", "sh", "-c", f'psql -U $POSTGRES_USER -d {db} -tAc "{sql}" 2>&1')


def check(name: str, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def call(port, method, path, body=None, headers=None, cookies=None, raw=None, content_type="application/json"):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    hdrs = {"Content-Type": content_type, **(headers or {})}
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
    conn.request(method, path, payload, hdrs)
    res = conn.getresponse()
    data = res.read()
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    location = res.getheader("location") or ""
    conn.close()
    return res.status, data, set_cookies, location


def text_of(data: bytes) -> str:
    return data.decode(errors="replace").replace("<!-- -->", "")


def jbody(data: bytes):
    try:
        return json.loads(data)
    except ValueError:
        return {}


def cookie_value(set_cookies, name):
    for c in set_cookies:
        if c.startswith(name + "="):
            return c.split(";", 1)[0].split("=", 1)[1]
    return None


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def is_redirect(status):
    return status in (301, 302, 303, 307, 308)


def wait_until(fn, timeout=40, every=0.5):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(every)
    return fn()


def wait_health(port, path="/health", timeout=60):
    def up():
        try:
            return call(port, "GET", path)[0] == 200
        except OSError:
            return False

    return wait_until(up, timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-outage", action="store_true", help="do not stop the Organization and Sales services")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "modcheck-sa@example.org"
    org_ids, user_ids, tokens, cookies, emails = {}, {}, {}, {}, {}
    created = CreatedIds()

    # ---- people ----------------------------------------------------------------------------------------------------------------
    def tenant(who, method, path, body=None, headers=None, **kw):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]} if who in cookies else None, **kw)

    def tpage(who, path):
        status, data, _, location = tenant(who, "GET", path)
        return status, text_of(data), location

    def tapi(who, method, path, body=None, headers=None):
        status, data, _, _ = tenant(who, method, path, body, headers)
        return status, jbody(data)

    def svc(who, port, method, path, body=None, headers=None):
        status, data, _, _ = call(port, method, path, body, {**bearer(tokens[who]), **(headers or {})})
        return status, jbody(data)

    def sa_portal(method, path, body=None, headers=None, who="sa"):
        return call(SA_PORTAL, method, path, body, headers, cookies={"impex_session": cookies[who]} if who in cookies else None)

    def sa_api(method, path, body=None, headers=None):
        status, data, _, _ = sa_portal(method, path, body, headers)
        return status, jbody(data)

    def org_api(method, path, body=None, who="sa"):
        status, data, _, _ = call(ORG, method, path, body, bearer(tokens[who]))
        return status, jbody(data)

    def sign_in_tenant(who, address):
        status, _data, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": address, "password": password})
        cookies[who] = cookie_value(sc, "impex_tenant_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": address, "password": password})
        tokens[who] = jbody(data2).get("access_token")
        return status

    def new_org(key, name):
        status, data, _, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"modcheck-{key}-{secrets.token_hex(3)}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(tokens["sa"]))
        org_ids[key] = jbody(data).get("id")
        created.add("organizations", org_ids[key])
        return status

    def add_admin(org_key, who, name):
        emails[who] = f"modcheck-{who}-{secrets.token_hex(2)}@example.org"
        status, data, _, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[org_key], "full_name": name, "email": emails[who], "password": password}, {"X-Internal-Key": internal_key})
        user_ids[who] = jbody(data).get("id")
        created.add("users", user_ids[who])
        return status

    def setup_done(org_key):
        """First-time setup finished (but NOT the modules: those are what this script is about)."""
        oid = org_ids[org_key]
        psql("impex_organizations", f"UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id = '{oid}'")
        psql("impex_auth", f"UPDATE users SET profile_setup_completed_at = now() WHERE organization_id = '{oid}'")

    # ---- the module state, as the Super Admin sees it ------------------------------------------------------------------------------
    def state(org_key):
        s2, data = org_api("GET", f"/api/v1/organizations/{org_ids[org_key]}/modules")
        return data if s2 == 200 else {}

    def enabled(org_key):
        return {m["key"]: m["enabled"] for m in state(org_key).get("modules", [])}

    def revision(org_key):
        return state(org_key).get("revision")

    def history(org_key, limit=200):
        return org_api("GET", f"/api/v1/organizations/{org_ids[org_key]}/modules/history?limit={limit}")[1].get("items", [])

    def preview(org_key, changes):
        status, body = sa_api("POST", f"/api/organizations/{org_ids[org_key]}/modules/preview", {"changes": changes})
        return status, body.get("preview", body)

    def apply(org_key, changes, reason=None, revision_override=None):
        """The Super Admin's two steps in the portal: review, then confirm the reviewed revision."""
        st, review = preview(org_key, changes)
        rev = revision_override if revision_override is not None else (review.get("revision") if st == 200 else revision(org_key))
        status, body = sa_api("PUT", f"/api/organizations/{org_ids[org_key]}/modules", {"changes": changes, "expected_revision": rev, **({"reason": reason} if reason else {})})
        return status, body

    def status_of(body):
        """A dispatch or receipt answer, with or without the portal's wrapper."""
        if not isinstance(body, dict):
            return None
        return body.get("status") or (body.get("dispatch") or body.get("receipt") or {}).get("status")

    def tenant_modules(who):
        status, body = svc(who, ORG, "GET", "/api/v1/tenant/organization")
        return body.get("modules") if status == 200 else None

    denied_marker = "is not enabled for your organization"

    # ---- business records ----------------------------------------------------------------------------------------------------------
    def product(who, sku, name, unit="pcs"):
        _, data, _, _ = tenant(who, "POST", "/api/products", {"sku": sku, "name": name, "category": "Module check", "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(data).get("product", {})
        created.add("products", body.get("id"))
        return body

    def warehouse(who, code, name):
        _, data, _, _ = tenant(who, "POST", "/api/warehouses", {"code": code, "name": name})
        body = jbody(data).get("warehouse", {})
        created.add("warehouses", body.get("id"))
        return body

    def stock_in(who, pid, wid, quantity):
        return tenant(who, "POST", "/api/stock/in", {"product_id": pid, "warehouse_id": wid, "quantity": quantity}, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})[0]

    def quantity(pid, wid):
        return Decimal(psql("impex_inventory", f"SELECT coalesce((SELECT quantity FROM stock_balances WHERE product_id = '{pid}' AND warehouse_id = '{wid}'), 0)") or "0")

    def new_client(who, name):
        _, data, _, _ = tenant(who, "POST", "/api/sales/clients", {"name": name})
        body = jbody(data).get("client", {})
        created.add("clients", body.get("id"))
        return body

    def ready_list(who, client_id, items):
        _, data, _, _ = tenant(who, "POST", "/api/sales/delivery-lists", {"clientId": client_id})
        made = jbody(data).get("list", {})
        for product_id, qty in items:
            tenant(who, "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": product_id, "quantity": qty})
        tenant(who, "POST", f"/api/sales/delivery-lists/{made['id']}/ready")
        return jbody(tenant(who, "GET", f"/api/sales/delivery-lists/{made['id']}")[1]).get("list", {})

    def draft_dispatch(who, delivery_list, product_id, qty, warehouse_id):
        item = next(i for i in delivery_list["items"] if i["product_id"] == product_id)
        line = {"deliveryListItemId": item["id"], "warehouseId": warehouse_id, "quantity": qty}
        status, data, _, _ = tenant(who, "POST", "/api/sales/dispatches", {"deliveryListId": delivery_list["id"], "lines": [line]}, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})
        body = jbody(data).get("dispatch", {})
        created.add("dispatches", body.get("id"))
        return body

    def supplier(who, name):
        _, data, _, _ = tenant(who, "POST", "/api/purchasing/suppliers", {"name": name})
        body = jbody(data).get("supplier", {})
        created.add("suppliers", body.get("id"))
        return body

    def placed_order(who, supplier_id, product_id, qty):
        _, data, _, _ = tenant(who, "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier_id, "currencyCode": "USD"}, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})
        order = jbody(data).get("order", {})
        tenant(who, "POST", f"/api/purchasing/purchase-orders/{order['id']}/lines", {"productId": product_id, "quantity": qty, "unitPrice": "2.00"})
        tenant(who, "POST", f"/api/purchasing/purchase-orders/{order['id']}/order")
        return jbody(tenant(who, "GET", f"/api/purchasing/purchase-orders/{order['id']}")[1]).get("order", {})

    def draft_receipt(who, order, product_id, accepted, warehouse_id):
        line = next(l for l in order["lines"] if l["product_id"] == product_id)
        body = {"purchaseOrderId": order["id"], "lines": [{"purchaseOrderLineId": line["id"], "acceptedQuantity": accepted, "rejectedQuantity": "0", "warehouseId": warehouse_id}]}
        status, data, _, _ = tenant(who, "POST", "/api/purchasing/goods-receipts", body, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})
        receipt = jbody(data).get("receipt", {})
        created.add("goods_receipts", receipt.get("id"))
        return receipt

    # ------------------------------------------------------------------------------------------------------------------------------
    existing_snapshot, existing_history, existing_orgs = "", "?", "?"
    counter_before = psql("impex_support", "SELECT coalesce((SELECT last_number FROM support_counters WHERE name = 'ticket'), 0)")
    try:
        print("== setup: a throwaway Super Admin, organizations A, B, C and their administrators")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        existing_snapshot = psql("impex_organizations", "SELECT coalesce(string_agg(organization_id || ':' || module_key || ':' || enabled::text, ',' ORDER BY organization_id, module_key), '') FROM organization_modules")
        existing_orgs = psql("impex_organizations", "SELECT count(*) FROM organizations")
        existing_history = psql("impex_organizations", "SELECT count(*) FROM organization_module_history")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='MODcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, data, sc, _ = call(SA_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        cookies["sa"] = cookie_value(sc, "impex_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        tokens["sa"] = jbody(data2).get("access_token")
        check("throwaway Super Admin can sign in to the Super Admin portal", status == 200 and cookies["sa"] and tokens["sa"], status)
        check("organizations A, B and C are created through the real API", all(new_org(k, f"Module Check {n}") == 201 for k, n in (("a", "Alpha"), ("b", "Beta"), ("c", "Gamma"))))
        check("their administrators A1, B1 and C1 are created", add_admin("a", "a1", "Olivia Owner") == 201 and add_admin("b", "b1", "Bruno Beta") == 201 and add_admin("c", "c1", "Cora Newcomer") == 201)
        for k in ("a", "b"):
            setup_done(k)  # C keeps its first-time setup unfinished
        for who, address in emails.items():
            check(f"{who.upper()} signs in to the Organization Portal", sign_in_tenant(who, address) == 200 and cookies.get(who) and tokens.get(who))

        print("\n== 1. defaults, and the migration of organizations that already existed")
        a = state("a")
        check("a NEW organization has Inventory enabled and Purchasing, Sales and Finance disabled", enabled("a") == {"inventory": True, "purchasing": False, "sales": False, "finance": False}, enabled("a"))
        check("the Super Admin's view lists the four modules with their features, dependencies and the permanent capabilities", [m["key"] for m in a["modules"]] == ["inventory", "purchasing", "sales", "finance"]
              and a["modules"][1]["requires"] == ["inventory"] and a["modules"][3]["available"] is True and [p["key"] for p in a["permanent"]] == ["authentication", "organization", "onboarding", "support"], a)
        check("the defaults are in the history, recorded by the system", {h["action"] for h in history("a")} == {"seeded"} and len(history("a")) == 4)
        check("the organization's own answer lists only what it can use", tenant_modules("a1") == ["inventory"], tenant_modules("a1"))
        pre_existing = psql("impex_organizations", f"SELECT count(*) FROM organizations o WHERE o.id NOT IN ('{org_ids['a']}', '{org_ids['b']}', '{org_ids['c']}')")
        migrated = psql("impex_organizations", f"SELECT count(DISTINCT o.id) FROM organizations o JOIN organization_modules m ON m.organization_id = o.id WHERE m.module_key IN ('inventory', 'purchasing', 'sales') AND m.enabled AND o.id NOT IN ('{org_ids['a']}', '{org_ids['b']}', '{org_ids['c']}') GROUP BY m.module_key ORDER BY 1 LIMIT 1")
        check("every organization that existed before kept Inventory, Purchasing and Sales (nobody lost access)", pre_existing == migrated or pre_existing == "0", (pre_existing, migrated))
        check("and their migration is recorded as such, with no Super Admin named", psql("impex_organizations", f"SELECT count(*) FROM organization_module_history WHERE action = 'migrated' AND changed_by IS NULL") == str(int(pre_existing) * 4) if pre_existing != "0" else True)

        print("\n== 2. Inventory only: pages, menu, dashboard, API routes and the services themselves")
        s, html, loc = tpage("a1", "/")
        check("the dashboard lists the Inventory module and no other", s == 200 and 'data-module="inventory"' in html and 'data-module="sales"' not in html and 'data-module="purchasing"' not in html, s)
        check("the menu has Inventory's pages, Dashboard and Help & Support; no Purchasing or Sales page is listed",
              all(f'href="{h}"' in html for h in ("/products", "/warehouses", "/stock", "/scan", "/movements", "/support")) and not any(f'href="{h}"' in html for h in ("/suppliers", "/purchase-orders", "/goods-receipts", "/clients", "/delivery-lists", "/dispatches", "/invoices")))
        check("an Inventory page opens normally", tpage("a1", "/products")[0] == 200 and denied_marker not in tpage("a1", "/products")[1])
        for path in ("/suppliers", "/purchase-orders", "/goods-receipts", "/clients", "/delivery-lists", "/dispatches", "/invoices", "/clients/" + str(uuid.uuid4()), "/invoices/new"):
            s, html, loc = tpage("a1", path)
            check(f"typing {path} shows 'access denied' (and not the page)", s == 200 and denied_marker in html and "data-module-denied" in html, (s, loc))
        s, html, _ = tpage("a1", "/clients")
        check("the denied page offers a request through Help & Support, which enables nothing by itself", 'href="/support/new?module=sales"' in html and "exactly as you left it" in html)
        for path in ("/api/sales/clients", "/api/sales/invoices", "/api/purchasing/suppliers", "/api/purchasing/purchase-orders"):
            s, body = tapi("a1", "GET", path)
            check(f"{path} is refused at the portal (403 module_disabled)", s == 403 and body.get("code") == "module_disabled", (s, body))
        s, body = tapi("a1", "POST", "/api/sales/clients", {"name": "Sneaky"}, {"X-Modules": "sales", "X-Organization-Id": org_ids["b"]})
        check("forged headers change nothing", s == 403 and body.get("code") == "module_disabled", (s, body))
        # the services themselves, called directly with the administrator's own token (the portal is bypassed completely)
        for label, port, path in (("Sales", SALES, "/api/v1/sales/clients"), ("Sales (invoices)", SALES, "/api/v1/sales/invoices"), ("Purchasing", PURCHASING, "/api/v1/purchasing/suppliers"), ("Purchasing (receipts)", PURCHASING, "/api/v1/purchasing/goods-receipts")):
            s, body = svc("a1", port, "GET", path)
            check(f"the {label} Service itself refuses A1 (403 module_disabled), with no portal involved", s == 403 and body.get("detail", {}).get("code") == "module_disabled", (s, body))
        s, body = svc("a1", SALES, "POST", "/api/v1/sales/clients", {"name": "Direct", "organization_id": org_ids["b"], "modules": ["sales"]}, {"X-Modules": "sales", "X-Organization-Id": org_ids["b"]})
        check("...also for a write, whatever the body, header or query says", s == 403, (s, body))
        s, body = svc("a1", INVENTORY, "GET", "/api/v1/inventory/products")
        check("the Inventory Service serves A1 (200)", s == 200, (s, body))
        main_a = warehouse("a1", "MAIN", "Main depot")
        bolt_a = product("a1", "MOD-BOLT", "Module bolt")
        check("Inventory works end to end through the portal (warehouse, product, stock)", bool(main_a.get("id")) and bool(bolt_a.get("id")) and stock_in("a1", bolt_a["id"], main_a["id"], "100") == 201 and quantity(bolt_a["id"], main_a["id"]) == 100)

        print("\n== 3. Help & Support is always open, and a request never changes a module")
        rev_before, hist_before = revision("a"), len(history("a"))
        s, html, loc = tpage("a1", "/support")
        check("Help & Support opens normally with most modules off", s == 200 and "Help &amp; Support" in html and denied_marker not in html, (s, loc))
        s, html, loc = tpage("a1", "/support/new?module=sales")
        check("the module request form is pre-filled with fixed wording as a Change Request", s == 200 and "Request to activate the Sales module" in html and "change_request" in html, s)
        s, html, loc = tpage("a1", "/support/new?module=%3Cscript%3Ealert(1)%3C/script%3E")
        check("nothing in the address is used as text: no live markup, no pre-filled request", s == 200 and "<script>alert(1)" not in html and "Request to activate" not in html)
        s, body = tapi("a1", "POST", "/api/support/tickets", {"subject": "Request to activate the Sales module", "category": "change_request", "priority": "normal", "message": "Please enable the Sales module for our organization."}, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})
        ticket = (body or {}).get("ticket", {})
        check("A1 opens that request as a ticket (201)", s == 201 and ticket.get("ticket_number"), (s, body))
        check("the ticket changed NOTHING: modules, revision and history are exactly as they were", enabled("a") == {"inventory": True, "purchasing": False, "sales": False, "finance": False} and revision("a") == rev_before and len(history("a")) == hist_before)
        inbox_status, inbox_data, _, _ = sa_portal("GET", "/support")
        check("the Super Admin sees the ticket in the Support Inbox (where only they can act on it)", inbox_status == 200 and ticket.get("ticket_number", "?") in text_of(inbox_data), inbox_status)
        check("every Help & Support API stays open too", tapi("a1", "GET", "/api/support/tickets")[0] == 200)
        s, body = svc("a1", SUPPORT, "GET", "/api/v1/support/tickets")
        check("...and so does the Support Service itself", s == 200, s)

        print("\n== 4. the Super Admin reviews and enables Purchasing and Sales")
        status, review = preview("a", {"purchasing": True, "sales": True})
        check("the review shows the result and nothing blocks it", status == 200 and review["can_apply"] is True and [c["module"] for c in review["changes"]] == ["purchasing", "sales"] and review["blockers"] == [], (status, review))
        check("reviewing changed nothing", enabled("a")["sales"] is False and revision("a") == rev_before)
        status, body = apply("a", {"purchasing": True, "sales": True}, reason="Approved in " + ticket.get("ticket_number", "a ticket"))
        check("confirming applies it (200)", status == 200 and body.get("state", {}).get("revision", 0) > rev_before, (status, body))
        check("both are enabled", enabled("a") == {"inventory": True, "purchasing": True, "sales": True, "finance": False}, enabled("a"))
        items = [h for h in history("a") if h["action"] == "enabled"]
        check("the history shows who (the Super Admin, by name and e-mail), what, when and why", {h["module"] for h in items} == {"purchasing", "sales"} and all(h["changed_by_name"] == "MODcheck SA" and h["changed_by_email"] == sa_email and h["created_at"] and (h["reason"] or "").startswith("Approved in") for h in items), items)
        check("the change reached A1 at once: the menu, the dashboard and the pages",
              all(f'href="{h}"' in tpage("a1", "/")[1] for h in ("/suppliers", "/clients", "/invoices")) and 'data-module="sales"' in tpage("a1", "/")[1] and tpage("a1", "/clients")[0] == 200 and denied_marker not in tpage("a1", "/clients")[1])
        check("...and the Sales and Purchasing Services now serve A1 directly", svc("a1", SALES, "GET", "/api/v1/sales/clients")[0] == 200 and svc("a1", PURCHASING, "GET", "/api/v1/purchasing/suppliers")[0] == 200)
        page_status, page_data, _, _ = sa_portal("GET", f"/organizations/{org_ids['a']}/modules")
        html = text_of(page_data)
        check("the Super Admin's module page shows both as enabled, with the history and the permanent capabilities", page_status == 200 and "Module management" in html and "Approved in" in html and "Always available" in html and "Planned: not available yet" not in html and "Journal Entries" in html, page_status)  # Finance is released (Step 21A)

        print("\n== 5. the records are kept when a module is switched off, and come back")
        client_a = new_client("a1", "Acme Ltd")
        sup_a = supplier("a1", "Acme Supplies")
        check("A1 created a client and a supplier", bool(client_a.get("id")) and bool(sup_a.get("id")))
        before = (psql("impex_sales", f"SELECT count(*) FROM clients WHERE organization_id = '{org_ids['a']}'"), psql("impex_purchasing", f"SELECT count(*) FROM suppliers WHERE organization_id = '{org_ids['a']}'"))
        status, body = apply("a", {"sales": False}, reason="Contract ended")
        check("the Super Admin switches Sales off (200)", status == 200 and enabled("a")["sales"] is False, (status, body))
        s, html, _ = tpage("a1", "/clients")
        check("A1 now gets 'access denied' for Clients, and the menu no longer lists Sales", denied_marker in html and 'href="/clients"' not in tpage("a1", "/")[1], s)
        check("the Sales Service refuses them directly, and the records are not readable", svc("a1", SALES, "GET", "/api/v1/sales/clients")[0] == 403 and svc("a1", SALES, "GET", f"/api/v1/sales/clients/{client_a['id']}")[0] == 403)
        check("Purchasing is unaffected", svc("a1", PURCHASING, "GET", "/api/v1/purchasing/suppliers")[0] == 200)
        after = (psql("impex_sales", f"SELECT count(*) FROM clients WHERE organization_id = '{org_ids['a']}'"), psql("impex_purchasing", f"SELECT count(*) FROM suppliers WHERE organization_id = '{org_ids['a']}'"))
        check("not one business record was deleted or changed", before == after == ("1", "1"), (before, after))
        status, body = apply("a", {"sales": True}, reason="Contract renewed")
        s, got = svc("a1", SALES, "GET", f"/api/v1/sales/clients/{client_a['id']}")
        check("switching it on again restores access to exactly the same records", status == 200 and s == 200 and got.get("name") == "Acme Ltd" and got.get("id") == client_a["id"], (status, s))

        print("\n== 6. dependencies and what cannot be changed")
        status, body = apply("a", {"inventory": False})
        check("Inventory cannot be disabled while Purchasing and Sales are enabled (409, with the reason)", status == 409 and body.get("code") == "blocked" and any(b["code"] == "required_by" for b in body.get("blockers", [])), (status, body))
        check("...and nothing changed", enabled("a")["inventory"] is True)
        status, body = apply("a", {"inventory": False, "purchasing": False, "sales": False}, reason="Pausing the whole organization")
        check("Inventory can go in the SAME change that switches its dependents off", status == 200 and not any(enabled("a").values()), (status, body))
        check("with everything off, the portal offers only the Dashboard and Help & Support", (lambda h: all(f'href="{p}"' not in h for p in ("/products", "/stock", "/suppliers", "/clients")) and 'href="/support"' in h and "No business modules are enabled" in h)(tpage("a1", "/")[1]))
        status, body = apply("a", {"sales": True})
        check("Sales cannot be enabled without Inventory (409)", status == 409 and any(b["code"] == "requires" for b in body.get("blockers", [])), (status, body))
        status, body = apply("a", {"inventory": True, "purchasing": True, "sales": True}, reason="Back in business")
        check("they can be enabled together (200), and every record is back", status == 200 and svc("a1", SALES, "GET", f"/api/v1/sales/clients/{client_a['id']}")[0] == 200 and svc("a1", INVENTORY, "GET", f"/api/v1/inventory/products/{bolt_a['id']}")[0] == 200, (status, body))
        status, body = apply("a", {"finance": True})
        check("Finance (released in Step 21A) needs no other module: the Super Admin can enable it on its own (200)", status == 200 and enabled("a")["finance"] is True, (status, body))
        status, body = apply("a", {"finance": False})
        check("...and switch it off again (200), which keeps everything", status == 200 and enabled("a")["finance"] is False, (status, body))
        for key in ("support", "authentication", "onboarding", "organization", "banana"):
            status, body = apply("a", {key: False})
            check(f"'{key}' is not a module: it cannot be switched off ({status})", status in (400, 422), (status, body))
        check("Help & Support is therefore still open", tapi("a1", "GET", "/api/support/tickets")[0] == 200)

        print("\n== 7. operations in progress are never stranded")
        shelf = warehouse("a1", "SHELF", "Shelf room")
        stock_in("a1", bolt_a["id"], shelf["id"], "50")
        dl1 = ready_list("a1", client_a["id"], [(bolt_a["id"], "15")])
        posting = draft_dispatch("a1", dl1, bolt_a["id"], "15", main_a["id"])
        other = draft_dispatch("a1", dl1, bolt_a["id"], "1", shelf["id"])
        check("a dispatch draft exists, plus a second draft", bool(posting.get("id")) and bool(other.get("id")) and posting.get("status") == "draft")
        psql("impex_sales", f"UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{posting['id']}'")
        stock_before = quantity(bolt_a["id"], main_a["id"])
        status, review = preview("a", {"sales": False})
        pend = [b for b in review.get("blockers", []) if b["code"] == "pending_operations"]
        check("the review says the dispatch being posted must finish first (with the count)", status == 200 and review["can_apply"] is False and pend and pend[0]["counts"][0]["count"] == 1, (status, review))
        status, body = apply("a", {"sales": False})
        check("so switching Sales off is refused (409) and Sales stays enabled", status == 409 and any(b["code"] == "pending_operations" for b in body.get("blockers", [])) and enabled("a")["sales"] is True, (status, body))
        s, review2 = preview("a", {"inventory": False, "purchasing": False, "sales": False})
        check("switching Inventory off is refused for the same reason", review2.get("can_apply") is False and any(b["code"] == "pending_operations" for b in review2.get("blockers", [])), review2)
        # the race the policy cannot close alone: the module is switched off at the very moment an operation is in flight
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = false WHERE organization_id = '{org_ids['a']}' AND module_key = 'sales'")
        s, body = svc("a1", SALES, "GET", f"/api/v1/sales/dispatches/{posting['id']}")
        check("with Sales off, the dispatch cannot even be read (403)", s == 403 and body["detail"]["code"] == "module_disabled", (s, body))
        s, body = svc("a1", SALES, "POST", f"/api/v1/sales/dispatches/{other['id']}/confirm")
        check("a DRAFT dispatch cannot be confirmed through the disabled module (403)", s == 403 and body["detail"]["code"] == "module_disabled", (s, body))
        s, body = svc("a1", SALES, "POST", f"/api/v1/sales/dispatches/{other['id']}/cancel")
        check("nor cancelled or edited (403)", s == 403)
        s, body = svc("a1", SALES, "POST", f"/api/v1/sales/dispatches/{posting['id']}/confirm")
        check("but the dispatch that was ALREADY posting can be finished (200, confirmed): it is not stranded", s == 200 and status_of(body) == "confirmed", (s, str(body)[:200]))
        check("and the goods were deducted exactly once", quantity(bolt_a["id"], main_a["id"]) == stock_before - 15 and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{bolt_a['id']}' AND source_type = 'client_dispatch' AND warehouse_id = '{main_a['id']}'") == "1")
        s, body = svc("a1", SALES, "POST", f"/api/v1/sales/dispatches/{posting['id']}/confirm")
        check("once finished, nothing more can be done through the disabled module (403)", s == 403)
        status, body = apply("a", {"sales": True}, reason="Race over")
        check("Sales is switched on again properly, and the finished dispatch and the untouched draft are both there", status == 200 and status_of(svc("a1", SALES, "GET", f"/api/v1/sales/dispatches/{posting['id']}")[1]) == "confirmed" and status_of(svc("a1", SALES, "GET", f"/api/v1/sales/dispatches/{other['id']}")[1]) == "draft")
        # the same for a goods receipt
        order = placed_order("a1", sup_a["id"], bolt_a["id"], "10")
        receipt = draft_receipt("a1", order, bolt_a["id"], "10", main_a["id"])
        psql("impex_purchasing", f"UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{receipt['id']}'")
        s, review = preview("a", {"purchasing": False})
        check("a goods receipt being posted blocks switching Purchasing off", review.get("can_apply") is False and any(b["code"] == "pending_operations" for b in review.get("blockers", [])), review)
        stock_before = quantity(bolt_a["id"], main_a["id"])
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = false WHERE organization_id = '{org_ids['a']}' AND module_key = 'purchasing'")
        s, body = svc("a1", PURCHASING, "POST", f"/api/v1/purchasing/goods-receipts/{receipt['id']}/confirm")
        check("with Purchasing off, a receipt already posting can still be finished (200)", s == 200, (s, str(body)[:200]))
        check("and the goods were added exactly once", quantity(bolt_a["id"], main_a["id"]) == stock_before + 10)
        check("a second confirmation is refused (403)", svc("a1", PURCHASING, "POST", f"/api/v1/purchasing/goods-receipts/{receipt['id']}/confirm")[0] == 403)
        check("Purchasing is switched on again properly", apply("a", {"purchasing": True})[0] == 200)

        print("\n== 8. concurrent changes cannot overwrite each other")
        rev = revision("b")
        outcomes = []

        def confirm_same(_):
            status, _b = sa_api("PUT", f"/api/organizations/{org_ids['b']}/modules", {"changes": {"purchasing": True}, "expected_revision": rev})
            outcomes.append(status)

        threads = [threading.Thread(target=confirm_same, args=(i,)) for i in range(6)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        enabled_rows = [h for h in history("b") if h["module"] == "purchasing" and h["action"] == "enabled"]
        check("six identical confirmations of one review at once record ONE change", set(outcomes) <= {200, 409} and 200 in outcomes and len(enabled_rows) == 1 and enabled("b")["purchasing"] is True, (outcomes, len(enabled_rows)))
        rev = revision("b")
        outcomes.clear()

        def confirm_other(changes):
            status, _b = sa_api("PUT", f"/api/organizations/{org_ids['b']}/modules", {"changes": changes, "expected_revision": rev})
            outcomes.append(status)

        threads = [threading.Thread(target=confirm_other, args=(c,)) for c in ({"sales": True}, {"purchasing": False})]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        check("two different changes reviewed against the same state: one wins (200), the other is told to review again (409)", sorted(outcomes) == [200, 409], outcomes)
        status, body = sa_api("PUT", f"/api/organizations/{org_ids['b']}/modules", {"changes": {"sales": False}, "expected_revision": 0})
        check("a stale review is refused by name", status == 409 and body.get("code") == "stale_revision", (status, body))
        check("each confirmed change is exactly one batch in the history", len({h["batch_id"] for h in history("b") if h["action"] in ("enabled", "disabled")}) == 2, history("b"))
        # leave B with only Inventory for the isolation checks
        enabled_b = enabled("b")
        want = {k: False for k in ("purchasing", "sales") if enabled_b.get(k)}
        if want:
            apply("b", want)

        print("\n== 9. who may do what")
        s, _ = org_api("GET", f"/api/v1/organizations/{org_ids['a']}/modules", who="a1")
        check("an organization administrator cannot read module management (403)", s == 403, s)
        s, _ = org_api("PUT", f"/api/v1/organizations/{org_ids['a']}/modules", {"changes": {"finance": True}, "expected_revision": 0}, who="a1")
        check("...nor change it (403)", s == 403)
        s, _ = org_api("POST", f"/api/v1/organizations/{org_ids['a']}/modules/preview", {"changes": {"sales": True}}, who="a1")
        check("...nor review a change (403)", s == 403)
        s, _ = org_api("GET", f"/api/v1/organizations/{org_ids['a']}/modules/history", who="a1")
        check("...nor read the history (403)", s == 403)
        for method in ("PUT", "POST", "PATCH", "DELETE"):
            check(f"the organization's own module endpoint takes no {method} (no way to edit its own modules)", call(ORG, method, "/api/v1/tenant/modules", {"modules": ["sales"]}, bearer(tokens["a1"]))[0] in (404, 405))
        check("without a token: 401", call(ORG, "GET", f"/api/v1/organizations/{org_ids['a']}/modules")[0] == 401 and call(ORG, "PUT", f"/api/v1/organizations/{org_ids['a']}/modules", {"changes": {"sales": True}, "expected_revision": 0})[0] == 401)
        s, data, _, loc = call(SA_PORTAL, "GET", f"/organizations/{org_ids['a']}/modules", cookies={"impex_session": tokens["a1"]})
        check("an organization administrator's token does not open the Super Admin portal's module page (redirect to login)", is_redirect(s) and "/login" in loc, (s, loc))
        s, data, _, _ = call(SA_PORTAL, "PUT", f"/api/organizations/{org_ids['a']}/modules", {"changes": {"sales": False}, "expected_revision": revision("a")}, cookies={"impex_session": tokens["a1"]})
        check("...and the portal's change route refuses it (403)", s == 403 and enabled("a")["sales"] is True, s)
        s, data, _, _ = call(SA_PORTAL, "PUT", f"/api/organizations/{org_ids['a']}/modules", {"changes": {"sales": False}, "expected_revision": 0})
        check("...and a request without a session (401)", s == 401)
        s, data, _, _ = call(TENANT_PORTAL, "PUT", f"/api/organizations/{org_ids['a']}/modules", {"changes": {"sales": False}, "expected_revision": 0}, cookies={"impex_tenant_session": cookies["a1"]})
        check("the Organization Portal has no route that could change modules at all", s in (404, 405))

        print("\n== 10. organizations stay apart")
        check("B has Inventory only while A has all three", enabled("b") == {"inventory": True, "purchasing": False, "sales": False, "finance": False} and tenant_modules("b1") == ["inventory"] and tenant_modules("a1") == ["inventory", "purchasing", "sales"], (enabled("b"), tenant_modules("a1")))
        check("B1 is refused by Sales and Purchasing directly, at the same time A1 is served", svc("b1", SALES, "GET", "/api/v1/sales/clients")[0] == 403 and svc("b1", PURCHASING, "GET", "/api/v1/purchasing/suppliers")[0] == 403 and svc("a1", SALES, "GET", "/api/v1/sales/clients")[0] == 200)
        s, body = svc("b1", SALES, "GET", f"/api/v1/sales/clients/{client_a['id']}")
        check("B1 cannot reach A's client, even with Sales: refused before any record is looked at", s == 403, s)
        s, body = svc("a1", SALES, "GET", "/api/v1/sales/clients", None, {"X-Organization-Id": org_ids["b"], "X-Modules": ""})
        check("A1 naming organization B in a header gets A's own answer", s == 200 and body.get("total") == 1, (s, body))
        check("A's changes never touched B's rows", psql("impex_organizations", f"SELECT count(*) FROM organization_modules WHERE organization_id = '{org_ids['b']}' AND enabled") == "1")
        status, body = apply("b", {"sales": True})
        check("B can be given Sales on its own, and A is unaffected", status == 200 and svc("b1", SALES, "GET", "/api/v1/sales/clients")[0] == 200 and svc("a1", SALES, "GET", "/api/v1/sales/clients")[1].get("total") == 1)
        apply("b", {"sales": False})

        print("\n== 11. first-time setup (organization C) is not bypassed, and not blocked, by modules")
        s, html, loc = tpage("c1", "/products")
        check("C1's Inventory page still redirects to /setup (onboarding comes first)", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        check("the setup screen and Help & Support open", tpage("c1", "/setup")[0] == 200 and tpage("c1", "/support")[0] == 200 and "Need help? Contact support" in tpage("c1", "/setup")[1])
        s, body = tapi("c1", "GET", "/api/products")
        check("business APIs answer setup_required first, not a module error", s == 403 and body.get("code") == "setup_required", (s, body))
        apply("c", {"sales": True})
        s, body = tapi("c1", "GET", "/api/sales/clients")
        check("enabling Sales for C does not skip its setup (still setup_required)", s == 403 and body.get("code") == "setup_required", (s, body))
        s, body = tapi("c1", "POST", "/api/support/tickets", {"subject": "Setup help", "category": "general_inquiry", "message": "I am stuck on the logo step."}, {"Idempotency-Key": f"mc-{uuid.uuid4()}"})
        check("C1 can still open a support ticket during setup", s == 201, (s, body))
        apply("c", {"sales": False})

        if args.skip_outage:
            print("\n(skipped: outage checks - run without --skip-outage)")
        else:
            print("\n== 12. an outage never grants access")
            docker("compose", "stop", "organization-service")
            try:
                for label, port, path in (("Inventory", INVENTORY, "/api/v1/inventory/products"), ("Sales", SALES, "/api/v1/sales/clients"), ("Purchasing", PURCHASING, "/api/v1/purchasing/suppliers")):
                    s, _b = svc("a1", port, "GET", path)
                    check(f"with the Organization Service down, the {label} Service answers 503 (never 200, never a guess)", s == 503, s)
                s, _b = svc("b1", SALES, "GET", "/api/v1/sales/clients")
                check("...including for an organization that was never entitled (503, not a leak either way)", s == 503, s)
                s, body = tapi("a1", "GET", "/api/sales/clients")
                check("the portal's business routes answer 503 too", s == 503, (s, body))
                s, html, _ = tpage("a1", "/clients")
                check("a page shows the recoverable error, not the page", s == 200 and "load your workspace" in html and "Acme Ltd" not in html, s)
                check("a change by the Super Admin cannot be applied (503), so nothing is half-done", sa_api("PUT", f"/api/organizations/{org_ids['a']}/modules", {"changes": {"sales": False}, "expected_revision": 0})[0] in (503, 502, 409))
            finally:
                docker("compose", "start", "organization-service")
                wait_health(ORG)
            check("when it is back, A1 is served again and B1 is still refused", wait_until(lambda: svc("a1", SALES, "GET", "/api/v1/sales/clients")[0] == 200, 40) and svc("b1", SALES, "GET", "/api/v1/sales/clients")[0] == 403)
            docker("compose", "stop", "sales-service")
            try:
                s, review = preview("a", {"sales": False})
                check("with the Sales Service down, switching Sales off is refused: it could not be checked for operations in progress", review.get("can_apply") is False and any(b["code"] == "usage_unavailable" for b in review.get("blockers", [])), (s, review))
                status, body = apply("a", {"sales": False})
                check("and it is not applied (409), so nothing is switched off on a guess", status == 409 and enabled("a")["sales"] is True, (status, body))
            finally:
                docker("compose", "start", "sales-service")
                wait_health(SALES)
            check("once it is back the change can be reviewed again", preview("a", {"sales": False})[1].get("can_apply") is True)

        print("\n== 13. the history can never be rewritten")
        out = psql_with_errors("impex_organizations", f"UPDATE organization_module_history SET new_enabled = NOT new_enabled WHERE organization_id = '{org_ids['a']}'")
        check("a history entry cannot be changed", "append-only" in out, out)
        out = psql_with_errors("impex_organizations", f"DELETE FROM organization_module_history WHERE organization_id = '{org_ids['a']}'")
        check("a history entry cannot be deleted", "append-only" in out and len(history("a")) > 0, out)
        out = psql_with_errors("impex_organizations", f"DELETE FROM organizations WHERE id = '{org_ids['a']}'")
        check("an organization with history cannot be deleted by accident either", "append-only" in out and psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id = '{org_ids['a']}'") == "1", out)
        hist = history("a")
        check("the history lists every change, newest first, each with its actor", [h["created_at"] for h in hist] == sorted([h["created_at"] for h in hist], reverse=True) and all(h["changed_by_name"] for h in hist), len(hist))

        print("\n== 14. nothing that existed before was touched")
        now_snapshot = psql("impex_organizations", f"SELECT coalesce(string_agg(organization_id || ':' || module_key || ':' || enabled::text, ',' ORDER BY organization_id, module_key), '') FROM organization_modules WHERE organization_id NOT IN ({', '.join(repr(o) for o in org_ids.values())})")
        check("every pre-existing organization has exactly the modules it had before the run", now_snapshot == existing_snapshot, "differs")
        check("the number of pre-existing organizations is unchanged", psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id NOT IN ({', '.join(repr(o) for o in org_ids.values())})") == existing_orgs)
        check("the Super Admin portal's Organizations screen links to module management", f'href="/organizations/{org_ids["a"]}/modules"' in text_of(sa_portal("GET", "/organizations")[1]))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        users = created.get("users")
        left = {}
        if orgs:
            ticket_ids = [r for r in psql("impex_support", "SELECT id FROM support_tickets WHERE organization_id IN (" + ", ".join(f"'{o}'" for o in orgs) + ")").splitlines() if UUID_RE.match(r)]
            if ticket_ids:
                for table, column in (("support_ticket_events", "ticket_id"), ("support_email_outbox", "ticket_id"), ("support_requests", "ticket_id"), ("support_messages", "ticket_id"), ("support_tickets", "id")):
                    left[table] = delete_exact(psql, "impex_support", table, ticket_ids, column, ledger=True)
            left["support requests (by scope)"] = delete_exact(psql, "impex_support", "support_requests", orgs + users, "scope_id", ledger=True)
        if counter_before.isdigit() and psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE ticket_number > 'SUP-' || lpad('{int(counter_before)}', 6, '0')") == "0":
            psql("impex_support", f"UPDATE support_counters SET last_number = {int(counter_before)} WHERE name = 'ticket'")
        left.update({
            "receipt lines": delete_exact(psql, "impex_purchasing", "goods_receipt_lines", orgs, "organization_id", ledger=True),
            "receipt requests": delete_exact(psql, "impex_purchasing", "goods_receipt_requests", orgs, "organization_id"),
            "receipts": delete_exact(psql, "impex_purchasing", "goods_receipts", orgs, "organization_id", ledger=True),
            "receipt counters": delete_exact(psql, "impex_purchasing", "goods_receipt_counters", orgs, "organization_id"),
            "order lines": delete_exact(psql, "impex_purchasing", "purchase_order_lines", orgs, "organization_id", ledger=True),
            "order requests": delete_exact(psql, "impex_purchasing", "purchase_order_requests", orgs, "organization_id"),
            "orders": delete_exact(psql, "impex_purchasing", "purchase_orders", orgs, "organization_id", ledger=True),
            "order counters": delete_exact(psql, "impex_purchasing", "purchase_order_counters", orgs, "organization_id"),
            "suppliers": delete_exact(psql, "impex_purchasing", "suppliers", orgs, "organization_id"),
            "dispatch lines": delete_exact(psql, "impex_sales", "dispatch_lines", orgs, "organization_id", ledger=True),
            "dispatch requests": delete_exact(psql, "impex_sales", "dispatch_requests", orgs, "organization_id"),
            "dispatches": delete_exact(psql, "impex_sales", "dispatches", orgs, "organization_id", ledger=True),
            "dispatch counters": delete_exact(psql, "impex_sales", "dispatch_counters", orgs, "organization_id"),
            "list items": delete_exact(psql, "impex_sales", "delivery_list_items", orgs, "organization_id", ledger=True),
            "lists": delete_exact(psql, "impex_sales", "delivery_lists", orgs, "organization_id"),
            "list counters": delete_exact(psql, "impex_sales", "delivery_list_counters", orgs, "organization_id"),
            "clients": delete_exact(psql, "impex_sales", "clients", orgs, "organization_id"),
            "movements": delete_exact(psql, "impex_inventory", "stock_movements", orgs, "organization_id", ledger=True),
            "balances": delete_exact(psql, "impex_inventory", "stock_balances", orgs, "organization_id"),
            "operations": delete_exact(psql, "impex_inventory", "stock_operations", orgs, "organization_id"),
            "warehouses": delete_exact(psql, "impex_inventory", "warehouses", created.get("warehouses")),
            "products": delete_exact(psql, "impex_inventory", "products", created.get("products")),
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", users),
        })
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(created.get('products'))} products, {len(users)} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))
        remaining_history = psql("impex_organizations", "SELECT count(*) FROM organization_module_history")
        print(f"module history rows now: {remaining_history} (before the run: {existing_history})")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
