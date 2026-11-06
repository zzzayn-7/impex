#!/usr/bin/env python3
"""End-to-end check of Goods Receiving against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_purchasing and impex_inventory migrated to head
    python scripts/verify_goods_receiving.py
    python scripts/verify_goods_receiving.py --with-outage    # also stops the Inventory and Purchasing services briefly

It creates two throwaway organizations ("Receiving Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: places purchase orders,
prepares goods receipts (drafts change nothing), confirms partial receipts into different warehouses, and checks - against the
Inventory database itself - that the stock, the movement history and the prices are exactly what they should be.

The central checks: drafts / scans / reviews never add stock; a confirmed receipt adds exactly the ACCEPTED quantities once (never
the rejected ones), repeated and simultaneous confirmations never add twice, nothing can be over-received, the database itself
refuses to change a confirmed receipt or to move a purchase-order line between orders, a receipt interrupted between the two
services (intent saved, Inventory committed but unrecorded, Inventory down) is finished by a retry without adding twice, and the
other organization sees and changes nothing. Everything it created is deleted afterwards, by exact id. No emails are sent and no
existing record is touched.
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

AUTH, ORG, INVENTORY, PURCHASING, SUPER_PORTAL, TENANT_PORTAL = 8000, 8001, 8002, 8004, 3000, 3001
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
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory and Purchasing services briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "grcheck-sa@example.org"
    emails = {"a": "grcheck-admin-a@example.org", "b": "grcheck-admin-b@example.org"}
    org_names = {"a": "Receiving Check Alpha", "b": "Receiving Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, html, _, location = portal(key, "GET", path)
        return status, html.replace("<!-- -->", ""), location

    def product(key, sku, name, unit="pcs"):
        _, text, _, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "category": "GR check", "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def warehouse(key, code, name):
        _, text, _, _ = portal(key, "POST", "/api/warehouses", {"code": code, "name": name})
        body = jbody(text).get("warehouse", {})
        created.add("warehouses", body.get("id"))
        return body

    def stock_in(key, pid, wid, quantity):
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "warehouse_id": wid, "quantity": quantity}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})[0]

    def supplier(key, name):
        status, text, _, _ = portal(key, "POST", "/api/purchasing/suppliers", {"name": name})
        body = jbody(text).get("supplier", {})
        created.add("suppliers", body.get("id"))
        return body

    def place_order(key, supplier_id, lines):
        status, text, _, _ = portal(key, "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier_id, "currencyCode": "USD"}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})
        order = jbody(text).get("order", {})
        for product_id, quantity, price in lines:
            portal(key, "POST", f"/api/purchasing/purchase-orders/{order['id']}/lines", {"productId": product_id, "quantity": quantity, "unitPrice": price})
        portal(key, "POST", f"/api/purchasing/purchase-orders/{order['id']}/order")
        return order_detail(key, order["id"])

    def order_detail(key, order_id):
        return jbody(portal(key, "GET", f"/api/purchasing/purchase-orders/{order_id}")[1]).get("order", {})

    def line_of(order, product_id):
        return next(l for l in order["lines"] if l["product_id"] == product_id)

    def rl(order, product_id, accepted, warehouse_id, rejected="0", **extra):
        return {"purchaseOrderLineId": line_of(order, product_id)["id"], "acceptedQuantity": accepted, "rejectedQuantity": rejected, "warehouseId": warehouse_id, **extra}

    def draft(key, order_id, lines, idem=None, **extra):
        status, text, _, _ = portal(key, "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": order_id, "lines": lines, **extra}, {"Idempotency-Key": idem or f"gr-{uuid.uuid4()}"})
        body = jbody(text)
        created.add("goods_receipts", (body.get("receipt") or {}).get("id"))
        return status, body

    def confirm(key, receipt_id):
        status, text, _, _ = portal(key, "POST", f"/api/purchasing/goods-receipts/{receipt_id}/confirm")
        return status, jbody(text)

    def receipt_detail(key, receipt_id):
        status, text, _, _ = portal(key, "GET", f"/api/purchasing/goods-receipts/{receipt_id}")
        return status, jbody(text).get("receipt", {})

    def inventory_state(org):
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || warehouse_id || ':' || quantity::text, ',' ORDER BY product_id, warehouse_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(max(created_at)::text, '') FROM stock_movements WHERE organization_id = '{org}'")
        operations = psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE organization_id = '{org}'")
        prices = psql("impex_inventory", f"SELECT coalesce(string_agg(sku || ':' || cost_price::text || ':' || selling_price::text || ':' || unit || ':' || is_active::text, ',' ORDER BY sku), '') FROM products WHERE organization_id = '{org}'")
        return balances, movements, operations, prices

    def quantity(product_id, warehouse_id):
        value = psql("impex_inventory", f"SELECT coalesce((SELECT quantity FROM stock_balances WHERE product_id = '{product_id}' AND warehouse_id = '{warehouse_id}'), 0)")
        return Decimal(value or "0")

    def movements_for(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}' AND source_type = 'goods_receipt'") or "0")

    def sql_refusal(db, sql):
        return psql_with_errors(db, sql)

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='GRcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"grcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        a_bolt, a_flour, a_old = product("a", "GR-BOLT", "GRA steel bolt", "pcs"), product("a", "GR-FLOUR", "GRA flour", "kg"), product("a", "GR-OLD", "GRA old widget", "pcs")
        b_bolt = product("b", "GR-BOLT", "GRB silk scarf", "pcs")
        a_main, a_shelf, a_dead, b_main = warehouse("a", "MAIN", "GRA main depot"), warehouse("a", "SHELF", "GRA shelf room"), warehouse("a", "DEAD", "GRA closed"), warehouse("b", "MAIN", "GRB main depot")
        check("products and warehouses created (the same SKU 'GR-BOLT' in both organizations)", all(x.get("id") for x in (a_bolt, a_flour, a_old, b_bolt, a_main, a_shelf, a_dead, b_main)))
        stock_in("a", a_bolt["id"], a_main["id"], "40")
        stock_in("a", a_flour["id"], a_main["id"], "2.5")
        stock_in("b", b_bolt["id"], b_main["id"], "99")
        portal("a", "POST", f"/api/warehouses/{a_dead['id']}/archive")
        acme, b_acme = supplier("a", "GR Acme Supplies"), supplier("b", "GR Beta Supplier")
        po1 = place_order("a", acme["id"], [(a_bolt["id"], "50", "1.25"), (a_flour["id"], "10", "3.10")])
        b_po = place_order("b", b_acme["id"], [(b_bolt["id"], "20", "2")])
        check("A's purchase order PO-000001 is placed (Ordered, 50 bolts + 10 kg flour); B has one too",
              po1.get("status") == "ordered" and po1.get("number") == "PO-000001" and po1.get("can_receive") is True and b_po.get("status") == "ordered", (po1.get("status"), b_po.get("status")))
        check("a new Ordered order shows received 0 / remaining = ordered on every line",
              all(l["received_quantity"] == "0.0000" and l["remaining_quantity"] == l["quantity"] for l in po1["lines"]), po1["lines"])
        inventory_before = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("starting stock recorded (A: 40 bolts + 2.5 kg flour; B: 99; selling price 9.99, cost price 5)",
              len(inventory_before["a"][0].split(",")) == 2 and "9.9900" in inventory_before["a"][3] and "5.0000" in inventory_before["a"][3], inventory_before["a"])

        print("\n== 1. preparing a receipt changes NOTHING in inventory")
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "30", a_main["id"], rejected="2"), rl(po1, a_flour["id"], "4", a_shelf["id"])], idem="gr-live-key-0001", supplierReference="DN-1042", notes="Pallet 3")
        r1 = body.get("receipt", {})
        check("A starts a draft receipt (201): GR-000001, draft, against PO-000001, with its lines",
              s == 201 and r1.get("number") == "GR-000001" and r1.get("status") == "draft" and r1.get("purchase_order", {}).get("number") == "PO-000001" and len(r1.get("lines", [])) == 2, (s, body))
        check("...no organization in the answer", "organization_id" not in json.dumps(body))
        s2, again = draft("a", po1["id"], [rl(po1, a_bolt["id"], "30", a_main["id"], rejected="2"), rl(po1, a_flour["id"], "4", a_shelf["id"])], idem="gr-live-key-0001", supplierReference="DN-1042", notes="Pallet 3")
        check("a double click / retry with the same key answers 200 with the SAME draft", s2 == 200 and again["receipt"]["id"] == r1["id"] and again.get("replayed") is True, (s2, again))
        s3, body3 = draft("a", po1["id"], [rl(po1, a_bolt["id"], "31", a_main["id"])], idem="gr-live-key-0001")
        check("the same key for a different receipt is refused (409)", s3 == 409, (s3, body3))
        outcomes = []

        def create_dup(_):
            outcomes.append(draft("a", po1["id"], [rl(po1, a_bolt["id"], "1", a_main["id"])], idem="gr-double-click-01"))

        threads = [threading.Thread(target=create_dup, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        ids = {b["receipt"]["id"] for s, b in outcomes if s in (200, 201)}
        check("6 simultaneous submissions of one form create ONE draft (one 201, five 200)", sorted(s for s, _ in outcomes) == [200] * 5 + [201] and len(ids) == 1, [s for s, _ in outcomes])
        dup_id = next(iter(ids))
        s, text, _, _ = portal("a", "POST", f"/api/purchasing/goods-receipts/{dup_id}/cancel")
        check("that extra draft is discarded (kept as cancelled)", s == 200 and jbody(text)["receipt"]["status"] == "cancelled")
        s, text, _, _ = portal("a", "PUT", f"/api/purchasing/goods-receipts/{r1['id']}/lines", {"lines": [rl(po1, a_bolt["id"], "30", a_main["id"], rejected="2"), rl(po1, a_flour["id"], "4", a_shelf["id"])]})
        check("saving the lines again (200) and editing the header (200)", s == 200 and portal("a", "PATCH", f"/api/purchasing/goods-receipts/{r1['id']}", {"notes": "Pallet 3 (counted twice)"})[0] == 200)
        status, html, _ = page("a", f"/purchase-orders/{po1['id']}/receive?receipt={r1['id']}")
        check("the Receive Goods page opens the draft for editing", status == 200 and "Receive goods" in html and "Editing the draft GR-000001" in html and "Review receipt" in html, status)
        s, text, _, _ = portal("a", "GET", "/api/scan/resolve?code=gr-bolt")
        check("the product is found by SKU or barcode (the optional locate step - a lookup only)", s == 200 and jbody(text)["product"]["id"] == a_bolt["id"], (s, text[:100]))
        check("after drafting, saving, editing and scanning: stock, history, operations and prices are untouched",
              {k: inventory_state(org_ids[k]) for k in ("a", "b")} == inventory_before)
        check("...and the order is still plain Ordered with nothing received", order_detail("a", po1["id"])["status"] == "ordered" and all(l["received_quantity"] == "0.0000" for l in order_detail("a", po1["id"])["lines"]))

        print("\n== 2. what cannot be received")
        for label, lines, expect in (
            ("more than ordered (51 of 50)", [rl(po1, a_bolt["id"], "51", a_main["id"])], 409),
            ("a fraction of a piece", [rl(po1, a_bolt["id"], "1.5", a_main["id"])], 400),
            ("a negative quantity", [rl(po1, a_bolt["id"], "-1", a_main["id"])], 400),
            ("a text quantity", [rl(po1, a_bolt["id"], "lots", a_main["id"])], 400),
            ("an archived warehouse", [rl(po1, a_bolt["id"], "1", a_dead["id"])], 409),
            ("a warehouse of nobody", [rl(po1, a_bolt["id"], "1", str(uuid.uuid4()))], 404),
            ("another organization's warehouse", [rl(po1, a_bolt["id"], "1", b_main["id"])], 404),
            ("accepted goods without a warehouse", [{**rl(po1, a_bolt["id"], "1", a_main["id"]), "warehouseId": ""}], 400),
            ("an order line of another organization's order", [{"purchaseOrderLineId": b_po["lines"][0]["id"], "acceptedQuantity": "1", "warehouseId": a_main["id"]}], 404),
            ("an order line that does not exist", [{"purchaseOrderLineId": str(uuid.uuid4()), "acceptedQuantity": "1", "warehouseId": a_main["id"]}], 404),
        ):
            s, body = draft("a", po1["id"], lines)
            check(f"{label} is refused ({expect})", s == expect, (s, body))
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "1", a_main["id"], unit="box", productName="Hacked", status="confirmed")])
        check("unit / name / status sent by the browser are ignored (the draft takes them from the order)", s == 201 and body["receipt"]["lines"][0]["unit"] == "pcs" and body["receipt"]["lines"][0]["product_name"] == "GRA steel bolt" and body["receipt"]["status"] == "draft", (s, body))
        junk_id = body["receipt"]["id"]
        portal("a", "POST", f"/api/purchasing/goods-receipts/{junk_id}/cancel")
        po_draft = jbody(portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": acme["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})[1]).get("order", {})
        s, body = draft("a", po_draft["id"], [])
        check("a receipt against a DRAFT order is refused (409)", s == 409 and "still a draft" in body.get("error", ""), (s, body))
        s, body = draft("a", str(uuid.uuid4()), [])
        check("...and against an order that does not exist (404)", s == 404, (s, body))
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "0", a_main["id"], rejected="5")])
        reject_only = body.get("receipt", {})
        check("a receipt with only rejected goods can be recorded as a draft (201)...", s == 201, (s, body))
        s, body = confirm("a", reject_only.get("id", ""))
        check("...but cannot be confirmed: nothing is accepted, so nothing can go to stock (400)", s == 400 and "Nothing is accepted" in body.get("error", ""), (s, body))
        portal("a", "POST", f"/api/purchasing/goods-receipts/{reject_only['id']}/cancel")

        print("\n== 3. a PARTIAL receipt into two warehouses: 30 bolts to MAIN, 4 kg flour to SHELF")
        s, body = confirm("a", r1["id"])
        confirmed1 = body.get("receipt", {})
        check("A confirms GR-000001 (200, confirmed, with who and when)", s == 200 and body.get("confirmed") is True and confirmed1.get("status") == "confirmed" and confirmed1.get("confirmed_by_email") == emails["a"] and confirmed1.get("confirmed_at"), (s, body))
        check("bolts: 40 + 30 = 70 in MAIN (the 2 rejected were NOT added)", quantity(a_bolt["id"], a_main["id"]) == Decimal("70"), quantity(a_bolt["id"], a_main["id"]))
        check("flour: 4 kg in SHELF, and the old 2.5 kg in MAIN is untouched", quantity(a_flour["id"], a_shelf["id"]) == Decimal("4") and quantity(a_flour["id"], a_main["id"]) == Decimal("2.5"))
        check("exactly two stock movements were written, each linked to GR-000001", movements_for(a_bolt["id"]) == 1 and movements_for(a_flour["id"]) == 1 and
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_reference = 'GR-000001' AND organization_id = '{org_ids['a']}'") == "2")
        check("each movement says who, what, where, why: type 'in', reason 'Goods receipt GR-000001 (PO-000001)', actor = the administrator",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_reference = 'GR-000001' AND organization_id = '{org_ids['a']}' AND movement_type = 'in' AND reason = 'Goods receipt GR-000001 (PO-000001)' AND created_by_email = '{emails['a']}'") == "2")
        check("every accepted line on the receipt carries its inventory movement id", all(l["inventory_movement_id"] for l in confirmed1["lines"]) and confirmed1.get("inventory_operation_id"))
        check("the movement ids on the receipt are the real ledger rows",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE id IN ({', '.join(repr(l['inventory_movement_id']) for l in confirmed1['lines'])})") == "2")
        s, again_body = confirm("a", r1["id"])
        check("confirming again (a double click / retry) answers 200 and changes nothing", s == 200 and again_body["receipt"]["confirmed_at"] == confirmed1["confirmed_at"] and quantity(a_bolt["id"], a_main["id"]) == Decimal("70"))
        po1 = order_detail("a", po1["id"])
        bolts, flour = line_of(po1, a_bolt["id"]), line_of(po1, a_flour["id"])
        check("the order is now PARTIALLY RECEIVED: bolts 30 of 50 (20 left), flour 4 of 10 (6 left)",
              po1["status"] == "partially_received" and (bolts["received_quantity"], bolts["remaining_quantity"]) == ("30.0000", "20.0000") and (flour["received_quantity"], flour["remaining_quantity"]) == ("4.0000", "6.0000"), (po1["status"], bolts, flour))
        check("...it can still receive more and shows the receipt in its history", po1["can_receive"] is True and [r["number"] for r in po1["receipts"] if r["status"] == "confirmed"] == ["GR-000001"])
        s, body = portal("a", "POST", f"/api/purchasing/purchase-orders/{po1['id']}/cancel")[0], None
        check("a Partially Received order can no longer be cancelled (409)", s == 409, s)
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/purchase-orders/{po1['id']}", {"notes": "tamper"})
        check("...and stays frozen (409)", s == 409, s)
        s, text, _, _ = portal("a", "PUT", f"/api/purchasing/goods-receipts/{r1['id']}/lines", {"lines": []})
        check("a confirmed receipt cannot be edited (409)", s == 409, (s, text[:120]))
        check("...nor cancelled (409)", portal("a", "POST", f"/api/purchasing/goods-receipts/{r1['id']}/cancel")[0] == 409)

        print("\n== 4. the rest of the order: no over-receipt, completion")
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "21", a_main["id"])])
        check("receiving 21 when only 20 remain is refused (409)", s == 409 and "at most 20" in body.get("error", ""), (s, body))
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "20", a_main["id"], rejected="3"), rl(po1, a_flour["id"], "6", a_main["id"])], supplierReference="DN-1077")
        r2 = body.get("receipt", {})
        check("A drafts GR-00000x for exactly the remainder (20 bolts + 6 kg), 3 bolts rejected", s == 201 and r2.get("status") == "draft", (s, body))
        outcomes = []

        def confirm_many(_):
            outcomes.append(confirm("a", r2["id"]))

        threads = [threading.Thread(target=confirm_many, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        check("6 simultaneous confirmations of ONE receipt all end well (200, or 202 'retry' - never an error)", all(s in (200, 202) for s, _ in outcomes) and any(s == 200 for s, _ in outcomes), [s for s, _ in outcomes])
        s, final2 = receipt_detail("a", r2["id"])
        if final2.get("status") != "confirmed":
            confirm("a", r2["id"])
            s, final2 = receipt_detail("a", r2["id"])
        check("...and it is confirmed exactly once", final2.get("status") == "confirmed")
        check("bolts: 70 + 20 = 90 in MAIN; flour: 2.5 + 6 = 8.5 in MAIN, 4 in SHELF (added ONCE despite 6 simultaneous confirmations; rejected 3 not added)",
              quantity(a_bolt["id"], a_main["id"]) == Decimal("90") and quantity(a_flour["id"], a_main["id"]) == Decimal("8.5") and quantity(a_flour["id"], a_shelf["id"]) == Decimal("4"),
              (quantity(a_bolt["id"], a_main["id"]), quantity(a_flour["id"], a_main["id"])))
        check("...with exactly 4 goods-receipt movements in all (2 per receipt)", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_type = 'goods_receipt' AND organization_id = '{org_ids['a']}'") == "4")
        check("...and one posting operation per receipt (the same key was used for every attempt)",
              psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE kind = 'receipt' AND organization_id = '{org_ids['a']}'") == "2" and
              psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE idempotency_key IN ('goods-receipt-{r1['id']}', 'goods-receipt-{r2['id']}') AND organization_id = '{org_ids['a']}'") == "2")
        po1 = order_detail("a", po1["id"])
        check("the order is now RECEIVED, frozen, with nothing remaining", po1["status"] == "received" and po1["can_receive"] is False and all(l["remaining_quantity"] == "0.0000" for l in po1["lines"]), po1["status"])
        s, body = draft("a", po1["id"], [rl(po1, a_bolt["id"], "1", a_main["id"])])
        check("a Received order takes no further receipts (409)", s == 409 and "fully received" in body.get("error", ""), (s, body))
        check("...and cannot be cancelled (409)", portal("a", "POST", f"/api/purchasing/purchase-orders/{po1['id']}/cancel")[0] == 409)
        status, html, _ = page("a", f"/purchase-orders/{po1['id']}")
        check("the order page shows the status, the receipts and the received / remaining columns", status == 200 and "Received" in html and "Goods receipts (" in html and "GR-000001" in html and "Remaining" in html, status)

        print("\n== 5. two people receiving the last units at the same moment")
        po2 = place_order("a", acme["id"], [(a_bolt["id"], "10", "2")])
        before = quantity(a_bolt["id"], a_main["id"])
        drafts = [draft("a", po2["id"], [rl(po2, a_bolt["id"], "6", a_main["id"])])[1]["receipt"] for _ in range(4)]
        outcomes = []

        def confirm_one(receipt):
            outcomes.append(confirm("a", receipt["id"]))

        threads = [threading.Thread(target=confirm_one, args=(r,)) for r in drafts]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        check("4 receipts of 6 against an order of 10, confirmed at once: exactly ONE succeeds, the other three are refused (409)", sorted(s for s, _ in outcomes) == [200, 409, 409, 409], [s for s, _ in outcomes])
        check("...only 6 bolts were added (never over-received)", quantity(a_bolt["id"], a_main["id"]) == before + 6, quantity(a_bolt["id"], a_main["id"]))
        check("...the order is Partially Received with 4 left", order_detail("a", po2["id"])["status"] == "partially_received" and line_of(order_detail("a", po2["id"]), a_bolt["id"])["remaining_quantity"] == "4.0000")
        loser = next(r for r in drafts if receipt_detail("a", r["id"])[1].get("status") == "draft")
        check("a refused receipt stays an editable draft (no stock, nothing reserved)", receipt_detail("a", loser["id"])[1].get("editable") is True)
        s, text, _, _ = portal("a", "PUT", f"/api/purchasing/goods-receipts/{loser['id']}/lines", {"lines": [rl(po2, a_bolt["id"], "4", a_main["id"])]})
        s2, body2 = confirm("a", loser["id"])
        check("...which can be edited down to what remains and then confirmed (200), completing the order", s == 200 and s2 == 200 and order_detail("a", po2["id"])["status"] == "received", (s, s2))
        for r in drafts:
            if receipt_detail("a", r["id"])[1].get("status") == "draft":
                portal("a", "POST", f"/api/purchasing/goods-receipts/{r['id']}/cancel")

        print("\n== 6. the Inventory Service's own protections (called directly with A's token)")
        line_id, key = str(uuid.uuid4()), f"live-posting-{uuid.uuid4()}"
        body = {"receipt_number": "GR-TEST", "purchase_order_number": "PO-TEST", "lines": [{"line_id": line_id, "product_id": a_bolt["id"], "warehouse_id": a_shelf["id"], "quantity": "2", "unit": "pcs"}]}
        s1, t1, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", body, {**bearer(tokens["a"]), "Idempotency-Key": key})
        s2, t2, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", body, {**bearer(tokens["a"]), "Idempotency-Key": key})
        check("a posting answers 201, and the same posting again answers 200 'replayed' with the same operation", (s1, s2) == (201, 200) and jbody(t2).get("replayed") is True and jbody(t1)["operation_id"] == jbody(t2)["operation_id"], (s1, s2))
        check("...the goods were added once (2 bolts in SHELF)", quantity(a_bolt["id"], a_shelf["id"]) == Decimal("2"))
        s3, t3, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", body, {**bearer(tokens["a"]), "Idempotency-Key": f"another-{uuid.uuid4()}"})
        check("the same receipt line under a NEW key is refused (409): a line can be added to stock only once, whatever the key", s3 == 409 and quantity(a_bolt["id"], a_shelf["id"]) == Decimal("2"), (s3, t3[:120]))
        s4, t4, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", {**body, "lines": [{**body["lines"][0], "quantity": "3"}]}, {**bearer(tokens["a"]), "Idempotency-Key": key})
        check("the same key with different goods is refused (409)", s4 == 409, (s4, t4[:120]))
        s5, t5, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/goods-receipts/by-key/{key}", headers=bearer(tokens["a"]))
        s6, _, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/goods-receipts/by-key/{key}", headers=bearer(tokens["b"]))
        s7, _, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/goods-receipts/by-key/never-posted-0001", headers=bearer(tokens["a"]))
        check("the by-key check finds it for A (200), not for B (404), and not for a key never used (404)", (s5, s6, s7) == (200, 404, 404) and jbody(t5)["receipt_number"] == "GR-TEST", (s5, s6, s7))
        bad_unit = {**body, "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4()), "unit": "box"}]}
        s8, t8, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", bad_unit, {**bearer(tokens["a"]), "Idempotency-Key": f"unit-{uuid.uuid4()}"})
        check("a unit that differs from the product's is refused (409): quantities are never converted", s8 == 409 and "never converted" in t8, (s8, t8[:120]))
        two = {"receipt_number": "GR-TEST2", "lines": [
            {"line_id": str(uuid.uuid4()), "product_id": a_bolt["id"], "warehouse_id": a_shelf["id"], "quantity": "5", "unit": "pcs"},
            {"line_id": str(uuid.uuid4()), "product_id": a_flour["id"], "warehouse_id": a_dead["id"], "quantity": "5", "unit": "kg"}]}
        s9, t9, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", two, {**bearer(tokens["a"]), "Idempotency-Key": f"atomic-{uuid.uuid4()}"})
        check("a posting is all-or-nothing: one bad line (archived warehouse) adds NOTHING, not even the good line (409)", s9 == 409 and quantity(a_bolt["id"], a_shelf["id"]) == Decimal("2"), (s9, t9[:120]))
        s10, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", {**body, "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4()), "product_id": b_bolt["id"]}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"theirs-{uuid.uuid4()}"})
        check("A cannot post goods of B's product (404 'Product not found.')", s10 == 404, s10)
        s11, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", {**body, "organization_id": org_ids["b"], "lines": [{**body["lines"][0], "line_id": str(uuid.uuid4())}]}, {**bearer(tokens["a"]), "Idempotency-Key": f"org-{uuid.uuid4()}"})
        check("an organization_id in the body is refused (422)", s11 == 422, s11)
        err = sql_refusal("impex_inventory", f"UPDATE stock_movements SET quantity = 999 WHERE source_reference = 'GR-000001' AND organization_id = '{org_ids['a']}'")
        check("the ledger stays append-only: receipt movements cannot be edited", "append-only" in err, err[:120])
        err = sql_refusal("impex_inventory", f"DELETE FROM stock_movements WHERE source_reference = 'GR-000001' AND organization_id = '{org_ids['a']}'")
        check("...or deleted", "append-only" in err, err[:120])

        print("\n== 7. the database refuses, even if the application is bypassed")
        err = sql_refusal("impex_purchasing", f"UPDATE goods_receipts SET notes = 'edited' WHERE id = '{r1['id']}'")
        check("a confirmed receipt cannot be edited", "can never be changed" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE goods_receipts SET status = 'draft' WHERE id = '{r1['id']}'")
        check("...cannot go back to draft", "can never be changed" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"DELETE FROM goods_receipts WHERE id = '{r1['id']}'")
        check("...cannot be deleted", "never deleted" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE goods_receipt_lines SET accepted_quantity = 99 WHERE goods_receipt_id = '{r1['id']}'")
        check("...and its lines are frozen", "frozen" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"DELETE FROM goods_receipt_lines WHERE goods_receipt_id = '{r1['id']}'")
        check("...and cannot be removed", "cannot be removed" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE purchase_orders SET status = 'ordered' WHERE id = '{po1['id']}'")
        check("a Received order cannot go back to Ordered", "cannot become" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now() WHERE id = '{po2['id']}'")
        check("an order with goods received cannot be cancelled even by SQL", "cannot" in err, err[:120])
        fresh = jbody(portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": acme["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})[1])["order"]
        portal("a", "POST", f"/api/purchasing/purchase-orders/{fresh['id']}/lines", {"productId": a_flour["id"], "quantity": "1", "unitPrice": "1"})
        fresh = order_detail("a", fresh["id"])
        err = sql_refusal("impex_purchasing", f"UPDATE purchase_order_lines SET purchase_order_id = '{fresh['id']}' WHERE id = '{line_of(po1, a_bolt['id'])['id']}'")
        check("(Step 16B correction) a line of an ORDERED order cannot be moved to a draft order", "cannot be moved" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE purchase_order_lines SET purchase_order_id = '{po1['id']}' WHERE id = '{fresh['lines'][0]['id']}'")
        check("...nor a line of a draft order moved into an ordered one", "cannot be moved" in err, err[:120])
        err = sql_refusal("impex_purchasing", f"UPDATE purchase_order_lines SET organization_id = '{org_ids['b']}' WHERE id = '{fresh['lines'][0]['id']}'")
        check("...nor to another organization", "cannot be moved" in err, err[:120])
        lonely = jbody(portal("a", "POST", f"/api/purchasing/goods-receipts", {"purchaseOrderId": po2["id"], "lines": []}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})[1]).get("receipt", {})
        created.add("goods_receipts", lonely.get("id"))
        check("(a receipt against a Received order is refused by the application)", not lonely)
        open_po = place_order("a", acme["id"], [(a_bolt["id"], "5", "1")])
        sql_receipt = draft("a", open_po["id"], [rl(open_po, a_bolt["id"], "5", a_main["id"])])[1]["receipt"]
        err = sql_refusal("impex_purchasing", f"UPDATE goods_receipt_lines SET accepted_quantity = 6 WHERE goods_receipt_id = '{sql_receipt['id']}'; UPDATE goods_receipts SET status = 'posting', posting_started_at = now() WHERE id = '{sql_receipt['id']}'")
        check("the database refuses to reserve more than was ordered (6 of 5)", "exceed" in err, err[:160])
        portal("a", "POST", f"/api/purchasing/goods-receipts/{sql_receipt['id']}/cancel")

        print("\n== 8. prices and history survive")
        after = inventory_state(org_ids["a"])
        check("selling price 9.99, cost price 5, units and archive flags are exactly as before (receiving never touches the catalog)", after[3] == inventory_before["a"][3], (inventory_before["a"][3], after[3]))
        check("the purchase prices stayed on the orders (1.25 / 3.10 / 2.00), unchanged by receiving",
              (line_of(po1, a_bolt["id"])["unit_price"], line_of(po1, a_flour["id"])["unit_price"], line_of(order_detail("a", po2["id"]), a_bolt["id"])["unit_price"]) == ("1.2500", "3.1000", "2.0000") and po1["total_amount"] == "93.5000")
        check("the earlier stock history (opening 40 bolts / 2.5 kg flour) is still there, before the receipt movements",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id = '{org_ids['a']}' AND source_type IS NULL AND movement_type = 'in'") == "2")
        status, html, _ = page("a", "/movements")
        check("the Movements page shows the receipt movements with their reason", status == 200 and "Goods receipt GR-000001" in html, status)
        status, html, _ = page("a", "/stock")
        check("the Stock page shows the new quantities", status == 200 and "GRA steel bolt" in html, status)

        print("\n== 9. the Goods Receipts list")
        s, text, _, _ = portal("a", "GET", "/api/purchasing/goods-receipts?status=confirmed")
        listed = jbody(text)
        check("the list can be filtered by status", s == 200 and all(i["status"] == "confirmed" for i in listed["items"]) and listed["total"] >= 3, listed.get("total"))
        s, text, _, _ = portal("a", "GET", f"/api/purchasing/goods-receipts?warehouseId={a_shelf['id']}")
        check("...by warehouse (GR-000001 put flour in SHELF)", s == 200 and "GR-000001" in text, text[:120])
        s, text, _, _ = portal("a", "GET", f"/api/purchasing/goods-receipts?purchaseOrderId={po1['id']}")
        check("...by purchase order", s == 200 and jbody(text)["total"] >= 2 and all(i["purchase_order"]["number"] == "PO-000001" for i in jbody(text)["items"]))
        s, text, _, _ = portal("a", "GET", "/api/purchasing/goods-receipts?q=DN-1077")
        check("...and searched by the supplier's reference", s == 200 and [i["supplier_reference"] for i in jbody(text)["items"]] == ["DN-1077"], text[:120])
        s, text, _, _ = portal("a", "GET", f"/api/purchasing/goods-receipts?supplierId={acme['id']}&dateFrom=2000-01-01&dateTo=2999-01-01")
        check("...by supplier and date range", s == 200 and jbody(text)["total"] >= 3)
        status, html, _ = page("a", "/goods-receipts")
        check("the Goods Receipts page lists A's receipts and none of B's", status == 200 and "GR-000001" in html and "GR Acme Supplies" in html and "GR Beta Supplier" not in html, status)
        status, html, _ = page("a", f"/goods-receipts/{r1['id']}")
        check("a receipt's page shows the order, the quantities and the stock movement", status == 200 and "GR-000001" in html and "PO-000001" in html and "GRA steel bolt" in html and "Confirmed" in html, status)

        print("\n== 10. the other organization")
        b_draft = draft("b", b_po["id"], [rl(b_po, b_bolt["id"], "5", b_main["id"])])[1]["receipt"]
        check("B prepares its own receipt, numbered GR-000001 too (numbers are per organization)", b_draft.get("number") == "GR-000001")
        for label, method, path, body in (
            ("read", "GET", f"/api/purchasing/goods-receipts/{r1['id']}", None), ("edit", "PATCH", f"/api/purchasing/goods-receipts/{r1['id']}", {"notes": "HIJACK"}),
            ("replace the lines of", "PUT", f"/api/purchasing/goods-receipts/{r1['id']}/lines", {"lines": []}), ("confirm", "POST", f"/api/purchasing/goods-receipts/{r1['id']}/confirm", None),
            ("cancel", "POST", f"/api/purchasing/goods-receipts/{r1['id']}/cancel", None),
        ):
            s, text, _, _ = portal("b", method, path, body)
            missing = portal("b", method, path.replace(r1["id"], str(uuid.uuid4())), body)
            check(f"B cannot {label} A's receipt: 404, exactly like an id that does not exist", s == 404 and (s, jbody(text)) == (missing[0], jbody(missing[1])) and "GRA" not in text, (s, text[:100]))
        s, body = draft("b", po1["id"], [])
        check("B cannot start a receipt against A's order (404)", s == 404, (s, body))
        s, text, _, _ = portal("b", "GET", "/api/purchasing/goods-receipts")
        check("B's list holds only B's receipt", s == 200 and [i["number"] for i in jbody(text)["items"]] == ["GR-000001"] and all("GRA" not in json.dumps(i) for i in jbody(text)["items"]) and jbody(text)["items"][0]["id"] == b_draft["id"])
        s, text, _, _ = portal("b", "GET", f"/api/purchasing/goods-receipts?warehouseId={a_shelf['id']}&purchaseOrderId={po1['id']}")
        check("...and filtering by A's warehouse or order ids finds nothing", s == 200 and jbody(text)["total"] == 0)
        status, html, _ = page("b", f"/goods-receipts/{r1['id']}")
        check("B opening A's receipt page sees 'not found'", status == 200 and "Goods receipt not found." in html and "GRA" not in html)
        status, html, _ = page("b", f"/purchase-orders/{po1['id']}/receive")
        check("...and A's Receive Goods page", status == 200 and "Purchase order not found." in html and "GRA" not in html)
        s, text, _, _ = call(PURCHASING, "POST", "/api/v1/purchasing/goods-receipts", {"purchase_order_id": po1["id"], "organization_id": org_ids["a"]}, {**bearer(tokens["b"]), "Idempotency-Key": f"hack-{uuid.uuid4()}"})
        check("an organization_id in a request body is rejected by the service (422)", s == 422, (s, text[:100]))
        s, _, _, _ = call(PURCHASING, "GET", f"/api/v1/purchasing/goods-receipts?organization_id={org_ids['a']}", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a query parameter and header naming A change nothing for B", s == 200)
        check("B's stock is exactly as it was (99), A's receipts never reached it", quantity(b_bolt["id"], b_main["id"]) == Decimal("99") and inventory_state(org_ids["b"]) == inventory_before["b"])
        err = sql_refusal("impex_purchasing", f"INSERT INTO goods_receipts (organization_id, purchase_order_id, number, received_date, posting_key, created_by, created_by_email) VALUES ('{org_ids['b']}', '{po1['id']}', 'GR-777777', current_date, 'goods-receipt-x', '{uuid.uuid4()}', 'x@x')")
        check("the database refuses a receipt that points at another organization's order", "violates" in err or "Ordered or Partially Received" in err, err[:140])
        s, _, _, _ = call(PURCHASING, "GET", "/api/v1/purchasing/goods-receipts", headers=bearer(sa_token))
        check("a Super Admin gets 403 from the receipts API; no token -> 401", s == 403 and call(PURCHASING, "GET", "/api/v1/purchasing/goods-receipts")[0] == 401)
        for path in ("/goods-receipts", f"/goods-receipts/{r1['id']}", f"/purchase-orders/{po1['id']}/receive"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path)
            check(f"{path} without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        check("an inactive organization cannot confirm (403) and its page explains", confirm("b", b_draft["id"])[0] == 403 and "currently inactive or unavailable" in page("b", "/goods-receipts")[1])
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("...reactivating restores it, and B can receive normally (200)", confirm("b", b_draft["id"])[0] == 200 and quantity(b_bolt["id"], b_main["id"]) == Decimal("104"))

        print("\n== 11. interrupted between the two services")
        po3 = place_order("a", acme["id"], [(a_bolt["id"], "30", "1")])
        shelf_before = quantity(a_bolt["id"], a_shelf["id"])
        crash1 = draft("a", po3["id"], [rl(po3, a_bolt["id"], "10", a_shelf["id"])])[1]["receipt"]
        out = psql_with_errors("impex_purchasing", f"UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{crash1['id']}'")
        s, r = receipt_detail("a", crash1["id"])
        check("SIMULATED CRASH after the intent was saved but before Inventory was called: the receipt is 'posting', the quantity is reserved, no stock moved",
              r.get("status") == "posting" and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before and line_of(order_detail("a", po3["id"]), a_bolt["id"])["pending_quantity"] == "10.0000", (out, r.get("status")))
        s, body = confirm("a", crash1["id"])
        check("a retry finishes it: confirmed (200), 10 bolts added once", s == 200 and body["receipt"]["status"] == "confirmed" and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 10, (s, body))
        crash2 = draft("a", po3["id"], [rl(po3, a_bolt["id"], "8", a_shelf["id"])])[1]["receipt"]
        psql("impex_purchasing", f"UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{crash2['id']}'")
        full = receipt_detail("a", crash2["id"])[1]
        committed_body = {"receipt_number": full["number"], "purchase_order_number": po3["number"], "lines": [
            {"line_id": full["lines"][0]["id"], "product_id": a_bolt["id"], "warehouse_id": a_shelf["id"], "quantity": "8", "unit": "pcs"}]}
        s, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/goods-receipts", committed_body, {**bearer(tokens["a"]), "Idempotency-Key": f"goods-receipt-{crash2['id']}"})
        check("SIMULATED CRASH after Inventory committed but before Purchasing recorded it: Inventory has the 8 bolts, the receipt is still 'posting'",
              s == 201 and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 18 and receipt_detail("a", crash2["id"])[1].get("status") == "posting", s)
        s, body = confirm("a", crash2["id"])
        check("a retry verifies the earlier posting and confirms WITHOUT adding the 8 bolts again", s == 200 and body["receipt"]["status"] == "confirmed" and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 18 and
              all(l["inventory_movement_id"] for l in body["receipt"]["lines"]), (s, quantity(a_bolt["id"], a_shelf["id"])))
        check("...the order progressed: 18 of 30 received, Partially Received", order_detail("a", po3["id"])["status"] == "partially_received" and line_of(order_detail("a", po3["id"]), a_bolt["id"])["received_quantity"] == "18.0000")
        check("...the order has exactly 2 confirmed receipts and the movements match", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_type = 'goods_receipt' AND product_id = '{a_bolt['id']}' AND warehouse_id = '{a_shelf['id']}'") == "3")

        if args.with_outage:
            print("\n== 12. service outages")
            outage = draft("a", po3["id"], [rl(po3, a_bolt["id"], "5", a_shelf["id"])])[1]["receipt"]
            docker("compose", "stop", "inventory-service")
            try:
                s, body = confirm("a", outage["id"])
                check("confirming while the Inventory Service is down answers 503 with a clear message; the receipt stays an editable draft", s == 503 and "inventory" in body.get("error", "").lower() and receipt_detail("a", outage["id"])[1].get("status") == "draft", (s, body))
                check("viewing receipts and orders still works", page("a", "/goods-receipts")[0] == 200 and receipt_detail("a", outage["id"])[0] == 200)
                psql("impex_purchasing", f"UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{outage['id']}'")
                s, body = confirm("a", outage["id"])
                check("a receipt already 'posting' while Inventory is down answers 202 (not confirmed, not lost), with the reason on the receipt",
                      s == 202 and body.get("confirmed") is False and body["receipt"]["status"] == "posting" and body["receipt"]["posting"]["last_error"], (s, body))
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            s, r = receipt_detail("a", outage["id"])
            check("while Inventory was down nothing was added", quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 18 and r.get("status") == "posting")
            s, body = confirm("a", outage["id"])
            check("once it is back, the retry confirms (200) and adds the 5 bolts exactly once", s == 200 and body["receipt"]["status"] == "confirmed" and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 23, (s, body))
            restart = draft("a", po3["id"], [rl(po3, a_bolt["id"], "4", a_shelf["id"])])[1]["receipt"]
            psql("impex_purchasing", f"UPDATE goods_receipts SET status = 'posting', posting_started_at = now(), posting_attempts = 1 WHERE id = '{restart['id']}'")
            docker("compose", "restart", "purchasing-service")
            wait_until(PURCHASING, "/health")
            s, r = receipt_detail("a", restart["id"])
            check("after the Purchasing Service restarts, the 'posting' receipt is still there, with its saved intent", s == 200 and r.get("status") == "posting" and r["posting"]["attempts"] == 1, (s, r.get("status")))
            s, body = confirm("a", restart["id"])
            check("...and a retry finishes it (200), adding the 4 bolts once", s == 200 and quantity(a_bolt["id"], a_shelf["id"]) == shelf_before + 27, (s, quantity(a_bolt["id"], a_shelf["id"])))
            docker("compose", "stop", "purchasing-service")
            try:
                s, text, _, _ = portal("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po3["id"]}, {"Idempotency-Key": f"gr-{uuid.uuid4()}"})
                check("creating a receipt while the Purchasing Service is down answers 503", s == 503, (s, text[:100]))
                status, html, _ = page("a", "/goods-receipts")
                check("the Goods Receipts page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html, status)
                check("products and stock are unaffected", page("a", "/stock")[0] == 200)
            finally:
                docker("compose", "start", "purchasing-service")
                wait_until(PURCHASING, "/health")
            check("the Purchasing Service is back", page("a", "/goods-receipts")[0] == 200)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")

        print("\n== 13. one last look: inventory equals what the CONFIRMED receipts say")
        for org in ("a", "b"):
            expected = psql("impex_purchasing", f"SELECT coalesce(string_agg(l.product_id || ':' || l.warehouse_id || ':' || s::text, ',' ORDER BY l.product_id, l.warehouse_id), '') FROM (SELECT rl.product_id, rl.warehouse_id, sum(rl.accepted_quantity) AS s FROM goods_receipt_lines rl JOIN goods_receipts r ON r.id = rl.goods_receipt_id WHERE r.organization_id = '{org_ids[org]}' AND r.status = 'confirmed' AND rl.accepted_quantity > 0 GROUP BY rl.product_id, rl.warehouse_id) l")
            posted = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || warehouse_id || ':' || s::text, ',' ORDER BY product_id, warehouse_id), '') FROM (SELECT product_id, warehouse_id, sum(quantity) AS s FROM stock_movements WHERE organization_id = '{org_ids[org]}' AND source_type = 'goods_receipt' AND source_reference LIKE 'GR-0%' GROUP BY product_id, warehouse_id) m")
            check(f"organization {org.upper()}: the goods the confirmed receipts accepted are exactly the goods added to stock, per product and warehouse", expected == posted, (expected, posted))
        check("no receipt is left half-way (nothing 'posting')", psql("impex_purchasing", f"SELECT count(*) FROM goods_receipts WHERE status = 'posting' AND organization_id IN ('{org_ids['a']}', '{org_ids['b']}')") == "0")
        check("the catalog prices of both organizations are still exactly as they were", {k: inventory_state(org_ids[k])[3] for k in ("a", "b")} == {k: inventory_before[k][3] for k in ("a", "b")})
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "receipt lines": delete_exact(psql, "impex_purchasing", "goods_receipt_lines", orgs, "organization_id", ledger=True),
            "receipt requests": delete_exact(psql, "impex_purchasing", "goods_receipt_requests", orgs, "organization_id"),
            "receipts": delete_exact(psql, "impex_purchasing", "goods_receipts", orgs, "organization_id", ledger=True),
            "receipt counters": delete_exact(psql, "impex_purchasing", "goods_receipt_counters", orgs, "organization_id"),
            "order lines": delete_exact(psql, "impex_purchasing", "purchase_order_lines", orgs, "organization_id", ledger=True),
            "order requests": delete_exact(psql, "impex_purchasing", "purchase_order_requests", orgs, "organization_id"),
            "orders": delete_exact(psql, "impex_purchasing", "purchase_orders", orgs, "organization_id", ledger=True),
            "order counters": delete_exact(psql, "impex_purchasing", "purchase_order_counters", orgs, "organization_id"),
            "suppliers": delete_exact(psql, "impex_purchasing", "suppliers", orgs, "organization_id"),
            "movements": delete_exact(psql, "impex_inventory", "stock_movements", orgs, "organization_id", ledger=True),
            "balances": delete_exact(psql, "impex_inventory", "stock_balances", orgs, "organization_id"),
            "operations": delete_exact(psql, "impex_inventory", "stock_operations", orgs, "organization_id"),
            "warehouses": delete_exact(psql, "impex_inventory", "warehouses", created.get("warehouses")),
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
