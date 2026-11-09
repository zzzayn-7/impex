#!/usr/bin/env python3
"""End-to-end check of Client Dispatch against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_sales and impex_inventory migrated to head
    python scripts/verify_dispatch.py
    python scripts/verify_dispatch.py --with-outage    # also stops the Inventory and Sales services briefly

It creates two throwaway organizations ("Dispatch Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: prepares Ready delivery lists
for clients, prepares dispatches (drafts change nothing), confirms partial dispatches, and checks -
against the Inventory database itself - that the stock, the movement history and the prices are exactly what they should be.

The central checks: creating a list, preparing, saving and scanning NEVER deduct stock; a confirmed dispatch deducts exactly its
lines once (repeated and simultaneous confirmations never deduct twice), stock can never go negative, nothing can be over-dispatched
(the 15 laptops example: 10, then 5), the database itself refuses to change a confirmed dispatch or to reopen / cancel a list with
goods dispatched, a dispatch interrupted between the two services (intent saved, Inventory committed but unrecorded, Inventory down)
is finished by a retry without deducting twice, and the other organization sees and changes nothing. Everything it created is
deleted afterwards, by exact id. No emails are sent and no existing record is touched.
"""
import argparse
import http.client
import json
import os
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
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, INVENTORY, SALES, SUPER_PORTAL, TENANT_PORTAL = 8000, 8001, 8002, 8003, 3000, 3001
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


def call(port, method, path, body=None, headers=None, cookies=None):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    conn.request(method, path, json.dumps(body) if body is not None else None, hdrs)
    res = conn.getresponse()
    text = res.read().decode(errors="replace")
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    location = res.getheader("location") or ""
    conn.close()
    return res.status, text, set_cookies, location


def jbody(text):
    try:
        return json.loads(text)
    except ValueError:
        return {}


def cookie_value(set_cookies, name):
    for c in set_cookies:
        if c.startswith(name + "="):
            return c.split(";", 1)[0].split("=", 1)[1]
    return None


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def wait_until(port, path, timeout=90):
    for _ in range(timeout * 2):
        try:
            if call(port, "GET", path)[0] == 200:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory and Sales services briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "dpcheck-sa@example.org"
    emails = {"a": "dpcheck-admin-a@example.org", "b": "dpcheck-admin-b@example.org"}
    org_names = {"a": "Dispatch Check Alpha", "b": "Dispatch Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, html, _, location = portal(key, "GET", path)
        return status, html.replace("<!-- -->", ""), location

    def product(key, sku, name, unit="pcs"):
        _, text, _, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def stock_in(key, pid, quantity):
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"dp-{uuid.uuid4()}"})[0]

    def new_client(key, name):
        _, text, _, _ = portal(key, "POST", "/api/sales/clients", {"name": name})
        body = jbody(text).get("client", {})
        created.add("clients", body.get("id"))
        return body

    def ready_list(key, client_id, items):
        _, text, _, _ = portal(key, "POST", "/api/sales/delivery-lists", {"clientId": client_id})
        made = jbody(text).get("list", {})
        for product_id, quantity in items:
            portal(key, "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": product_id, "quantity": quantity})
        portal(key, "POST", f"/api/sales/delivery-lists/{made['id']}/ready")
        return list_detail(key, made["id"])

    def list_detail(key, list_id):
        return jbody(portal(key, "GET", f"/api/sales/delivery-lists/{list_id}")[1]).get("list", {})

    def item_of(delivery_list, product_id):
        return next(i for i in delivery_list["items"] if i["product_id"] == product_id)

    def dl(delivery_list, product_id, quantity):
        return {"deliveryListItemId": item_of(delivery_list, product_id)["id"], "quantity": quantity}

    def draft(key, list_id, lines, idem=None, **extra):
        status, text, _, _ = portal(key, "POST", "/api/sales/dispatches", {"deliveryListId": list_id, "lines": lines, **extra}, {"Idempotency-Key": idem or f"dp-{uuid.uuid4()}"})
        body = jbody(text)
        created.add("dispatches", (body.get("dispatch") or {}).get("id"))
        return status, body

    def confirm(key, dispatch_id):
        status, text, _, _ = portal(key, "POST", f"/api/sales/dispatches/{dispatch_id}/confirm")
        return status, jbody(text)

    def dispatch_detail(key, dispatch_id):
        status, text, _, _ = portal(key, "GET", f"/api/sales/dispatches/{dispatch_id}")
        return status, jbody(text).get("dispatch", {})

    def inventory_state(org):
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(max(created_at)::text, '') FROM stock_movements WHERE organization_id = '{org}'")
        operations = psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE organization_id = '{org}'")
        prices = psql("impex_inventory", f"SELECT coalesce(string_agg(sku || ':' || cost_price::text || ':' || selling_price::text || ':' || unit || ':' || is_active::text, ',' ORDER BY sku), '') FROM products WHERE organization_id = '{org}'")
        return balances, movements, operations, prices

    def quantity(product_id):
        value = psql("impex_inventory", f"SELECT coalesce((SELECT quantity FROM stock_balances WHERE product_id = '{product_id}'), 0)")
        return Decimal(value or "0")

    def dispatch_movements(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}' AND source_type = 'client_dispatch'") or "0")

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='DPcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"dpcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
            org_ids[key] = jbody(text).get("id")
            created.add("organizations", org_ids[key])
            check(f"organization {key.upper()} created", status == 201 and org_ids[key], (status, text))
            status, text, _, _ = call(AUTH, "POST", "/internal/organization-admins", {
                "organization_id": org_ids[key], "full_name": f"Admin {key.upper()}", "email": emails[key], "password": password}, {"X-Internal-Key": internal_key})
            created.add("users", jbody(text).get("id"))
            check(f"administrator {key.upper()} created", status == 201, (status, text))
            status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[key], "password": password})
            tokens[key] = jbody(text).get("access_token")
            status, text, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[key], "password": password})
            cookies[key] = cookie_value(sc, "impex_tenant_session")
            check(f"administrator {key.upper()} signs in to the Organization Portal", status == 200 and cookies[key], (status, text))
            mark_setup_complete(psql, org_ids[key])  # this script tests other features: skip the first-time wizard for its throwaway organization (verify_onboarding.py tests the wizard)

        a_laptop, a_flour, a_old = product("a", "DP-LAPTOP", "DPA laptop", "pcs"), product("a", "DP-FLOUR", "DPA flour", "kg"), product("a", "DP-OLD", "DPA old widget", "pcs")
        b_laptop = product("b", "DP-LAPTOP", "DPB silk scarf", "pcs")
        check("products created (the same SKU 'DP-LAPTOP' in both organizations)", all(x.get("id") for x in (a_laptop, a_flour, a_old, b_laptop)))
        stock_in("a", a_laptop["id"], "40")
        stock_in("a", a_laptop["id"], "12")
        stock_in("a", a_flour["id"], "30.5")
        stock_in("b", b_laptop["id"], "99")
        acme, beta_client = new_client("a", "DP Acme Ltd"), new_client("b", "DP Beta Client")
        dl1 = ready_list("a", acme["id"], [(a_laptop["id"], "15"), (a_flour["id"], "2")])
        b_dl = ready_list("b", beta_client["id"], [(b_laptop["id"], "20")])
        check("A's delivery list DL-000001 is Ready (15 laptops + 2 kg flour); B has one too",
              dl1.get("status") == "ready" and dl1.get("number") == "DL-000001" and dl1.get("can_dispatch") is True and b_dl.get("status") == "ready", (dl1.get("status"), b_dl.get("status")))
        check("a Ready list shows dispatched 0 / remaining = requested on every item", all(i["dispatched_quantity"] == "0.0000" and i["remaining_quantity"] == i["quantity"] for i in dl1["items"]), dl1["items"])
        inventory_before = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("starting stock recorded (A: 52 laptops, 30.5 kg flour; B: 99; selling price 9.99, cost price 5)",
              len(inventory_before["a"][0].split(",")) == 2 and "9.9900" in inventory_before["a"][3] and "5.0000" in inventory_before["a"][3], inventory_before["a"])

        print("\n== 1. preparing a dispatch changes NOTHING in inventory")
        s, body = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "10"), dl(dl1, a_flour["id"], "1.5")], idem="dp-live-key-0001",
                        trackingReference="TRK-4411", deliveryAddress="1 Dock Rd", transportDetails="Truck 4", notes="Gate 5")
        d1 = body.get("dispatch", {})
        check("A starts a draft dispatch (201): DS-000001, draft, against DL-000001, with address / transport / tracking and its lines",
              s == 201 and d1.get("number") == "DS-000001" and d1.get("status") == "draft" and d1.get("delivery_list", {}).get("number") == "DL-000001" and len(d1.get("lines", [])) == 2
              and (d1.get("tracking_reference"), d1.get("delivery_address"), d1.get("transport_details")) == ("TRK-4411", "1 Dock Rd", "Truck 4"), (s, body))
        check("...no organization and no warehouse in the answer, and the live stock of each product is shown", "organization_id" not in json.dumps(body) and "warehouse" not in json.dumps(body).lower() and next(l for l in d1["lines"] if l["product_sku"] == "DP-LAPTOP")["available_quantity"] in ("52.0000", "52"), body)
        s2, again = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "10"), dl(dl1, a_flour["id"], "1.5")], idem="dp-live-key-0001",
                          trackingReference="TRK-4411", deliveryAddress="1 Dock Rd", transportDetails="Truck 4", notes="Gate 5")
        check("a double click / retry with the same key answers 200 with the SAME draft", s2 == 200 and again["dispatch"]["id"] == d1["id"] and again.get("replayed") is True, (s2, again))
        s3, _ = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "11")], idem="dp-live-key-0001")
        check("the same key for a different dispatch is refused (409)", s3 == 409, s3)
        outcomes = []

        def create_dup(_):
            outcomes.append(draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "1")], idem="dp-double-click-01"))

        threads = [threading.Thread(target=create_dup, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        ids = {b["dispatch"]["id"] for s, b in outcomes if s in (200, 201)}
        check("6 simultaneous submissions of one form create ONE draft (one 201, five 200)", sorted(s for s, _ in outcomes) == [200] * 5 + [201] and len(ids) == 1, [s for s, _ in outcomes])
        dup_id = next(iter(ids))
        check("that extra draft is discarded (kept as cancelled)", portal("a", "POST", f"/api/sales/dispatches/{dup_id}/cancel")[0] == 200)
        s, text, _, _ = portal("a", "PUT", f"/api/sales/dispatches/{d1['id']}/lines", {"lines": [dl(dl1, a_laptop["id"], "10"), dl(dl1, a_flour["id"], "1.5")]})
        check("saving the lines again (200) and editing the header (200)", s == 200 and portal("a", "PATCH", f"/api/sales/dispatches/{d1['id']}", {"notes": "Gate 5 (counted twice)"})[0] == 200)
        status, html, _ = page("a", f"/delivery-lists/{dl1['id']}/dispatch?dispatch={d1['id']}")
        check("the Prepare dispatch page opens the draft for editing", status == 200 and "Prepare dispatch" in html and "Editing the draft DS-000001" in html and "Review dispatch" in html, status)
        s, text, _, _ = portal("a", "GET", "/api/scan/resolve?code=dp-laptop")
        check("a product is found by SKU / barcode / camera text (the locate step - a lookup only)", s == 200 and jbody(text)["product"]["id"] == a_laptop["id"], (s, text[:100]))
        status, html, _ = page("a", "/scan")
        check("the Scan Product page loads", status == 200 and "Scan Product" in html, status)
        check("after creating the list, drafting, saving, editing and scanning: stock, history, operations and prices are untouched",
              {k: inventory_state(org_ids[k]) for k in ("a", "b")} == inventory_before)
        check("...and the list is still plain Ready with nothing dispatched", list_detail("a", dl1["id"])["status"] == "ready" and all(i["dispatched_quantity"] == "0.0000" for i in list_detail("a", dl1["id"])["items"]))

        print("\n== 2. what cannot be dispatched")
        for label, lines, expect in (
            ("more than requested (16 of 15)", [dl(dl1, a_laptop["id"], "16")], 409),
            ("the same item twice on one dispatch", [dl(dl1, a_laptop["id"], "8"), dl(dl1, a_laptop["id"], "7")], 422),
            ("a fraction of a piece", [dl(dl1, a_laptop["id"], "1.5")], 422),
            ("a negative quantity", [dl(dl1, a_laptop["id"], "-1")], 400),
            ("a zero quantity", [dl(dl1, a_laptop["id"], "0")], 400),
            ("a text quantity", [dl(dl1, a_laptop["id"], "lots")], 400),
            ("an item of another organization's list", [{"deliveryListItemId": b_dl["items"][0]["id"], "quantity": "1"}], 404),
            ("an item that does not exist", [{"deliveryListItemId": str(uuid.uuid4()), "quantity": "1"}], 404),
        ):
            s, body = draft("a", dl1["id"], lines)
            check(f"{label} is refused ({expect})", s == expect or (expect == 422 and s == 400), (s, body))
        s, text, _, _ = call(SALES, "POST", "/api/v1/sales/dispatches", {"delivery_list_id": dl1["id"], "lines": [{"delivery_list_item_id": item_of(dl1, a_laptop["id"])["id"], "warehouse_id": str(uuid.uuid4()), "quantity": "1"}]},
                             {**bearer(tokens["a"]), "Idempotency-Key": f"dp-wh-{uuid.uuid4()}"})
        check("the Sales Service refuses a dispatch line that names a warehouse (422): there is nothing to name", s == 422, (s, text[:100]))
        s, body = draft("a", dl1["id"], [{**dl(dl1, a_laptop["id"], "1"), "warehouseId": str(uuid.uuid4()), "unit": "box", "productName": "Hacked", "status": "confirmed"}])
        check("unit / name / status / a warehouse sent by the browser are ignored (the draft takes them from the list)", s == 201 and body["dispatch"]["lines"][0]["unit"] == "pcs" and body["dispatch"]["lines"][0]["product_name"] == "DPA laptop" and body["dispatch"]["status"] == "draft", (s, body))
        junk = body["dispatch"]["id"]
        portal("a", "POST", f"/api/sales/dispatches/{junk}/cancel")
        draft_list = jbody(portal("a", "POST", "/api/sales/delivery-lists", {"clientId": acme["id"]})[1])["list"]
        s, body = draft("a", draft_list["id"], [])
        check("a dispatch against a DRAFT delivery list is refused (409)", s == 409 and "still a draft" in body.get("error", ""), (s, body))
        s, body = draft("a", str(uuid.uuid4()), [])
        check("...and against a list that does not exist (404)", s == 404, (s, body))
        s, body = draft("a", dl1["id"], [])
        empty = body.get("dispatch", {})
        s, body = confirm("a", empty.get("id", ""))
        check("a dispatch without lines cannot be confirmed (422): there is nothing to deduct", s == 400 and "no lines" in body.get("error", ""), (s, body))
        portal("a", "POST", f"/api/sales/dispatches/{empty['id']}/cancel")

        print("\n== 3. the 15 laptops: 10 first, 5 later")
        s, body = confirm("a", d1["id"])
        confirmed1 = body.get("dispatch", {})
        check("A confirms DS-000001 (200, confirmed, with who and when)", s == 200 and body.get("confirmed") is True and confirmed1.get("status") == "confirmed" and confirmed1.get("confirmed_by_email") == emails["a"] and confirmed1.get("confirmed_at"), (s, body))
        check("laptops: 52 - 10 = 42", quantity(a_laptop["id"]) == Decimal("42"))
        check("flour: 30.5 - 1.5 = 29 kg", quantity(a_flour["id"]) == Decimal("29"))
        check("exactly two stock movements were written, each linked to DS-000001",
              dispatch_movements(a_laptop["id"]) == 1 and dispatch_movements(a_flour["id"]) == 1 and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_reference = 'DS-000001' AND organization_id = '{org_ids['a']}'") == "2")
        check("each movement says who, what, where, why: type 'out', reason 'Client dispatch DS-000001 (DL-000001)', actor = the administrator",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_reference = 'DS-000001' AND organization_id = '{org_ids['a']}' AND movement_type = 'out' AND source_type = 'client_dispatch' AND reason = 'Client dispatch DS-000001 (DL-000001)' AND created_by_email = '{emails['a']}'") == "2")
        check("every line on the dispatch carries its inventory movement id, which is a real ledger row",
              all(l["inventory_movement_id"] for l in confirmed1["lines"]) and confirmed1.get("inventory_operation_id") and
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE id IN ({', '.join(repr(l['inventory_movement_id']) for l in confirmed1['lines'])})") == "2")
        s, again_body = confirm("a", d1["id"])
        check("confirming again (a double click / retry) answers 200 and changes nothing", s == 200 and again_body["dispatch"]["confirmed_at"] == confirmed1["confirmed_at"] and quantity(a_laptop["id"]) == Decimal("42"))
        dl1 = list_detail("a", dl1["id"])
        laptops, flour = item_of(dl1, a_laptop["id"]), item_of(dl1, a_flour["id"])
        check("the list is now PARTIALLY DISPATCHED: laptops 10 of 15 (5 left), flour 1.5 of 2 (0.5 left)",
              dl1["status"] == "partially_dispatched" and (laptops["dispatched_quantity"], laptops["remaining_quantity"]) == ("10.0000", "5.0000") and (flour["dispatched_quantity"], flour["remaining_quantity"]) == ("1.5000", "0.5000"), (dl1["status"], laptops, flour))
        check("...it can still dispatch more and shows the dispatch in its history", dl1["can_dispatch"] is True and [d["number"] for d in dl1["dispatches"] if d["status"] == "confirmed"] == ["DS-000001"])
        reopen = portal("a", "POST", f"/api/sales/delivery-lists/{dl1['id']}/reopen")
        check("a list with goods dispatched can no longer be reopened (409)", reopen[0] == 409, reopen[0])
        check("...nor cancelled (409)", portal("a", "POST", f"/api/sales/delivery-lists/{dl1['id']}/cancel")[0] == 409)
        check("...and its items are frozen (409)", portal("a", "PATCH", f"/api/sales/delivery-lists/{dl1['id']}/items/{laptops['id']}", {"quantity": "99"})[0] == 409 and
              portal("a", "POST", f"/api/sales/delivery-lists/{dl1['id']}/items", {"productId": a_old["id"], "quantity": "1"})[0] == 409)
        check("a confirmed dispatch cannot be edited (409) or cancelled (409)",
              portal("a", "PUT", f"/api/sales/dispatches/{d1['id']}/lines", {"lines": []})[0] == 409 and portal("a", "POST", f"/api/sales/dispatches/{d1['id']}/cancel")[0] == 409)
        s, body = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "6")])
        check("dispatching 6 when only 5 remain is refused (409)", s == 409 and "at most 5" in body.get("error", ""), (s, body))

        print("\n== 4. the remaining 5 and the flour: the list is completed")
        s, body = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "5"), dl(dl1, a_flour["id"], "0.5")])
        d2 = body.get("dispatch", {})
        check("A drafts the rest: 5 laptops + 0.5 kg flour", s == 201 and len(d2.get("lines", [])) == 2, (s, body))
        outcomes = []

        def confirm_many(_):
            outcomes.append(confirm("a", d2["id"]))

        threads = [threading.Thread(target=confirm_many, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        check("6 simultaneous confirmations of ONE dispatch all end well (200, or 202 'retry' - never an error)", all(s in (200, 202) for s, _ in outcomes) and any(s == 200 for s, _ in outcomes), [s for s, _ in outcomes])
        s, final2 = dispatch_detail("a", d2["id"])
        if final2.get("status") != "confirmed":
            confirm("a", d2["id"])
            s, final2 = dispatch_detail("a", d2["id"])
        check("...and it is confirmed exactly once", final2.get("status") == "confirmed")
        check("laptops: 42 - 5 = 37; flour 29 - 0.5 = 28.5 (deducted ONCE despite 6 simultaneous confirmations)",
              quantity(a_laptop["id"]) == Decimal("37") and quantity(a_flour["id"]) == Decimal("28.5"),
              (quantity(a_laptop["id"]), quantity(a_flour["id"])))
        check("...with exactly 4 client-dispatch movements in all (2 + 2)", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_type = 'client_dispatch' AND organization_id = '{org_ids['a']}'") == "4")
        check("...and one posting operation per dispatch (the same key was used for every attempt)",
              psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE kind = 'dispatch' AND organization_id = '{org_ids['a']}'") == "2" and
              psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE idempotency_key IN ('dispatch-{d1['id']}', 'dispatch-{d2['id']}') AND organization_id = '{org_ids['a']}'") == "2")
        dl1 = list_detail("a", dl1["id"])
        check("the list is now DISPATCHED, frozen, with nothing remaining", dl1["status"] == "dispatched" and dl1["can_dispatch"] is False and all(i["remaining_quantity"] == "0.0000" for i in dl1["items"]), dl1["status"])
        s, body = draft("a", dl1["id"], [dl(dl1, a_laptop["id"], "1")])
        check("a Dispatched list takes no further dispatches (409)", s == 409 and "fully dispatched" in body.get("error", ""), (s, body))
        check("...and cannot be reopened or cancelled (409)", portal("a", "POST", f"/api/sales/delivery-lists/{dl1['id']}/reopen")[0] == 409 and portal("a", "POST", f"/api/sales/delivery-lists/{dl1['id']}/cancel")[0] == 409)
        status, html, _ = page("a", f"/delivery-lists/{dl1['id']}")
        check("the list page shows the status, the progress bars and the dispatch history", status == 200 and "Dispatched" in html and "Dispatch progress" in html and "15 of 15 pcs dispatched" in html and "Dispatches (" in html and "DS-000001" in html and 'role="progressbar"' in html, status)

        print("\n== 5. stock can never go negative; nothing is deducted by a refused dispatch")
        # An OLDER Ready list (made before reservations existed, set up directly): a booked list can never exceed stock, an unbooked one still can.
        made = jbody(portal("a", "POST", "/api/sales/delivery-lists", {"clientId": acme["id"]})[1]).get("list", {})
        portal("a", "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": a_laptop["id"], "quantity": "100"})
        psql("impex_sales", f"UPDATE delivery_lists SET status = 'ready' WHERE id = '{made['id']}'")
        dl2 = list_detail("a", made["id"])
        before = quantity(a_laptop["id"])  # 37
        s, body = draft("a", dl2["id"], [dl(dl2, a_laptop["id"], "50")])
        d3 = body.get("dispatch", {})
        check("a draft may ask for more than is in stock (saving is fine: stock may arrive first) and says so", s == 201 and d3.get("lines_exceeding_stock") == 1, (s, body))
        s, body = confirm("a", d3["id"])
        check("confirming it is refused (409 insufficient_stock): nothing is deducted", s == 409 and body.get("code") == "insufficient_stock" and quantity(a_laptop["id"]) == before, (s, body))
        s, detail3 = dispatch_detail("a", d3["id"])
        check("...the dispatch stays an editable draft, and nothing is reserved", detail3.get("status") == "draft" and detail3.get("editable") is True and item_of(list_detail("a", dl2["id"]), a_laptop["id"])["pending_quantity"] == "0.0000")
        status, html, _ = page("a", f"/dispatches/{d3['id']}")
        check("its page warns that a line asks for more than is in stock", status == 200 and "cannot be confirmed yet" in html, status)
        portal("a", "PUT", f"/api/sales/dispatches/{d3['id']}/lines", {"lines": [dl(dl2, a_laptop["id"], str(before))]})
        s, body = confirm("a", d3["id"])
        check("edited down to exactly what is in stock, it is confirmed (200) and the stock is empty - not below zero", s == 200 and quantity(a_laptop["id"]) == Decimal("0"), (s, body))
        s, body = draft("a", dl2["id"], [dl(dl2, a_laptop["id"], "1")])
        d4 = body.get("dispatch", {})
        s, body = confirm("a", d4["id"])
        check("one more from the empty stock is refused (409) and the balance stays 0", s == 409 and quantity(a_laptop["id"]) == Decimal("0"), (s, body))
        portal("a", "POST", f"/api/sales/dispatches/{d4['id']}/cancel")

        print("\n== 6. two administrators dispatching the same list at the same moment")
        stock_in("a", a_laptop["id"], "27")  # section 5 emptied the stock on purpose; this section needs laptops to deduct
        dl3 = ready_list("a", acme["id"], [(a_laptop["id"], "10")])
        before = quantity(a_laptop["id"])
        drafts = [draft("a", dl3["id"], [dl(dl3, a_laptop["id"], "6")])[1]["dispatch"] for _ in range(4)]
        outcomes = []

        def confirm_one(d):
            outcomes.append(confirm("a", d["id"]))

        threads = [threading.Thread(target=confirm_one, args=(d,)) for d in drafts]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        check("4 dispatches of 6 against a list of 10, confirmed at once: exactly ONE succeeds, the other three are refused (409 over_dispatch)",
              sorted(s for s, _ in outcomes) == [200, 409, 409, 409] and all(b.get("code") == "over_dispatch" for s, b in outcomes if s == 409), [(s, b.get("code")) for s, b in outcomes])
        check("...only 6 laptops were deducted (never over-dispatched)", quantity(a_laptop["id"]) == before - 6, quantity(a_laptop["id"]))
        check("...the list is Partially Dispatched with 4 left", list_detail("a", dl3["id"])["status"] == "partially_dispatched" and item_of(list_detail("a", dl3["id"]), a_laptop["id"])["remaining_quantity"] == "4.0000")
        loser = next(d for d in drafts if dispatch_detail("a", d["id"])[1].get("status") == "draft")
        portal("a", "PUT", f"/api/sales/dispatches/{loser['id']}/lines", {"lines": [dl(dl3, a_laptop["id"], "4")]})
        check("a refused dispatch stays an editable draft; edited to what remains it is confirmed (200) and completes the list", confirm("a", loser["id"])[0] == 200 and list_detail("a", dl3["id"])["status"] == "dispatched")
        for d in drafts:
            if dispatch_detail("a", d["id"])[1].get("status") == "draft":
                portal("a", "POST", f"/api/sales/dispatches/{d['id']}/cancel")

        print("\n== 7. the Inventory Service's own protections (called directly with A's token)")
        line_id, key = str(uuid.uuid4()), f"live-dispatch-{uuid.uuid4()}"
        body = {"dispatch_number": "DS-TEST", "delivery_list_number": "DL-TEST", "lines": [{"line_id": line_id, "product_id": a_laptop["id"], "quantity": "2", "unit": "pcs"}]}
        s1, t1, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", body, {**bearer(tokens["a"]), "Idempotency-Key": key})
        s2, t2, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", body, {**bearer(tokens["a"]), "Idempotency-Key": key})
        check("a posting answers 201, and the same posting again answers 200 'replayed' with the same operation", (s1, s2) == (201, 200) and jbody(t2).get("replayed") is True and jbody(t1)["operation_id"] == jbody(t2)["operation_id"], (s1, s2))
        s3, t3, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", body, {**bearer(tokens["a"]), "Idempotency-Key": f"another-{uuid.uuid4()}"})
        check("the same dispatch line under a NEW key is refused (409): a line can be deducted only once, whatever the key", s3 == 409, (s3, t3[:120]))
        s4, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {**body, "lines": [{**body["lines"][0], "quantity": "3"}]}, {**bearer(tokens["a"]), "Idempotency-Key": key})
        check("the same key with different goods is refused (409)", s4 == 409, s4)
        s5, t5, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/dispatches/by-key/{key}", headers=bearer(tokens["a"]))
        s6 = call(INVENTORY, "GET", f"/api/v1/inventory/dispatches/by-key/{key}", headers=bearer(tokens["b"]))[0]
        s7 = call(INVENTORY, "GET", "/api/v1/inventory/dispatches/by-key/never-posted-0001", headers=bearer(tokens["a"]))[0]
        check("the by-key check finds it for A (200), not for B (404), and not for a key never used (404)", (s5, s6, s7) == (200, 404, 404) and jbody(t5)["dispatch_number"] == "DS-TEST", (s5, s6, s7))
        s8, t8, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {**body, "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4()), "unit": "box"}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"unit-{uuid.uuid4()}"})
        check("a unit that differs from the product's is refused (409): quantities are never converted", s8 == 409 and "never converted" in t8, (s8, t8[:120]))
        stock_now = quantity(a_laptop["id"])
        two = {"dispatch_number": "DS-TEST2", "lines": [
            {"line_id": str(uuid.uuid4()), "product_id": a_laptop["id"], "quantity": "1", "unit": "pcs"},
            {"line_id": str(uuid.uuid4()), "product_id": a_flour["id"], "quantity": "9999", "unit": "kg"}]}
        s9, t9, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", two, {**bearer(tokens["a"]), "Idempotency-Key": f"atomic-{uuid.uuid4()}"})
        check("a posting is all-or-nothing: one line too large adds NOTHING, not even the good line (409 'Insufficient stock')", s9 == 409 and "Insufficient stock" in t9 and quantity(a_laptop["id"]) == stock_now, (s9, t9[:120]))
        s10, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {**body, "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4()), "product_id": b_laptop["id"]}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"theirs-{uuid.uuid4()}"})
        check("A cannot dispatch B's product (404 'Product not found.')", s10 == 404, s10)
        s11, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {**body, "organization_id": org_ids["b"], "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4())}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"org-{uuid.uuid4()}"})
        check("an organization_id in the body is refused (422)", s11 == 422, s11)
        s12, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {**body, "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4()), "warehouse_id": str(uuid.uuid4())}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"wh-{uuid.uuid4()}"})
        check("a warehouse_id on a dispatch line is refused (422): the Inventory Service no longer knows warehouses", s12 == 422, s12)
        err = psql_with_errors("impex_inventory", f"UPDATE stock_movements SET quantity = 999 WHERE source_reference = 'DS-000001' AND organization_id = '{org_ids['a']}'")
        check("the ledger stays append-only: dispatch movements cannot be edited", "append-only" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"DELETE FROM stock_movements WHERE source_reference = 'DS-000001' AND organization_id = '{org_ids['a']}'")
        check("...or deleted", "append-only" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"UPDATE stock_balances SET quantity = -1 WHERE product_id = '{a_flour['id']}'")
        check("the database refuses a negative balance", "violates check constraint" in err, err[:120])

        print("\n== 8. the database refuses, even if the application is bypassed")
        err = psql_with_errors("impex_sales", f"UPDATE dispatches SET notes = 'edited' WHERE id = '{d1['id']}'")
        check("a confirmed dispatch cannot be edited", "can never be changed" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE dispatches SET status = 'draft' WHERE id = '{d1['id']}'")
        check("...cannot go back to draft", "can never be changed" in err, err[:120])
        err = psql_with_errors("impex_sales", f"DELETE FROM dispatches WHERE id = '{d1['id']}'")
        check("...cannot be deleted", "never deleted" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE dispatch_lines SET quantity = 99 WHERE dispatch_id = '{d1['id']}'")
        check("...and its lines are frozen", "frozen" in err, err[:120])
        err = psql_with_errors("impex_sales", f"DELETE FROM dispatch_lines WHERE dispatch_id = '{d1['id']}'")
        check("...and cannot be removed", "cannot be removed" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE delivery_lists SET status = 'draft' WHERE id = '{dl1['id']}'")
        check("a Dispatched list cannot be reopened even by SQL", "cannot become" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE delivery_lists SET status = 'cancelled' WHERE id = '{dl3['id']}'")
        check("a list with goods dispatched cannot be cancelled even by SQL", "cannot" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE delivery_list_items SET quantity = 99 WHERE id = '{laptops['id']}'")
        check("the items of a list that is not a draft are frozen in the database", "frozen" in err, err[:120])
        other_draft = jbody(portal("a", "POST", "/api/sales/delivery-lists", {"clientId": acme["id"]})[1])["list"]
        err = psql_with_errors("impex_sales", f"UPDATE delivery_list_items SET delivery_list_id = '{other_draft['id']}' WHERE id = '{laptops['id']}'")
        check("an item cannot be moved to another list (the freeze cannot be bypassed that way)", "cannot be moved" in err, err[:120])
        err = psql_with_errors("impex_sales", f"UPDATE delivery_lists SET status = 'dispatched' WHERE id = '{dl2['id']}'")
        check("a list cannot be called Dispatched unless its confirmed dispatches cover every item", "cannot" in err or "fully dispatched" in err, err[:120])
        open_list = ready_list("a", acme["id"], [(a_laptop["id"], "5")])
        sql_dispatch = draft("a", open_list["id"], [dl(open_list, a_laptop["id"], "5")])[1]["dispatch"]
        err = psql_with_errors("impex_sales", f"UPDATE dispatch_lines SET quantity = 6 WHERE dispatch_id = '{sql_dispatch['id']}'; UPDATE dispatches SET status = 'posting', posting_started_at = now() WHERE id = '{sql_dispatch['id']}'")
        check("the database refuses to reserve more than was requested (6 of 5)", "exceed" in err, err[:160])
        portal("a", "POST", f"/api/sales/dispatches/{sql_dispatch['id']}/cancel")

        print("\n== 9. prices and history survive")
        after = inventory_state(org_ids["a"])
        check("selling price 9.99, cost price 5, units and archive flags are exactly as before (dispatching never touches the catalog)", after[3] == inventory_before["a"][3], (inventory_before["a"][3], after[3]))
        check("the delivery list keeps its items, quantities, names and units exactly as listed",
              [(i["product_name"], i["product_sku"], i["quantity"], i["unit"]) for i in dl1["items"]] == [("DPA laptop", "DP-LAPTOP", "15.0000", "pcs"), ("DPA flour", "DP-FLOUR", "2.0000", "kg")], dl1["items"])
        check("the earlier stock history (the starting 'in' movements and the restock) is still there, before the dispatch movements",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id = '{org_ids['a']}' AND source_type IS NULL AND movement_type = 'in'") == "4")
        status, html, _ = page("a", "/movements")
        check("the Movements page shows the dispatch movements with their reason", status == 200 and "Client dispatch DS-000001" in html, status)
        status, html, _ = page("a", "/stock")
        check("the Stock page shows the new quantities", status == 200 and "DPA laptop" in html, status)

        print("\n== 10. the Dispatches list")
        s, text, _, _ = portal("a", "GET", "/api/sales/dispatches?status=confirmed")
        listed = jbody(text)
        check("the list can be filtered by status", s == 200 and all(i["status"] == "confirmed" for i in listed["items"]) and listed["total"] >= 4, listed.get("total"))
        s, text, _, _ = portal("a", "GET", f"/api/sales/dispatches?productId={a_flour['id']}")
        check("...by product (the second dispatch carried flour)", s == 200 and d2["number"] in text, text[:120])
        s, text, _, _ = portal("a", "GET", f"/api/sales/dispatches?deliveryListId={dl1['id']}")
        check("...by delivery list", s == 200 and jbody(text)["total"] >= 2 and all(i["delivery_list"]["number"] == "DL-000001" for i in jbody(text)["items"]))
        s, text, _, _ = portal("a", "GET", "/api/sales/dispatches?q=TRK-4411")
        check("...searched by tracking number", s == 200 and [i["tracking_reference"] for i in jbody(text)["items"]] == ["TRK-4411"], text[:120])
        s, text, _, _ = portal("a", "GET", f"/api/sales/dispatches?clientId={acme['id']}&dateFrom=2000-01-01&dateTo=2999-01-01")
        check("...by client and date range", s == 200 and jbody(text)["total"] >= 4)
        status, html, _ = page("a", "/dispatches")
        check("the Dispatches page lists A's dispatches and none of B's", status == 200 and "DS-000001" in html and "DP Acme Ltd" in html and "DP Beta Client" not in html and "New Dispatch" in html, status)
        status, html, _ = page("a", f"/dispatches/{d1['id']}")
        check("a dispatch's page shows the list, the quantities and the stock movements", status == 200 and "DS-000001" in html and "DL-000001" in html and "DPA laptop" in html and "Confirmed" in html and "TRK-4411" in html, status)

        print("\n== 11. the other organization")
        b_draft = draft("b", b_dl["id"], [dl(b_dl, b_laptop["id"], "5")])[1]["dispatch"]
        check("B prepares its own dispatch, numbered DS-000001 too (numbers are per organization)", b_draft.get("number") == "DS-000001")
        for label, method, path, body_ in (
            ("read", "GET", f"/api/sales/dispatches/{d1['id']}", None), ("edit", "PATCH", f"/api/sales/dispatches/{d1['id']}", {"notes": "HIJACK"}),
            ("replace the lines of", "PUT", f"/api/sales/dispatches/{d1['id']}/lines", {"lines": []}), ("confirm", "POST", f"/api/sales/dispatches/{d1['id']}/confirm", None),
            ("cancel", "POST", f"/api/sales/dispatches/{d1['id']}/cancel", None),
        ):
            s, text, _, _ = portal("b", method, path, body_)
            missing = portal("b", method, path.replace(d1["id"], str(uuid.uuid4())), body_)
            check(f"B cannot {label} A's dispatch: 404, exactly like an id that does not exist", s == 404 and (s, jbody(text)) == (missing[0], jbody(missing[1])) and "DPA" not in text, (s, text[:100]))
        s, body = draft("b", dl1["id"], [])
        check("B cannot start a dispatch against A's delivery list (404)", s == 404, (s, body))
        check("B cannot cancel A's delivery list (404)", portal("b", "POST", f"/api/sales/delivery-lists/{dl2['id']}/cancel")[0] == 404)
        s, text, _, _ = portal("b", "GET", "/api/sales/dispatches")
        check("B's list holds only B's dispatch", s == 200 and [i["number"] for i in jbody(text)["items"]] == ["DS-000001"] and jbody(text)["items"][0]["id"] == b_draft["id"] and "DPA" not in text)
        s, text, _, _ = portal("b", "GET", f"/api/sales/dispatches?productId={a_laptop['id']}&deliveryListId={dl1['id']}")
        check("...and filtering by A's product or list ids finds nothing", s == 200 and jbody(text)["total"] == 0)
        status, html, _ = page("b", f"/dispatches/{d1['id']}")
        check("B opening A's dispatch page sees 'not found'", status == 200 and "Dispatch not found." in html and "DPA" not in html)
        status, html, _ = page("b", f"/delivery-lists/{dl1['id']}/dispatch")
        check("...and A's Prepare dispatch page", status == 200 and "Delivery list not found." in html and "DPA" not in html)
        s, text, _, _ = call(SALES, "POST", "/api/v1/sales/dispatches", {"delivery_list_id": dl1["id"], "organization_id": org_ids["a"]}, {**bearer(tokens["b"]), "Idempotency-Key": f"hack-{uuid.uuid4()}"})
        check("an organization_id in a request body is rejected by the service (422)", s == 422, (s, text[:100]))
        s, _, _, _ = call(SALES, "GET", f"/api/v1/sales/dispatches?organization_id={org_ids['a']}", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a query parameter and header naming A change nothing for B", s == 200)
        check("B's stock is exactly as it was (99), A's dispatches never reached it", quantity(b_laptop["id"]) == Decimal("99") and inventory_state(org_ids["b"]) == inventory_before["b"])
        err = psql_with_errors("impex_sales", f"INSERT INTO dispatches (organization_id, delivery_list_id, client_id, number, dispatch_date, posting_key, created_by, created_by_email) VALUES ('{org_ids['b']}', '{dl1['id']}', '{beta_client['id']}', 'DS-777777', current_date, 'dispatch-x', '{uuid.uuid4()}', 'x@x')")
        check("the database refuses a dispatch that points at another organization's list", "violates" in err or "Ready or Partially" in err, err[:140])
        s, _, _, _ = call(SALES, "GET", "/api/v1/sales/dispatches", headers=bearer(sa_token))
        check("a Super Admin gets 403 from the dispatches API; no token -> 401", s == 403 and call(SALES, "GET", "/api/v1/sales/dispatches")[0] == 401)
        for path in ("/dispatches", f"/dispatches/{d1['id']}", f"/delivery-lists/{dl1['id']}/dispatch"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path)
            check(f"{path} without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        check("an inactive organization cannot confirm (403) and its page explains", confirm("b", b_draft["id"])[0] == 403 and "currently inactive or unavailable" in page("b", "/dispatches")[1])
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("...reactivating restores it, and B can dispatch normally (200)", confirm("b", b_draft["id"])[0] == 200 and quantity(b_laptop["id"]) == Decimal("94"))

        print("\n== 12. interrupted between the two services")
        stock_in("a", a_laptop["id"], "100")  # earlier sections used up most of the stock; the interruptions below need stock to deduct
        dl4 = ready_list("a", acme["id"], [(a_laptop["id"], "30")])
        main_before = quantity(a_laptop["id"])
        crash1 = draft("a", dl4["id"], [dl(dl4, a_laptop["id"], "10")])[1]["dispatch"]
        psql("impex_sales", f"UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{crash1['id']}'")
        s, r = dispatch_detail("a", crash1["id"])
        check("SIMULATED CRASH after the intent was saved but before Inventory was called: the dispatch is 'posting', the quantity is reserved, no stock moved",
              r.get("status") == "posting" and quantity(a_laptop["id"]) == main_before and item_of(list_detail("a", dl4["id"]), a_laptop["id"])["pending_quantity"] == "10.0000", r.get("status"))
        s, body = confirm("a", crash1["id"])
        check("a retry finishes it: confirmed (200), 10 laptops deducted once", s == 200 and body["dispatch"]["status"] == "confirmed" and quantity(a_laptop["id"]) == main_before - 10, (s, body))
        crash2 = draft("a", dl4["id"], [dl(dl4, a_laptop["id"], "8")])[1]["dispatch"]
        psql("impex_sales", f"UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{crash2['id']}'")
        full = dispatch_detail("a", crash2["id"])[1]
        committed = {"dispatch_number": full["number"], "delivery_list_number": dl4["number"], "lines": [
            {"line_id": full["lines"][0]["id"], "product_id": a_laptop["id"], "quantity": "8", "unit": "pcs"}]}
        s, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", committed, {**bearer(tokens["a"]), "Idempotency-Key": f"dispatch-{crash2['id']}"})
        check("SIMULATED CRASH after Inventory committed but before Sales recorded it: Inventory has deducted the 8, the dispatch is still 'posting'",
              s == 201 and quantity(a_laptop["id"]) == main_before - 18 and dispatch_detail("a", crash2["id"])[1].get("status") == "posting", s)
        s, body = confirm("a", crash2["id"])
        check("a retry verifies the earlier posting and confirms WITHOUT deducting the 8 laptops again", s == 200 and body["dispatch"]["status"] == "confirmed" and quantity(a_laptop["id"]) == main_before - 18 and
              all(l["inventory_movement_id"] for l in body["dispatch"]["lines"]), (s, quantity(a_laptop["id"])))
        check("...the list progressed: 18 of 30 dispatched, Partially Dispatched", list_detail("a", dl4["id"])["status"] == "partially_dispatched" and item_of(list_detail("a", dl4["id"]), a_laptop["id"])["dispatched_quantity"] == "18.0000")

        if args.with_outage:
            print("\n== 13. service outages")
            outage = draft("a", dl4["id"], [dl(dl4, a_laptop["id"], "5")])[1]["dispatch"]
            docker("compose", "stop", "inventory-service")
            try:
                s, body = confirm("a", outage["id"])
                check("confirming while the Inventory Service is down answers 503 with a clear message; the dispatch stays an editable draft", s == 503 and "inventory" in body.get("error", "").lower() and dispatch_detail("a", outage["id"])[1].get("status") == "draft", (s, body))
                check("viewing dispatches still works", page("a", "/dispatches")[0] == 200 and dispatch_detail("a", outage["id"])[0] == 200)
                psql("impex_sales", f"UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{outage['id']}'")
                s, body = confirm("a", outage["id"])
                check("a dispatch already 'posting' while Inventory is down answers 202 (not confirmed, not lost), with the reason on the dispatch",
                      s == 202 and body.get("confirmed") is False and body["dispatch"]["status"] == "posting" and body["dispatch"]["posting"]["last_error"], (s, body))
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            s, r = dispatch_detail("a", outage["id"])
            check("while Inventory was down nothing was deducted", quantity(a_laptop["id"]) == main_before - 18 and r.get("status") == "posting")
            s, body = confirm("a", outage["id"])
            check("once it is back, the retry confirms (200) and deducts the 5 laptops exactly once", s == 200 and body["dispatch"]["status"] == "confirmed" and quantity(a_laptop["id"]) == main_before - 23, (s, body))
            restart = draft("a", dl4["id"], [dl(dl4, a_laptop["id"], "4")])[1]["dispatch"]
            psql("impex_sales", f"UPDATE dispatches SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{restart['id']}'")
            docker("compose", "restart", "sales-service")
            wait_until(SALES, "/health")
            s, r = dispatch_detail("a", restart["id"])
            check("after the Sales Service restarts, the 'posting' dispatch is still there, with its saved intent", s == 200 and r.get("status") == "posting" and r["posting"]["attempts"] == 1, (s, r.get("status")))
            s, body = confirm("a", restart["id"])
            check("...and a retry finishes it (200), deducting the 4 laptops once", s == 200 and quantity(a_laptop["id"]) == main_before - 27, (s, quantity(a_laptop["id"])))
            docker("compose", "stop", "sales-service")
            try:
                s, text, _, _ = portal("a", "POST", "/api/sales/dispatches", {"deliveryListId": dl4["id"]}, {"Idempotency-Key": f"dp-{uuid.uuid4()}"})
                check("creating a dispatch while the Sales Service is down answers 503", s == 503, (s, text[:100]))
                status, html, _ = page("a", "/dispatches")
                check("the Dispatches page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html, status)
                check("products and stock are unaffected", page("a", "/stock")[0] == 200)
            finally:
                docker("compose", "start", "sales-service")
                wait_until(SALES, "/health")
            check("the Sales Service is back", page("a", "/dispatches")[0] == 200)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")

        print("\n== 14. one last look: inventory equals what the CONFIRMED dispatches say")
        for org in ("a", "b"):
            expected = psql("impex_sales", f"SELECT coalesce(string_agg(l.product_id || ':' || l.s::text, ',' ORDER BY l.product_id), '') FROM (SELECT dl.product_id, sum(dl.quantity) AS s FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE d.organization_id = '{org_ids[org]}' AND d.status = 'confirmed' GROUP BY dl.product_id) l")
            posted = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || s::text, ',' ORDER BY product_id), '') FROM (SELECT product_id, sum(quantity) AS s FROM stock_movements WHERE organization_id = '{org_ids[org]}' AND source_type = 'client_dispatch' AND source_reference LIKE 'DS-0%' GROUP BY product_id) m")
            check(f"organization {org.upper()}: the goods the confirmed dispatches carry are exactly the goods deducted from stock, per product", expected == posted, (expected, posted))
        check("no dispatch is left half-way (nothing 'posting')", psql("impex_sales", f"SELECT count(*) FROM dispatches WHERE status = 'posting' AND organization_id IN ('{org_ids['a']}', '{org_ids['b']}')") == "0")
        check("no balance is negative", psql("impex_inventory", f"SELECT count(*) FROM stock_balances WHERE quantity < 0 AND organization_id IN ('{org_ids['a']}', '{org_ids['b']}')") == "0")
        check("the catalog prices of both organizations are still exactly as they were", {k: inventory_state(org_ids[k])[3] for k in ("a", "b")} == {k: inventory_before[k][3] for k in ("a", "b")})
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
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
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", created.get("users")),
        }
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(created.get('products'))} products, {len(created.get('users'))} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
