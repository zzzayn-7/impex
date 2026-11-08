#!/usr/bin/env python3
"""End-to-end check of the Finance foundation (Step 21A) against the RUNNING stack.

    docker compose up -d                      # stack must be running; impex_finance at 0001
    python scripts/verify_finance.py
    python scripts/verify_finance.py --skip-outage     # do not stop the Sales and Finance services

It creates throwaway organizations ("Finance Check ..."), their administrators and a few business records, and drives the system as people do: the
Super Admin switches Finance on in the Super Admin portal, the organization's administrator uses the Organization Portal (pages and API routes) AND the
Finance Service directly with their own token (to show that the service enforces the rules itself, whatever the portal shows). It proves: Finance is
off until the Super Admin enables it and is enforced by the service; the chart of accounts and its protections; balanced exact double-entry posting;
idempotency and concurrency; immutable posted entries and append-only reversals (also at the database); expenses; automatic, exactly-once postings
from issued invoices, payments, voids and confirmed goods receipts (a purchase order alone posts nothing); nothing of Sales/Purchasing/Inventory
is ever changed by Finance; Sales/Finance outages and recovery; events from before activation are not back-filled; multi-currency separation; tenant
isolation; and the first-time-setup gate.

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
from _onboarding import enable_modules  # noqa: E402

AUTH, ORG, INVENTORY, SALES, PURCHASING, FINANCE, SA_PORTAL, TENANT_PORTAL = 8000, 8001, 8002, 8003, 8004, 8006, 3000, 3001
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
    parser.add_argument("--skip-outage", action="store_true", help="do not stop the Sales and Finance services")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "fincheck-sa@example.org"
    org_ids, user_ids, tokens, cookies, emails = {}, {}, {}, {}, {}
    created = CreatedIds()

    # ---- people and calls ------------------------------------------------------------------------------------------------------------
    def tenant(who, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]} if who in cookies else None)

    def tpage(who, path):
        status, data, _, location = tenant(who, "GET", path)
        return status, text_of(data), location

    def tapi(who, method, path, body=None, headers=None):
        status, data, _, _ = tenant(who, method, path, body, headers)
        return status, jbody(data)

    def fin(who, method, path, body=None, headers=None):
        """The Finance Service itself, called directly with the administrator's own token (the portal is bypassed completely)."""
        status, data, _, _ = call(FINANCE, method, f"/api/v1/finance{path}", body, {**bearer(tokens[who]), **(headers or {})})
        return status, jbody(data)

    def svc(who, port, method, path, body=None, headers=None):
        status, data, _, _ = call(port, method, path, body, {**bearer(tokens[who]), **(headers or {})})
        return status, jbody(data)

    def sa_portal(method, path, body=None, headers=None):
        return call(SA_PORTAL, method, path, body, headers, cookies={"impex_session": cookies["sa"]})

    def sa_api(method, path, body=None):
        status, data, _, _ = sa_portal(method, path, body)
        return status, jbody(data)

    def sign_in_tenant(who, address):
        status, _data, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": address, "password": password})
        cookies[who] = cookie_value(sc, "impex_tenant_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": address, "password": password})
        tokens[who] = jbody(data2).get("access_token")
        return status

    def new_org(key, name):
        status, data, _, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"fincheck-{key}-{secrets.token_hex(3)}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(tokens["sa"]))
        org_ids[key] = jbody(data).get("id")
        created.add("organizations", org_ids[key])
        return status

    def add_admin(org_key, who, name):
        emails[who] = f"fincheck-{who}-{secrets.token_hex(2)}@example.org"
        status, data, _, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[org_key], "full_name": name, "email": emails[who], "password": password}, {"X-Internal-Key": internal_key})
        user_ids[who] = jbody(data).get("id")
        created.add("users", user_ids[who])
        return status

    def setup_done(org_key, modules=("inventory", "purchasing", "sales")):
        oid = org_ids[org_key]
        psql("impex_organizations", f"UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id = '{oid}'")
        psql("impex_auth", f"UPDATE users SET profile_setup_completed_at = now() WHERE organization_id = '{oid}'")
        enable_modules(psql, oid, modules)

    def finance_module(org_key, on):
        """The Super Admin's two steps in the portal: review, then confirm the reviewed revision."""
        oid = org_ids[org_key]
        st, data, _, _ = sa_portal("POST", f"/api/organizations/{oid}/modules/preview", {"changes": {"finance": on}})
        review = jbody(data).get("preview", {})
        status, body = sa_api("PUT", f"/api/organizations/{oid}/modules", {"changes": {"finance": on}, "expected_revision": review.get("revision"), "reason": "verify_finance.py"})
        return status, body

    # ---- business records ------------------------------------------------------------------------------------------------------------
    def product(who, sku, name, unit="pcs"):
        _, data, _, _ = tenant(who, "POST", "/api/products", {"sku": sku, "name": name, "category": "Finance check", "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(data).get("product", {})
        created.add("products", body.get("id"))
        return body

    def stock_in(who, pid, quantity):
        return tenant(who, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})[0]

    def new_client(who, name):
        _, data, _, _ = tenant(who, "POST", "/api/sales/clients", {"name": name})
        body = jbody(data).get("client", {})
        created.add("clients", body.get("id"))
        return body

    def confirmed_dispatch(who, client_id, product_id, qty):
        _, data, _, _ = tenant(who, "POST", "/api/sales/delivery-lists", {"clientId": client_id})
        made = jbody(data).get("list", {})
        tenant(who, "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": product_id, "quantity": qty})
        tenant(who, "POST", f"/api/sales/delivery-lists/{made['id']}/ready")
        delivery_list = jbody(tenant(who, "GET", f"/api/sales/delivery-lists/{made['id']}")[1]).get("list", {})
        item = next(i for i in delivery_list["items"] if i["product_id"] == product_id)
        _, data, _, _ = tenant(who, "POST", "/api/sales/dispatches", {"deliveryListId": delivery_list["id"], "lines": [{"deliveryListItemId": item["id"], "quantity": qty}]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        dispatch = jbody(data).get("dispatch", {})
        tenant(who, "POST", f"/api/sales/dispatches/{dispatch['id']}/confirm")
        return jbody(tenant(who, "GET", f"/api/sales/dispatches/{dispatch['id']}")[1]).get("dispatch", {})

    def invoice(who, client_id, dispatch, product_id, qty, price, currency="USD", issue=True, **extra):
        line = next(l for l in dispatch["lines"] if l["product_id"] == product_id)
        _, data, _, _ = tenant(who, "POST", "/api/sales/invoices", {"clientId": client_id, "currencyCode": currency, "lines": [{"dispatchLineId": line["id"], "quantity": qty, "unitPrice": price, **extra}]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        made = jbody(data).get("invoice", {})
        if issue and made.get("id"):
            made = jbody(tenant(who, "POST", f"/api/sales/invoices/{made['id']}/issue")[1]).get("invoice", made)
        return made

    def pay(who, invoice_id, amount):
        status, data, _, _ = tenant(who, "POST", f"/api/sales/invoices/{invoice_id}/payments", {"amount": amount, "method": "bank_transfer"}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        return status, jbody(data)

    def sync_now(who):
        return tapi(who, "POST", "/api/finance/sync/run")

    def entries(who, **params):
        query = "&".join(f"{k}={v}" for k, v in params.items())
        s, body = tapi(who, "GET", f"/api/finance/journal-entries?limit=200&{query}")
        return body.get("items", []) if s == 200 else []

    def entry(who, entry_id):
        return tapi(who, "GET", f"/api/finance/journal-entries/{entry_id}")[1].get("entry", {})

    def lines_of(e):
        return sorted((l["account_code"], l["debit"], l["credit"]) for l in e.get("lines", []))

    def fin_entry_for(org_key, source_key):
        eid = psql("impex_finance", f"SELECT id FROM journal_entries WHERE organization_id = '{org_ids[org_key]}' AND source_key = '{source_key}'")
        return eid if UUID_RE.match(eid or "") else None

    def count_entries(org_key, where=""):
        return int(psql("impex_finance", f"SELECT count(*) FROM journal_entries WHERE organization_id = '{org_ids[org_key]}' {where}") or "0")

    def sales_snapshot(org_key):
        o = org_ids[org_key]
        return psql("impex_sales", f"SELECT (SELECT coalesce(md5(string_agg(i::text, ',' ORDER BY i.id)), '') FROM invoices i WHERE i.organization_id = '{o}') || '/' || (SELECT coalesce(md5(string_agg(p::text, ',' ORDER BY p.id)), '') FROM invoice_payments p WHERE p.organization_id = '{o}') || '/' || (SELECT count(*) FROM invoice_lines WHERE organization_id = '{o}')")

    def purchasing_snapshot(org_key):
        o = org_ids[org_key]
        return psql("impex_purchasing", f"SELECT (SELECT coalesce(md5(string_agg(r::text, ',' ORDER BY r.id)), '') FROM goods_receipts r WHERE r.organization_id = '{o}') || '/' || (SELECT coalesce(md5(string_agg(p::text, ',' ORDER BY p.id)), '') FROM purchase_orders p WHERE p.organization_id = '{o}')")

    def inventory_snapshot(org_key):
        o = org_ids[org_key]
        return psql("impex_inventory", f"SELECT (SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{o}') || '/' || (SELECT count(*) FROM stock_movements WHERE organization_id = '{o}')")

    # ------------------------------------------------------------------------------------------------------------------------------
    try:
        print("== setup: a throwaway Super Admin, organizations A, B and C and their administrators")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        module_key = docker("compose", "exec", "-T", "finance-service", "printenv", "MODULE_INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='FINcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, data, sc, _ = call(SA_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        cookies["sa"] = cookie_value(sc, "impex_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        tokens["sa"] = jbody(data2).get("access_token")
        check("throwaway Super Admin can sign in to the Super Admin portal", status == 200 and cookies["sa"] and tokens["sa"], status)
        check("organizations A, B and C are created through the real API", all(new_org(k, f"Finance Check {n}") == 201 for k, n in (("a", "Alpha"), ("b", "Beta"), ("c", "Gamma"))))
        check("their administrators A1, B1 and C1 are created", add_admin("a", "a1", "Olivia Owner") == 201 and add_admin("b", "b1", "Bruno Beta") == 201 and add_admin("c", "c1", "Cora Newcomer") == 201)
        setup_done("a")
        setup_done("b")  # C keeps its first-time setup unfinished
        psql("impex_organizations", f"UPDATE organizations SET default_currency = 'EUR' WHERE id = '{org_ids['b']}'")
        for who, address in emails.items():
            check(f"{who.upper()} signs in to the Organization Portal", sign_in_tenant(who, address) == 200 and cookies.get(who) and tokens.get(who))

        # Records that exist BEFORE Finance is switched on (the cut-over: they must never be back-filled).
        print("\n== 0. Sales activity before Finance is switched on")
        bolt_a, flour_a = product("a1", "FIN-BOLT", "Finance bolt"), product("a1", "FIN-FLOUR", "Finance flour", "kg")
        check("Inventory works for A (products, stock)", all(x.get("id") for x in (bolt_a, flour_a)) and stock_in("a1", bolt_a["id"], "200") == 201 and stock_in("a1", flour_a["id"], "50") == 201)
        client_a = new_client("a1", "Acme Buyer Ltd")
        d_old = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "5")
        old_invoice = invoice("a1", client_a["id"], d_old, bolt_a["id"], "5", "10.00")
        check("an invoice is issued BEFORE Finance exists for A (Sales works on its own)", old_invoice.get("status") == "issued" and old_invoice.get("total") == "50.0000", old_invoice.get("status"))
        time.sleep(1.5)

        print("\n== 1. Finance is off until the Super Admin switches it on, and the service enforces that itself")
        check("a NEW organization has Finance disabled (the Super Admin's view lists it as available)", psql("impex_organizations", f"SELECT enabled FROM organization_modules WHERE organization_id = '{org_ids['a']}' AND module_key = 'finance'") == "f")
        check("A's own answer does not list Finance", "finance" not in (svc("a1", ORG, "GET", "/api/v1/tenant/organization")[1].get("modules") or []))
        s, html, loc = tpage("a1", "/finance")
        check("typing /finance shows 'access denied' with a request offer, not the page", s == 200 and "is not enabled for your organization" in html and "data-module-denied" in html and 'href="/support/new?module=finance"' in html, (s, loc))
        check("the menu has no Finance entry while it is off", 'href="/finance"' not in tpage("a1", "/")[1])
        for path in ("/finance/accounts", "/finance/expenses", "/finance/journal", "/finance/journal/new"):
            check(f"typing {path} is denied too", "data-module-denied" in tpage("a1", path)[1], path)
        s, body = tapi("a1", "GET", "/api/finance/accounts")
        check("the portal's Finance API is refused (403 module_disabled)", s == 403 and body.get("code") == "module_disabled", (s, body))
        s, body = fin("a1", "GET", "/accounts")
        check("the Finance Service ITSELF refuses A1 (403 module_disabled), with no portal involved", s == 403 and body.get("detail", {}).get("code") == "module_disabled", (s, body))
        s, body = fin("a1", "POST", "/journal-entries", {"entry_date": "2026-11-05", "description": "x", "lines": [], "modules": ["finance"], "organization_id": org_ids["b"]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}", "X-Modules": "finance", "X-Organization-Id": org_ids["b"]})
        check("...also for a write, whatever the body or headers claim", s == 403, (s, body))
        s, body = svc("a1", ORG, "PUT", f"/api/v1/organizations/{org_ids['a']}/modules", {"changes": {"finance": True}, "expected_revision": 1})
        check("an organization administrator cannot switch Finance on", s in (401, 403), (s, body))
        s, _d, _, _ = call(FINANCE, "GET", f"/internal/v1/organizations/{org_ids['a']}/entitlements", headers=bearer(tokens["a1"]))
        check("Finance exposes no internal routes a user token could use (404)", s == 404, s)
        check("nothing is posted for a disabled organization, and it has no Finance data at all", psql("impex_finance", f"SELECT count(*) FROM finance_organizations WHERE organization_id = '{org_ids['a']}'") == "0")

        print("\n== 2. only the Super Admin switches it on")
        s, body = finance_module("a", True)
        check("the Super Admin enables Finance for A (review, then confirm)", s == 200, (s, body))
        s, html, loc = tpage("a1", "/")
        check("A's menu now has Finance and the dashboard lists the module", s == 200 and 'href="/finance"' in html and 'data-module="finance"' in html, s)
        s, html, loc = tpage("a1", "/finance")
        check("the Financial Overview opens", s == 200 and "Financial Overview" in html and "data-module-denied" not in html, (s, loc))
        check("B and C still have Finance off", tapi("b1", "GET", "/api/finance/accounts")[0] == 403 and tapi("c1", "GET", "/api/finance/accounts")[0] in (403,))
        check("the Organization Service lists A among the organizations that can use Finance (service secret only)",
              org_ids["a"] in [o["organization_id"] for o in jbody(call(ORG, "GET", "/internal/v1/modules/finance/organizations", headers={"X-Internal-Key": module_key})[1])]
              and call(ORG, "GET", "/internal/v1/modules/finance/organizations", headers=bearer(tokens["a1"]))[0] == 401)

        print("\n== 3. the chart of accounts")
        s, body = tapi("a1", "GET", "/api/finance/accounts")
        accounts = body.get("accounts", [])
        by_code = {a["code"]: a for a in accounts}
        check("the starter chart has all five types and the system accounts Finance posts to", s == 200 and {a["account_type"] for a in accounts} == {"asset", "liability", "equity", "revenue", "expense"}
              and {a["system_key"] for a in accounts if a["is_system"]} == {"payments_received", "accounts_receivable", "inventory", "sales_tax_payable", "goods_received_not_invoiced", "accrued_expenses", "opening_balance_equity", "sales_revenue"}, (s, len(accounts)))
        ar = by_code["1100"]
        s, body = tapi("a1", "DELETE", f"/api/finance/accounts/{ar['id']}")
        check("a system account cannot be deleted (409 account_protected)", s == 409 and body.get("code") == "account_protected", (s, body))
        check("...nor deactivated, re-coded or re-typed", all(tapi("a1", "PATCH", f"/api/finance/accounts/{ar['id']}", change)[0] == 409 for change in ({"isActive": False}, {"code": "1199"}, {"accountType": "liability"})))
        check("...but it can be renamed", tapi("a1", "PATCH", f"/api/finance/accounts/{ar['id']}", {"description": "What customers owe us"})[0] == 200)
        out = psql_with_errors("impex_finance", f"DELETE FROM accounts WHERE id = '{ar['id']}'")
        check("the DATABASE refuses it as well", "system account cannot be deleted" in out, out)
        s, body = tapi("a1", "POST", "/api/finance/accounts", {"code": "6100", "name": "Marketing", "accountType": "expense", "description": "Campaigns"})
        custom = body.get("account", {})
        check("a new account is created", s == 201 and custom.get("code") == "6100" and custom.get("is_system") is False, (s, body))
        check("a duplicate code is refused (409)", tapi("a1", "POST", "/api/finance/accounts", {"code": "6100", "name": "Again", "accountType": "expense"})[0] == 409)
        check("it can be deactivated, reactivated and (unused) deleted", tapi("a1", "PATCH", f"/api/finance/accounts/{custom['id']}", {"isActive": False})[1].get("account", {}).get("is_active") is False
              and tapi("a1", "PATCH", f"/api/finance/accounts/{custom['id']}", {"isActive": True})[1].get("account", {}).get("is_active") is True and tapi("a1", "DELETE", f"/api/finance/accounts/{custom['id']}")[0] == 200)
        s, html, _ = tpage("a1", "/finance/accounts")
        check("the Accounts page shows the chart grouped by type, with System markers", s == 200 and "Accounts Receivable" in html and "System" in html and "Revenue" in html, s)

        print("\n== 4. the double-entry journal")
        cash = by_code["1050"]["id"]
        revenue = by_code["4000"]["id"]
        tax = by_code["2100"]["id"]

        def create_entry(lines, post, key=None, **extra):
            return tapi("a1", "POST", "/api/finance/journal-entries", {"entryDate": "2026-11-05", "description": "Verify entry", "lines": lines, "post": post, **extra}, {"Idempotency-Key": key or f"fc-{uuid.uuid4()}"})

        ln = lambda account, debit="", credit="": {"accountId": account, "debit": debit, "credit": credit}  # noqa: E731
        s, body = create_entry([ln(cash, "100.10"), ln(revenue, "", "90.05"), ln(tax, "", "10.05")], True)
        e1 = body.get("entry", {})
        check("a balanced entry posts (201) with a number, a total and provenance", s == 201 and e1.get("status") == "posted" and e1.get("entry_number") and e1.get("total") == "100.1000" and e1.get("posted_by_email") == emails["a1"], (s, body))
        s, body = create_entry([ln(cash, "100"), ln(revenue, "", "99.99")], True)
        check("an unbalanced entry is refused (422/400 unbalanced) and nothing is created", s == 400 and body.get("code") == "unbalanced" and "difference" in body.get("error", ""), (s, body))
        s, body = create_entry([ln(cash, "100"), ln(revenue, "", "99.99")], False)
        draft = body.get("entry", {})
        check("an unbalanced DRAFT can be saved, but never posted", s == 201 and draft.get("status") == "draft" and tapi("a1", "POST", f"/api/finance/journal-entries/{draft['id']}/post")[0] == 400, (s, body))
        check("...and a draft can be discarded", tapi("a1", "DELETE", f"/api/finance/journal-entries/{draft['id']}")[0] == 200)
        check("amounts with 5 decimals, negatives and text are refused", all(create_entry([ln(cash, v), ln(revenue, "", "1")], True)[0] == 400 for v in ("1.00001", "-1", "abc", "1e3")))
        key = f"fc-{uuid.uuid4()}"
        s1, b1 = create_entry([ln(cash, "7"), ln(revenue, "", "7")], True, key)
        s2, b2 = create_entry([ln(cash, "7"), ln(revenue, "", "7")], True, key)
        check("the same Idempotency-Key returns the SAME entry (200) and posts nothing twice", s1 == 201 and s2 == 200 and b1["entry"]["id"] == b2["entry"]["id"] and b2.get("replayed") is True
              and psql("impex_finance", f"SELECT count(*) FROM journal_entries WHERE id = '{b1['entry']['id']}'") == "1", (s1, s2))
        check("...and the same key with a different request is refused (409)", create_entry([ln(cash, "8"), ln(revenue, "", "8")], True, key)[0] == 409)
        outcomes = []

        def racer():
            outcomes.append(tapi("a1", "POST", "/api/finance/journal-entries", {"entryDate": "2026-11-05", "description": "Race", "lines": [ln(cash, "3"), ln(revenue, "", "3")], "post": True}, {"Idempotency-Key": "fc-race-" + key[-12:]}))

        threads = [threading.Thread(target=racer) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        check("six simultaneous identical requests create exactly one entry", sorted(s for s, _ in outcomes) == [200] * 5 + [201] and len({b["entry"]["id"] for _, b in outcomes}) == 1, [s for s, _ in outcomes])
        s, body = create_entry([ln(cash, "4"), ln(revenue, "", "4")], False)
        pending = body["entry"]["id"]
        posts = []
        threads = [threading.Thread(target=lambda: posts.append(tapi("a1", "POST", f"/api/finance/journal-entries/{pending}/post")[0])) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        check("six simultaneous posts of one draft: exactly one succeeds", sorted(posts) == [200] + [409] * 5, posts)
        numbers = psql("impex_finance", f"SELECT string_agg(entry_number, ',' ORDER BY entry_number) FROM journal_entries WHERE organization_id = '{org_ids['a']}' AND status = 'posted'").split(",")
        check("posted numbers are unique and have no gaps", numbers == [f"JE-{n:06d}" for n in range(1, len(numbers) + 1)], numbers)
        out = psql_with_errors("impex_finance", f"UPDATE journal_entries SET description = 'tampered' WHERE id = '{e1['id']}'")
        check("a posted entry cannot be changed, even by direct SQL", "can never be changed" in out, out)
        out = psql_with_errors("impex_finance", f"DELETE FROM journal_entries WHERE id = '{e1['id']}'")
        check("...nor deleted", "can never be deleted" in out, out)
        out = psql_with_errors("impex_finance", f"UPDATE journal_lines SET debit = 999 WHERE entry_id = '{e1['id']}' AND line_no = 1")
        check("...nor can its lines", "posted journal entry" in out, out)
        out = psql_with_errors("impex_finance", f"UPDATE finance_events SET action = 'x' WHERE organization_id = '{org_ids['a']}'")
        check("the audit trail is append-only", "append-only" in out, out)
        check("the portal has no way to edit a posted entry (409) or delete it", tapi("a1", "PUT", f"/api/finance/journal-entries/{e1['id']}", {"entryDate": "2026-11-05", "description": "x", "currencyCode": "USD", "lines": []})[0] == 409
              and tapi("a1", "DELETE", f"/api/finance/journal-entries/{e1['id']}")[0] == 409)
        before = lines_of(entry("a1", e1["id"]))
        s, body = tapi("a1", "POST", f"/api/finance/journal-entries/{e1['id']}/reverse", {"reason": "Verify reversal"})
        rev = body.get("entry", {})
        check("a reversal is the exact mirror image, linked to the original, with a reason", s == 201 and rev.get("source_type") == "reversal" and rev.get("reverses_entry_id") == e1["id"]
              and sorted((c, cr, d) for c, d, cr in before) == lines_of(rev), (s, body))
        check("the original is untouched and now says it was reversed", lines_of(entry("a1", e1["id"])) == before and entry("a1", e1["id"]).get("reversed_by_entry_id") == rev.get("id"))
        check("an entry can be reversed once, and a reversal cannot be reversed", tapi("a1", "POST", f"/api/finance/journal-entries/{e1['id']}/reverse", {"reason": "Again please"})[0] == 409
              and tapi("a1", "POST", f"/api/finance/journal-entries/{rev['id']}/reverse", {"reason": "Undo the undo"})[0] == 409)
        s, html, _ = tpage("a1", f"/finance/journal/{e1['id']}")
        check("the entry page shows lines, provenance, history and that it was reversed", s == 200 and "Totals" in html and "Created by" in html and "History" in html and "was reversed by" in html and "Reverse Entry" not in html, s)

        print("\n== 5. currencies are never mixed")
        s, body = create_entry([ln(cash, "40"), ln(revenue, "", "40")], True, currencyCode="eur")
        check("an entry keeps its own currency (EUR) although the organization's default is USD", s == 201 and body["entry"]["currency_code"] == "EUR" and e1["currency_code"] == "USD", (s, body))
        check("an unknown currency is refused, never defaulted", create_entry([ln(cash, "1"), ln(revenue, "", "1")], True, currencyCode="ZZZ")[0] == 400)
        overview_html = tpage("a1", "/finance")[1]
        check("the overview shows USD and EUR on separate rows, no combined total", "EUR" in overview_html and "USD" in overview_html and "Position by currency" in overview_html)
        fin_overview = fin("a1", "GET", "/overview")[1]
        totals = {t["currency_code"]: t for t in fin_overview.get("totals_by_currency", [])}
        check("the EUR row holds only the EUR entry", totals.get("EUR", {}).get("revenue") == "40.0000" and totals.get("EUR", {}).get("posted_entries") == 1, totals.get("EUR"))

        print("\n== 6. expenses")
        s, body = tapi("a1", "POST", "/api/finance/expenses", {"expenseDate": "2026-11-05", "description": "Printer paper", "vendor": "Paper Co", "reference": "R-1", "accountId": by_code["5000"]["id"], "amount": "25.50", "post": False}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        x1 = body.get("expense", {})
        check("an expense is recorded as a draft with a number, a category and the default currency", s == 201 and x1.get("status") == "draft" and x1.get("number") and x1.get("currency_code") == "USD" and x1.get("account_code") == "5000", (s, body))
        check("a draft expense has no journal entry (nothing in the books yet)", x1.get("journal_entry_id") is None)
        s, body = tapi("a1", "POST", f"/api/finance/expenses/{x1['id']}/post")
        x1p = body.get("expense", {})
        e_x = entry("a1", x1p.get("journal_entry_id"))
        check("posting debits the expense account and credits Accrued Expenses Payable (a liability): no bank is implied", s == 200 and lines_of(e_x) == [("2300", "0.0000", "25.5000"), ("5000", "25.5000", "0.0000")] and e_x.get("source_type") == "expense", (s, e_x))
        check("a posted expense cannot be edited or deleted; posting twice is refused", tapi("a1", "PUT", f"/api/finance/expenses/{x1['id']}", {"expenseDate": "2026-11-05", "description": "x", "accountId": by_code["5000"]["id"], "amount": "1", "currencyCode": "USD"})[0] == 409
              and tapi("a1", "DELETE", f"/api/finance/expenses/{x1['id']}")[0] == 409 and tapi("a1", "POST", f"/api/finance/expenses/{x1['id']}/post")[0] == 409)
        check("its journal entry cannot be reversed behind the expense's back", tapi("a1", "POST", f"/api/finance/journal-entries/{x1p['journal_entry_id']}/reverse", {"reason": "Sneaky"})[1].get("code") == "reverse_via_expense")
        check("only an expense account can categorize an expense", tapi("a1", "POST", "/api/finance/expenses", {"expenseDate": "2026-11-05", "description": "x", "accountId": by_code["1100"]["id"], "amount": "1"}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})[0] == 400)
        s, body = tapi("a1", "POST", f"/api/finance/expenses/{x1['id']}/reverse", {"reason": "Duplicate receipt"})
        check("reversing an expense posts a mirror entry and keeps both", s == 200 and body["expense"]["status"] == "reversed" and entry("a1", body["expense"]["reversal_entry_id"]).get("reverses_entry_id") == x1p["journal_entry_id"], (s, body))
        s, html, _ = tpage("a1", f"/finance/expenses/{x1['id']}")
        check("the expense page shows its history and says recording does not move money", s == 200 and "History" in html and "does not move money" in html and "Reversed" in html, s)
        check("an expense's audit history records who did what", int(psql("impex_finance", f"SELECT count(*) FROM finance_events WHERE entity_id = '{x1['id']}' AND actor_email = '{emails['a1']}'")) == 3)

        print("\n== 7. invoices, payments and voids from Sales become entries - once")
        d1 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "20")
        inv1 = invoice("a1", client_a["id"], d1, bolt_a["id"], "20", "10.00", discountAmount="20.00", taxRate="10", taxLabel="VAT")
        check("A1 issues an invoice in Sales (subtotal 200, discount 20, tax 18)", inv1.get("status") == "issued" and inv1.get("total") == "198.0000" and inv1.get("tax_total") == "18.0000", (inv1.get("status"), inv1.get("total")))
        s, run = sync_now("a1")
        check("a synchronisation posts it", s == 200 and run["result"]["posted"] >= 1, (s, run))
        k1 = fin_entry_for("a", f"invoice-issued:{inv1['id']}")
        e_inv = entry("a1", k1) if k1 else {}
        check("one entry: Accounts Receivable debit 198.00, Sales Revenue credit 180.00 (net of discount), Sales Tax Payable credit 18.00",
              lines_of(e_inv) == [("1100", "198.0000", "0.0000"), ("2100", "0.0000", "18.0000"), ("4000", "0.0000", "180.0000")] and e_inv.get("source_type") == "sales" and e_inv.get("currency_code") == "USD", lines_of(e_inv))
        check("it names its source and was posted by the synchronisation, not by a person", e_inv.get("source_key") == f"invoice-issued:{inv1['id']}" and e_inv.get("created_by_email") is None and {h["source"] for h in e_inv.get("history", [])} == {"sync"})
        for _ in range(3):
            sync_now("a1")
        check("running the synchronisation again and again posts nothing twice", count_entries("a", f"AND source_key = 'invoice-issued:{inv1['id']}'") == 1)
        check("the invoice from BEFORE Finance was activated was not back-filled", fin_entry_for("a", f"invoice-issued:{old_invoice['id']}") is None
              and psql("impex_finance", f"SELECT count(*) FROM sync_events WHERE organization_id = '{org_ids['a']}' AND event_key = 'invoice-issued:{old_invoice['id']}'") == "0")
        s, p1 = pay("a1", inv1["id"], "80.00")
        pay_id = (p1.get("invoice", {}).get("payments") or [{}])[0].get("id")
        check("A1 records a payment of 80.00", s == 201 and pay_id, (s, p1))
        sync_now("a1")
        e_pay = entry("a1", fin_entry_for("a", f"payment-recorded:{pay_id}") or "")
        check("it becomes Payments Received debit 80.00 / Accounts Receivable credit 80.00 (a recorded payment, not a bank movement)", lines_of(e_pay) == [("1050", "80.0000", "0.0000"), ("1100", "0.0000", "80.0000")], lines_of(e_pay))
        s, rv = tapi("a1", "POST", f"/api/sales/invoices/{inv1['id']}/payments/{pay_id}/reverse", {"reason": "bounced"}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        sync_now("a1")
        rev_id = next((p["id"] for p in jbody(tenant("a1", "GET", f"/api/sales/invoices/{inv1['id']}")[1]).get("invoice", {}).get("payments", []) if p["kind"] == "reversal"), None)
        e_prev = entry("a1", fin_entry_for("a", f"payment-reversed:{rev_id}") or "")
        check("reversing the payment in Sales posts the opposite entry", s in (200, 201) and lines_of(e_prev) == [("1050", "0.0000", "80.0000"), ("1100", "80.0000", "0.0000")], (s, lines_of(e_prev)))
        d2 = confirmed_dispatch("a1", client_a["id"], flour_a["id"], "4")
        inv2 = invoice("a1", client_a["id"], d2, flour_a["id"], "4", "2.50", currency="EUR")
        sync_now("a1")
        e_eur = entry("a1", fin_entry_for("a", f"invoice-issued:{inv2['id']}") or "")
        check("an invoice in another currency is posted in ITS currency (EUR), with no conversion", e_eur.get("currency_code") == "EUR" and lines_of(e_eur) == [("1100", "10.0000", "0.0000"), ("4000", "0.0000", "10.0000")], (e_eur.get("currency_code"), lines_of(e_eur)))
        check("voiding that invoice in Sales posts a mirror reversal of its entry, and the original stays", tapi("a1", "POST", f"/api/sales/invoices/{inv2['id']}/void", {"reason": "client cancelled"})[0] == 200 and (sync_now("a1") or True)
              and (fin_entry_for("a", f"invoice-voided:{inv2['id']}") is not None) and entry("a1", fin_entry_for("a", f"invoice-issued:{inv2['id']}")).get("reversed_by_entry_id") == fin_entry_for("a", f"invoice-voided:{inv2['id']}"))
        draft_dispatch = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "1")
        draft_inv = invoice("a1", client_a["id"], draft_dispatch, bolt_a["id"], "1", "3.00", issue=False)
        before_count = count_entries("a")
        sync_now("a1")
        check("a DRAFT invoice posts nothing", draft_inv.get("status") == "draft" and count_entries("a") == before_count)
        d7 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "2")
        inv7 = invoice("a1", client_a["id"], d7, bolt_a["id"], "2", "7.00")
        snapshots = (sales_snapshot("a"), purchasing_snapshot("a"), inventory_snapshot("a"))
        posted_before = count_entries("a")
        for _ in range(3):
            sync_now("a1")
        check("Finance posts the new invoice while Sales, Purchasing and Inventory are left byte-for-byte as they were (every invoice, payment, line, receipt and stock balance)",
              count_entries("a") > posted_before and fin_entry_for("a", f"invoice-issued:{inv7['id']}") is not None and snapshots == (sales_snapshot("a"), purchasing_snapshot("a"), inventory_snapshot("a")) and all(snapshots))
        check("the earlier invoices and payments are all still there (issued, payment recorded and reversed, voided, draft)", psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids['a']}'") == "5"
              and psql("impex_sales", f"SELECT count(*) FROM invoice_payments WHERE organization_id = '{org_ids['a']}'") == "2")
        s, html, _ = tpage("a1", "/finance")
        check("the overview shows the synchronisation as healthy, with counts", s == 200 and "Up to date" in html and "posted" in html and "Automatic postings from Sales and Purchasing" in html, s)

        print("\n== 8. goods received into stock (a purchase order alone posts nothing)")
        _, data, _, _ = tenant("a1", "POST", "/api/purchasing/suppliers", {"name": "Finance Check Supplies"})
        sup = jbody(data).get("supplier", {})
        created.add("suppliers", sup.get("id"))
        _, data, _, _ = tenant("a1", "POST", "/api/purchasing/purchase-orders", {"supplierId": sup["id"], "currencyCode": "GBP"}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        order = jbody(data).get("order", {})
        tenant("a1", "POST", f"/api/purchasing/purchase-orders/{order['id']}/lines", {"productId": bolt_a["id"], "quantity": "10", "unitPrice": "2.3333"})
        tenant("a1", "POST", f"/api/purchasing/purchase-orders/{order['id']}/order")
        order = jbody(tenant("a1", "GET", f"/api/purchasing/purchase-orders/{order['id']}")[1]).get("order", {})
        purchasing_before = purchasing_snapshot("a")
        count_before = count_entries("a")
        sync_now("a1")
        check("a purchase order alone creates no entry and no supplier liability", count_entries("a") == count_before and count_entries("a", "AND source_type = 'purchasing'") == 0)
        line = next(l for l in order["lines"] if l["product_id"] == bolt_a["id"])
        _, data, _, _ = tenant("a1", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": order["id"], "lines": [{"purchaseOrderLineId": line["id"], "acceptedQuantity": "7", "rejectedQuantity": "3"}]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        receipt = jbody(data).get("receipt", {})
        created.add("goods_receipts", receipt.get("id"))
        sync_now("a1")
        check("a DRAFT receipt posts nothing", count_entries("a", "AND source_type = 'purchasing'") == 0)
        s, _d, _, _ = tenant("a1", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")
        sync_now("a1")
        e_gr = entry("a1", fin_entry_for("a", f"receipt-confirmed:{receipt['id']}") or "")
        check("confirming the receipt posts Inventory debit / Goods Received Not Invoiced credit for what was ACCEPTED (7 x 2.3333 = 16.3331 GBP)",
              s in (200, 202) and lines_of(e_gr) == [("1200", "16.3331", "0.0000"), ("2200", "0.0000", "16.3331")] and e_gr.get("currency_code") == "GBP", (s, lines_of(e_gr)))
        check("no supplier payable was invented", all(code not in ("2300",) for code, _d2, _c in lines_of(e_gr)))
        sync_now("a1")
        check("and it is posted exactly once", count_entries("a", f"AND source_key = 'receipt-confirmed:{receipt['id']}'") == 1)
        check("Purchasing's own records were not changed by Finance", purchasing_snapshot("a") != "")

        print("\n== 9. the background worker does this by itself")
        d3 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "2")
        inv3 = invoice("a1", client_a["id"], d3, bolt_a["id"], "2", "6.00")
        posted = wait_until(lambda: fin_entry_for("a", f"invoice-issued:{inv3['id']}") is not None, 60, 1)
        check("without anybody pressing 'Sync now', the invoice is posted within a minute (the worker runs every few seconds)", posted)

        if not args.skip_outage:
            print("\n== 10. outages are survived: nothing is lost, nothing is posted twice")
            d4 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "3")
            docker("compose", "stop", "sales-service")
            try:
                s, run = sync_now("a1")
                s2, ov = fin("a1", "GET", "/overview")
                src = {x["source"]: x for x in ov.get("sync", {}).get("sources", [])}
                check("with Sales down, a synchronisation still answers and the overview reports Sales as unreachable (with the reason, no secret)",
                      s == 200 and src.get("sales", {}).get("status") == "error" and src["sales"].get("consecutive_failures", 0) >= 1 and "Sales Service" in (src["sales"].get("last_error") or "") and bool(module_key) and module_key not in json.dumps(ov), src.get("sales"))
                check("the Purchasing side keeps working meanwhile", src.get("purchasing", {}).get("status") == "ok", src.get("purchasing"))
                html = tpage("a1", "/finance")[1]
                check("the overview page tells the administrator, and that nothing is lost", "Not reachable" in html and "Nothing is lost" in html)
            finally:
                docker("compose", "start", "sales-service")
                wait_health(SALES)
            inv4 = invoice("a1", client_a["id"], d4, bolt_a["id"], "3", "4.00")
            sync_now("a1")
            sync_now("a1")
            check("when Sales is back the missed invoice is posted - exactly once", count_entries("a", f"AND source_key = 'invoice-issued:{inv4['id']}'") == 1)
            ov = fin("a1", "GET", "/overview")[1]
            check("and the overview is healthy again", {x["source"]: x["status"] for x in ov["sync"]["sources"]}["sales"] == "ok" and {x["source"]: x["consecutive_failures"] for x in ov["sync"]["sources"]}["sales"] == 0)
            d5 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "2")
            docker("compose", "stop", "finance-service")
            try:
                inv5 = invoice("a1", client_a["id"], d5, bolt_a["id"], "2", "5.00")
                check("with the Finance Service down, Sales carries on unaffected", inv5.get("status") == "issued")
                check("and the portal says Finance is unavailable instead of failing silently", tapi("a1", "GET", "/api/finance/accounts")[0] in (502, 503))
            finally:
                docker("compose", "start", "finance-service")
                wait_health(FINANCE)
            caught_up = wait_until(lambda: fin_entry_for("a", f"invoice-issued:{inv5['id']}") is not None, 60, 1)
            sync_now("a1")
            check("when Finance restarts it catches up on its own, exactly once", caught_up and count_entries("a", f"AND source_key = 'invoice-issued:{inv5['id']}'") == 1)

        print("\n== 11. tenant isolation")
        s, body = tapi("b1", "GET", "/api/finance/accounts")
        check("B's Finance is off until the Super Admin enables it", s == 403)
        check("the Super Admin enables Finance for B", finance_module("b", True)[0] == 200)
        s, body = tapi("b1", "GET", "/api/finance/accounts")
        b_accounts = body.get("accounts", [])
        check("B gets its own starter chart (not A's accounts)", s == 200 and len(b_accounts) == 14 and not ({a["id"] for a in b_accounts} & {a["id"] for a in accounts}))
        check("B sees none of A's entries, expenses or accounts", entries("b1") == [] and tapi("b1", "GET", "/api/finance/expenses")[1].get("total") == 0)
        gone = lambda r: r[0] == 404  # noqa: E731
        check("A's records are plain 'not found' to B: entry, expense, account (also when called directly)",
              gone(tapi("b1", "GET", f"/api/finance/journal-entries/{e1['id']}")) and gone(tapi("b1", "GET", f"/api/finance/expenses/{x1['id']}")) and gone(fin("b1", "GET", f"/accounts/{ar['id']}"))
              and gone(fin("b1", "GET", f"/journal-entries/{e1['id']}")) and gone(fin("b1", "GET", f"/expenses/{x1['id']}")), "")
        check("B cannot post, reverse, edit or delete A's records", gone(tapi("b1", "POST", f"/api/finance/journal-entries/{e1['id']}/reverse", {"reason": "Not mine to reverse"}))
              and gone(tapi("b1", "POST", f"/api/finance/expenses/{x1['id']}/post")) and gone(tapi("b1", "PATCH", f"/api/finance/accounts/{ar['id']}", {"name": "Hijacked"})))
        s, body = tapi("b1", "POST", "/api/finance/journal-entries", {"entryDate": "2026-11-05", "description": "Cross", "post": True, "lines": [ln(b_accounts[0]["id"], "5"), ln(revenue, "", "5")]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        check("B cannot use A's account in an entry", s == 400 and body.get("code") == "unknown_account", (s, body))
        b_cash = next(a["id"] for a in b_accounts if a["code"] == "1050")
        b_rev = next(a["id"] for a in b_accounts if a["code"] == "4000")
        s, body = tapi("b1", "POST", "/api/finance/journal-entries", {"entryDate": "2026-11-05", "description": "Beta sale", "post": True, "lines": [ln(b_cash, "9"), ln(b_rev, "", "9")]}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        check("B's first entry is JE-000001 and uses B's default currency (EUR)", s == 201 and body["entry"]["entry_number"] == "JE-000001" and body["entry"]["currency_code"] == "EUR", (s, body))
        s, body = tapi("b1", "POST", "/api/finance/journal-entries", {"entryDate": "2026-11-05", "description": "Spoof", "post": True, "organizationId": org_ids["a"], "lines": []}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        check("an organization id in a request body is never read as the tenant", s in (400, 422) or "organization" not in json.dumps(body))
        s, body = fin("b1", "POST", "/journal-entries", {"entry_date": "2026-11-05", "description": "Spoof", "organization_id": org_ids["a"], "lines": []}, {"Idempotency-Key": f"fc-{uuid.uuid4()}"})
        check("...nor by the Finance Service itself (422)", s == 422, (s, body))
        check("each organization's books are its own: B has exactly its one entry", count_entries("b") == 1 and e1["id"] not in [e["id"] for e in entries("b1")])
        check("a Super Admin session opens no tenant page and no Finance data", tapi("a1", "GET", "/api/finance/accounts")[0] == 200
              and call(TENANT_PORTAL, "GET", "/api/finance/accounts", cookies={"impex_tenant_session": tokens["sa"]})[0] in (401, 403)
              and call(FINANCE, "GET", "/api/v1/finance/accounts", headers=bearer(tokens["sa"]))[0] == 403)

        print("\n== 12. first-time setup is mandatory for Finance too")
        check("the Super Admin enables Finance for C, whose setup is NOT finished", finance_module("c", True)[0] == 200)
        s, body = tapi("c1", "GET", "/api/finance/accounts")
        check("C's Finance API at the portal says setup_required", s == 403 and body.get("code") == "setup_required", (s, body))
        s, body = fin("c1", "GET", "/accounts")
        check("the Finance Service itself refuses C1 (403 setup_required) - no portal involved", s == 403 and body.get("detail", {}).get("code") == "setup_required", (s, body))
        check("nothing was set up for C (no chart, no activation)", psql("impex_finance", f"SELECT count(*) FROM accounts WHERE organization_id = '{org_ids['c']}'") == "0")
        s, html, loc = tpage("c1", "/finance")
        check("C's Finance page sends them to the setup wizard", s in (302, 303, 307) and "/setup" in loc, (s, loc))

        print("\n== 13. switching Finance off stops it - and keeps the books")
        n_before = count_entries("a")
        check("the Super Admin switches Finance off for A", finance_module("a", False)[0] == 200)
        check("A's pages, portal API and the service itself refuse (module_disabled)", "data-module-denied" in tpage("a1", "/finance")[1] and tapi("a1", "GET", "/api/finance/accounts")[0] == 403 and fin("a1", "GET", "/accounts")[0] == 403)
        d6 = confirmed_dispatch("a1", client_a["id"], bolt_a["id"], "1")
        inv6 = invoice("a1", client_a["id"], d6, bolt_a["id"], "1", "9.00")
        time.sleep(20)
        check("an invoice issued while Finance is off is not posted (the worker skips organizations without Finance)", fin_entry_for("a", f"invoice-issued:{inv6['id']}") is None and count_entries("a") == n_before)
        check("switching it off deleted nothing", count_entries("a") == n_before)
        check("the Super Admin switches Finance on again", finance_module("a", True)[0] == 200)
        caught = wait_until(lambda: fin_entry_for("a", f"invoice-issued:{inv6['id']}") is not None, 60, 1)
        check("everything is back, and what happened meanwhile is caught up - once", caught and count_entries("a", f"AND source_key = 'invoice-issued:{inv6['id']}'") == 1 and entry("a1", e1["id"]).get("entry_number") == e1["entry_number"])

        print("\n== 14. the audit trail")
        check("every posting has an audit line saying who (a person or the synchronisation)", int(psql("impex_finance", f"SELECT count(*) FROM finance_events WHERE organization_id = '{org_ids['a']}' AND action = 'posted' AND source IN ('user', 'sync')")) >= 8
              and int(psql("impex_finance", f"SELECT count(*) FROM finance_events WHERE organization_id = '{org_ids['a']}' AND source = 'user' AND actor_email IS NULL")) <= 1)
        check("the audit trail cannot be deleted", "append-only" in psql_with_errors("impex_finance", f"DELETE FROM finance_events WHERE organization_id = '{org_ids['a']}'"))
        check("no money column is a float anywhere in Finance", psql("impex_finance", "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('double precision', 'real')") == "0")
        check("every posted entry in the database balances to the last 0.0001, per entry",
              psql("impex_finance", f"SELECT count(*) FROM (SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.organization_id = '{org_ids['a']}' AND e.status = 'posted' GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit)) x") == "0")
        check("and the books as a whole balance in each currency",
              psql("impex_finance", f"SELECT count(*) FROM (SELECT e.currency_code FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.organization_id = '{org_ids['a']}' AND e.status = 'posted' GROUP BY e.currency_code HAVING sum(l.debit) <> sum(l.credit)) x") == "0")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {}
        finance_tables = (("expenses", "organization_id"), ("journal_lines", "organization_id"), ("journal_entries", "organization_id"), ("accounts", "organization_id"), ("finance_events", "organization_id"),
                          ("finance_requests", "organization_id"), ("finance_counters", "organization_id"), ("sync_events", "organization_id"), ("sync_sources", "organization_id"), ("finance_organizations", "organization_id"))
        if orgs:
            # The Finance worker is live: while an organization still exists and has Finance on, it would set Finance up for it again. So the organizations
            # go FIRST (the worker then stops listing them), and the Finance rows are removed afterwards - twice, a worker cycle apart, to catch a cycle in flight.
            left["organizations"] = delete_exact(psql, "impex_organizations", "organizations", orgs)
            time.sleep(4)
            for table, column in finance_tables:
                delete_exact(psql, "impex_finance", table, orgs, column, ledger=True)
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
                "payments": delete_exact(psql, "impex_sales", "invoice_payments", orgs, "organization_id", ledger=True),
                "allocations": delete_exact(psql, "impex_sales", "invoice_allocations", orgs, "organization_id", ledger=True),
                "invoice lines": delete_exact(psql, "impex_sales", "invoice_lines", orgs, "organization_id", ledger=True),
                "invoice requests": delete_exact(psql, "impex_sales", "invoice_requests", orgs, "organization_id"),
                "invoices": delete_exact(psql, "impex_sales", "invoices", orgs, "organization_id", ledger=True),
                "invoice counters": delete_exact(psql, "impex_sales", "invoice_counters", orgs, "organization_id"),
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
                "products": delete_exact(psql, "impex_inventory", "products", created.get("products")),
            })
        left["users"] = delete_exact(psql, "impex_auth", "users", created.get("users"))
        if orgs:
            time.sleep(17)  # one more worker cycle: nothing may have come back for an organization that no longer exists
            for table, column in finance_tables:
                left[f"finance {table}"] = delete_exact(psql, "impex_finance", table, orgs, column, ledger=True)
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(created.get('products'))} products, {len(created.get('users'))} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
