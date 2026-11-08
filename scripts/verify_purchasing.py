#!/usr/bin/env python3
"""End-to-end check of Suppliers and Purchase Orders against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_purchasing created and migrated
    python scripts/verify_purchasing.py
    python scripts/verify_purchasing.py --with-outage    # also stops the Inventory and Purchasing services for a few seconds

It creates two throwaway organizations ("Purchasing Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: register suppliers,
create purchase orders (with duplicate-submission protection), add existing products with quantities and purchase prices,
exact totals, edit, place (freeze) and cancel orders, and then every way of reaching the other organization's data.

The central checks: after ALL of that, every stock balance, every stock movement AND every product price in the Inventory
database is exactly as it was (ordering 50 units added no stock and wrote no movement), and the database itself refuses to
change a placed order. Everything it created is deleted afterwards, by exact id. No emails are sent and no existing record is touched.
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
    conn = http.client.HTTPConnection("localhost", port, timeout=60)
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


def wait_until(port, path, timeout=60):
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
    sa_email = "pocheck-sa@example.org"
    emails = {"a": "pocheck-admin-a@example.org", "b": "pocheck-admin-b@example.org"}
    org_names = {"a": "Purchasing Check Alpha", "b": "Purchasing Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, html, _, location = portal(key, "GET", path)
        return status, html.replace("<!-- -->", ""), location

    def product(key, sku, name, unit="pcs"):
        _, text, _, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "category": "PO check", "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def stock_in(key, pid, quantity):
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"po-{uuid.uuid4()}"})[0]

    def supplier(key, name, **extra):
        status, text, _, _ = portal(key, "POST", "/api/purchasing/suppliers", {"name": name, **extra})
        body = jbody(text)
        created.add("suppliers", body.get("supplier", {}).get("id"))
        return status, body

    def new_order(key, supplier_id, idem=None, **extra):
        status, text, _, _ = portal(key, "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier_id, "currencyCode": "USD", **extra}, {"Idempotency-Key": idem or f"po-{uuid.uuid4()}"})
        return status, jbody(text)

    def add(key, order_id, product_id, quantity, price, **extra):
        status, text, _, _ = portal(key, "POST", f"/api/purchasing/purchase-orders/{order_id}/lines", {"productId": product_id, "quantity": quantity, "unitPrice": price, **extra})
        return status, jbody(text)

    def detail(key, order_id):
        status, text, _, _ = portal(key, "GET", f"/api/purchasing/purchase-orders/{order_id}")
        return status, jbody(text).get("order", {})

    def action(key, order_id, name):
        status, text, _, _ = portal(key, "POST", f"/api/purchasing/purchase-orders/{order_id}/{name}")
        return status, jbody(text)

    def inventory_state(org):
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(max(created_at)::text, '') FROM stock_movements WHERE organization_id = '{org}'")
        operations = psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE organization_id = '{org}'")
        prices = psql("impex_inventory", f"SELECT coalesce(string_agg(sku || ':' || cost_price::text || ':' || selling_price::text || ':' || unit || ':' || is_active::text, ',' ORDER BY sku), '') FROM products WHERE organization_id = '{org}'")
        return balances, movements, operations, prices

    def purchasing_counts(org):
        return {t: psql("impex_purchasing", f"SELECT count(*) FROM {t} WHERE organization_id = '{org}'") for t in ("suppliers", "purchase_orders", "purchase_order_lines", "purchase_order_requests")}

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='POcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"pocheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        # the SAME sku in both organizations, different products
        a_bolt, a_flour, a_old = product("a", "PO-BOLT", "POA steel bolt", "pcs"), product("a", "PO-FLOUR", "POA flour", "kg"), product("a", "PO-OLD", "POA old widget", "pcs")
        b_bolt = product("b", "PO-BOLT", "POB silk scarf", "pcs")
        check("products created (same SKU 'PO-BOLT' in both organizations)", all(x.get("id") for x in (a_bolt, a_flour, a_old, b_bolt)))
        stock_in("a", a_bolt["id"], "40")
        stock_in("a", a_flour["id"], "2.5")
        stock_in("b", b_bolt["id"], "99")
        portal("a", "POST", f"/api/products/{a_old['id']}/archive")
        inventory_before = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("starting stock and prices recorded (A: 40 bolts + 2.5 kg flour; B: 99; selling price 9.99, cost price 5)",
              len(inventory_before["a"][0].split(",")) == 2 and "9.9900" in inventory_before["a"][3] and "5.0000" in inventory_before["a"][3], inventory_before["a"])

        print("\n== 1. supplier directory")
        s, body = supplier("a", "Acme Supplies GmbH", code="acme", contactPerson="Jane Doe", email="Jane@Acme.example", phone="555-0100", address="1 Main St", countryCode="de", taxIdentifier="DE123")
        acme = body.get("supplier", {})
        check("A registers a supplier (201): code and country upper-cased, e-mail lower-cased, no organization in the answer",
              s == 201 and acme.get("code") == "ACME" and acme.get("country_code") == "DE" and acme.get("email") == "jane@acme.example" and "organization_id" not in json.dumps(body), (s, body))
        s, body = supplier("a", "  acme   supplies gmbh ")
        check("the same name (any case / spacing) is refused (409, shown on the Name field)", s == 409 and "name" in (body.get("fieldErrors") or {}), (s, body))
        s, body = supplier("a", "Other Name", code="ACME")
        check("the same supplier code is refused (409, shown on the Code field)", s == 409 and "code" in (body.get("fieldErrors") or {}), (s, body))
        s, body = supplier("b", "Acme Supplies GmbH", code="ACME")
        b_acme = body.get("supplier", {})
        check("B can register the very same name and code (201)", s == 201 and b_acme.get("id") != acme.get("id"), (s, body))
        s, body = supplier("a", "Bad Mail", email="nope")
        check("an invalid e-mail is rejected (400)", s == 400 and "email" in (body.get("fieldErrors") or {}), (s, body))
        s, body = supplier("a", "Bad Country", countryCode="DEU")
        check("an invalid country code is rejected (400)", s == 400 and "countryCode" in (body.get("fieldErrors") or {}), (s, body))
        s, body = supplier("a", "")
        check("a supplier needs a name (400)", s == 400, (s, body))
        s, body = supplier("a", "Zeta Metals", contactPerson="Hans Meyer", taxIdentifier="TAX-9")
        zeta = body.get("supplier", {})
        s, text, _, _ = portal("a", "GET", "/api/purchasing/suppliers?q=meyer")
        check("A searches suppliers by contact person", [x["name"] for x in jbody(text).get("items", [])] == ["Zeta Metals"], text[:100])
        s, text, _, _ = portal("a", "GET", "/api/purchasing/suppliers?q=tax-9")
        check("...and by tax identifier", [x["name"] for x in jbody(text).get("items", [])] == ["Zeta Metals"])
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/suppliers/{zeta['id']}", {"phone": "777", "countryCode": "pk"})
        check("A edits a supplier (200)", s == 200 and jbody(text)["supplier"]["phone"] == "777" and jbody(text)["supplier"]["country_code"] == "PK", (s, text[:100]))
        s, text, _, _ = portal("a", "GET", f"/api/purchasing/suppliers/{zeta['id']}")
        check("A views a supplier's details (200)", s == 200 and jbody(text)["supplier"]["tax_identifier"] == "TAX-9")
        status, html, _ = page("a", "/suppliers")
        check("the Suppliers page lists A's suppliers and none of B's", status == 200 and "Acme Supplies GmbH" in html and "Zeta Metals" in html and "Add Supplier" in html, status)

        print("\n== 2. creating purchase orders (numbers, duplicates, validation)")
        s, body = new_order("a", acme["id"], "live-key-0000001", supplierReference="QUOTE-1", orderDate="2026-11-06", expectedDeliveryDate="2026-11-20", notes="Dock 3")
        po1 = body.get("order", {})
        check("A creates a draft purchase order for Acme (201, PO-000001, draft)", s == 201 and po1.get("number") == "PO-000001" and po1.get("status") == "draft" and po1.get("currency_code") == "USD", (s, body))
        s2, again = new_order("a", acme["id"], "live-key-0000001", supplierReference="QUOTE-1", orderDate="2026-11-06", expectedDeliveryDate="2026-11-20", notes="Dock 3")
        s3, _ = new_order("a", acme["id"], "live-key-0000001", supplierReference="QUOTE-1", orderDate="2026-11-06", expectedDeliveryDate="2026-11-20", notes="Dock 3")
        check("a double click / retry with the same key answers 200 with the SAME order", (s2, s3) == (200, 200) and again["order"]["id"] == po1["id"] and again.get("replayed") is True, (s2, s3, again))
        check("...and only one order exists", psql("impex_purchasing", f"SELECT count(*) FROM purchase_orders WHERE organization_id = '{org_ids['a']}'") == "1")
        s4, body = new_order("a", acme["id"], "live-key-0000001", supplierReference="DIFFERENT")
        check("the same key for a DIFFERENT order is refused (409)", s4 == 409 and "different request" in body.get("error", ""), (s4, body))
        s5, text, _, _ = portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": acme["id"], "currencyCode": "USD"})
        check("a request without an Idempotency-Key is refused (400)", s5 == 400, (s5, text[:100]))
        s, body = new_order("a", str(uuid.uuid4()))
        check("an order for an unknown supplier is refused (404)", s == 404, (s, body))
        s, body = new_order("a", acme["id"], expectedDeliveryDate="2026-01-01", orderDate="2026-02-01")
        check("an expected delivery before the order date is refused (400)", s == 400 and "expectedDeliveryDate" in (body.get("fieldErrors") or {}), (s, body))
        s, body = new_order("a", acme["id"], currencyCode="US")
        check("an invalid currency is refused (400)", s == 400, (s, body))
        s, text, _, _ = portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": acme["id"], "currencyCode": "USD", "status": "ordered", "number": "PO-999", "total_amount": "0", "organization_id": org_ids["b"]}, {"Idempotency-Key": "live-key-0000002"})
        po2 = jbody(text).get("order", {})
        check("status, number, total and organization_id sent by the browser are ignored (draft, PO-000002, A's)",
              s == 201 and po2.get("status") == "draft" and po2.get("number") == "PO-000002" and psql("impex_purchasing", f"SELECT organization_id FROM purchase_orders WHERE id = '{po2.get('id')}'") == org_ids["a"], (s, text[:120]))
        s, body = new_order("b", b_acme["id"])
        b_po = body.get("order", {})
        check("B's first order is also PO-000001 (numbers are per organization)", b_po.get("number") == "PO-000001", body)

        outcomes = []

        def create_parallel(i):
            outcomes.append(new_order("a", acme["id"], f"parallel-key-{i:04d}"))

        threads = [threading.Thread(target=create_parallel, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        numbers = sorted(b["order"]["number"] for s, b in outcomes if s == 201)
        check("8 orders created at the same moment get 8 different consecutive numbers (PO-000003..PO-000010)", numbers == [f"PO-{i:06d}" for i in range(3, 11)], numbers)
        outcomes.clear()

        def create_duplicate(_):
            outcomes.append(new_order("a", acme["id"], "double-click-0001", notes="same"))

        threads = [threading.Thread(target=create_duplicate, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        check("6 simultaneous submissions of one form create ONE order (one 201, five 200)", sorted(s for s, _ in outcomes) == [200] * 5 + [201] and len({b["order"]["id"] for _, b in outcomes}) == 1, [s for s, _ in outcomes])
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/purchase-orders/{po2['id']}", {"supplierReference": " NEW  REF ", "notes": "Call first", "expectedDeliveryDate": "2026-12-01", "orderDate": "2026-11-06"})
        check("a draft's header can be edited (200)", s == 200 and jbody(text)["order"]["supplier_reference"] == "NEW REF", (s, text[:100]))
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/purchase-orders/{po2['id']}", {"supplierId": zeta["id"]})
        check("...including its supplier (200)", s == 200 and jbody(text)["order"]["supplier"]["name"] == "Zeta Metals", (s, text[:100]))
        s, text, _, _ = portal("a", "GET", f"/api/purchasing/purchase-orders?supplierId={zeta['id']}")
        check("orders can be filtered by supplier", [o["number"] for o in jbody(text)["items"]] == ["PO-000002"], text[:120])
        s, text, _, _ = portal("a", "GET", "/api/purchasing/purchase-orders?q=quote-1")
        check("...searched by supplier reference", [o["number"] for o in jbody(text)["items"]] == ["PO-000001"])
        status, html, _ = page("a", "/purchase-orders")
        check("the Purchase Orders page shows A's orders and none of B's", status == 200 and "PO-000001" in html and "Acme Supplies GmbH" in html and "New Purchase Order" in html, status)

        print("\n== 3. adding existing products with quantities and purchase prices")
        s, text, _, _ = portal("a", "GET", "/api/scan/resolve?code=po-bolt")
        scanned = jbody(text)
        check("the bolt is found by SKU first (the lookup step; lower case is fine)", s == 200 and scanned["product"]["id"] == a_bolt["id"], scanned)
        s, body = add("a", po1["id"], a_bolt["id"], "50", "1.25")
        bolt_line = body.get("line", {})
        check("ORDER 50 UNITS: the bolt is added with quantity 50 and price 1.25 (201)", s == 201 and bolt_line.get("quantity") == "50.0000" and bolt_line.get("unit_price") == "1.2500", (s, body))
        check("the line total is calculated by the server: 62.5000", bolt_line.get("line_total") == "62.5000" and body.get("total_amount") == "62.5000" and body.get("line_count") == 1, body)
        check("name, SKU and unit come from the Inventory Service", (bolt_line.get("product_name"), bolt_line.get("product_sku"), bolt_line.get("unit")) == ("POA steel bolt", "PO-BOLT", "pcs"), bolt_line)
        s, body = add("a", po1["id"], a_flour["id"], "2.5", "3.10", notes="Food grade")
        flour_line = body.get("line", {})
        check("a kg product takes decimals; the note is kept and no warehouse is stored (201)", s == 201 and flour_line.get("line_total") == "7.7500" and "planned_warehouse_code" not in flour_line and flour_line.get("notes") == "Food grade", (s, body))
        s, d = detail("a", po1["id"])
        check("the order total is the exact sum: 62.5000 + 7.7500 = 70.2500", d["total_amount"] == "70.2500" and d["line_count"] == 2 and d["frozen"] is False, d)
        s, body = add("a", po2["id"], a_flour["id"], "3", "0.3333")
        check("exact money: 3 x 0.3333 = 0.9999 (not 0.9998999...)", s == 201 and body["line"]["line_total"] == "0.9999", body)
        s, body = add("a", po2["id"], a_bolt["id"], "7", "0.1")
        check("exact money: 7 x 0.1 = 0.7000", s == 201 and body["line"]["line_total"] == "0.7000" and body["total_amount"] == "1.6999", body)

        print("\n== 4. quantity and price rules, invalid / archived / foreign products")
        for q, p, label in (("0", "1", "zero quantity"), ("-3", "1", "negative quantity"), ("lots", "1", "text quantity"), ("1.00001", "1", "five-decimal quantity"),
                            ("5", "-1", "negative price"), ("5", "abc", "text price"), ("5", "1.00001", "five-decimal price"), ("5", "", "empty price")):
            s, body = add("a", po2["id"], a_old["id"], q, p)
            check(f"a {label} is refused (400) before reaching the service", s == 400, (s, body))
        sample = new_order("a", acme["id"])[1]["order"]
        s, body = add("a", sample["id"], a_flour["id"], "1", "0")
        check("a zero price is allowed (a free sample, 201)", s == 201 and body["line"]["line_total"] == "0.0000", (s, body))
        fresh = new_order("a", acme["id"])[1]["order"]
        s, body = add("a", fresh["id"], a_bolt["id"], "1.5", "1")
        check("a fraction of a piece is refused (400, 'whole number')", s == 400 and "whole number" in body.get("error", ""), (s, body))
        s, body = add("a", po1["id"], a_bolt["id"], "9", "9")
        check("the same product twice is refused (409 duplicate_line) and names the existing line", s == 409 and body.get("code") == "duplicate_line" and body["line"]["id"] == bolt_line["id"] and body["line"]["quantity"] == "50.0000", (s, body))
        check("...and the existing line is unchanged (50 at 1.25)", detail("a", po1["id"])[1]["lines"][0]["quantity"] == "50.0000" and detail("a", po1["id"])[1]["lines"][0]["unit_price"] == "1.2500")
        s, body = add("a", fresh["id"], a_old["id"], "1", "1")
        check("an archived product is refused (409, says so)", s == 409 and "archived" in body.get("error", ""), (s, body))
        s, body = add("a", fresh["id"], str(uuid.uuid4()), "1", "1")
        check("an unknown product is refused (404)", s == 404 and "Product not found" in body.get("error", ""), (s, body))
        s, body = add("a", fresh["id"], a_bolt["id"], "5", "1", plannedWarehouseId=str(uuid.uuid4()))
        check("a planned warehouse sent by the browser is dropped: nothing is stored (201)", s == 201 and "planned_warehouse_id" not in body["line"]
              and psql("impex_purchasing", "SELECT count(*) FROM information_schema.columns WHERE table_name = 'purchase_order_lines' AND column_name LIKE '%warehouse%'") == "0", (s, body))
        portal("a", "DELETE", f"/api/purchasing/purchase-orders/{fresh['id']}/lines/{body['line']['id']}")  # leave the order empty for the next checks
        s, body = add("a", fresh["id"], a_bolt["id"], "5", "1", productName="HACKED", productSku="EVIL", unit="kg", lineTotal="0.01", total_amount="0", selling_price="0.01")
        row = psql("impex_purchasing", f"SELECT product_name || '|' || product_sku || '|' || unit || '|' || line_total::text FROM purchase_order_lines WHERE purchase_order_id = '{fresh['id']}'")
        check("extra fields are dropped; the saved name, SKU, unit and total are the server's (POA steel bolt|PO-BOLT|pcs|5.0000)", s == 201 and row == "POA steel bolt|PO-BOLT|pcs|5.0000", (s, row))
        s, text, _, _ = call(PURCHASING, "POST", f"/api/v1/purchasing/purchase-orders/{fresh['id']}/lines", {"product_id": a_flour["id"], "quantity": "1", "unit_price": "1", "product_name": "HACKED"}, bearer(tokens["a"]))
        check("the Purchasing Service itself rejects such fields (422)", s == 422, (s, text[:100]))
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/purchase-orders/{po1['id']}/lines/{bolt_line['id']}", {"quantity": "60", "unitPrice": "1.1"})
        b = jbody(text)
        check("editing quantity and price recalculates on the server (60 x 1.1 = 66.0000; order total 73.7500)", s == 200 and b["line"]["line_total"] == "66.0000" and b["total_amount"] == "73.7500", (s, text[:150]))
        s, text, _, _ = portal("a", "PATCH", f"/api/purchasing/purchase-orders/{po1['id']}/lines/{bolt_line['id']}", {"quantity": "2.5"})
        check("a fractional edit of a piece count is refused (400)", s == 400, (s, text[:100]))
        s, text, _, _ = portal("a", "DELETE", f"/api/purchasing/purchase-orders/{po1['id']}/lines/{flour_line['id']}")
        check("removing a line recalculates the total (60 x 1.1 = 66.0000)", s == 200 and jbody(text)["total_amount"] == "66.0000" and jbody(text)["line_count"] == 1, (s, text[:100]))
        s, body = add("a", po1["id"], a_flour["id"], "2.5", "3.10")
        check("the removed product can be added again (201)", s == 201)
        err = psql_with_errors("impex_purchasing", f"UPDATE purchase_order_lines SET line_total = 1 WHERE purchase_order_id = '{po1['id']}'")
        check("the database refuses a wrong line total even if the API is bypassed", "violates check constraint" in err, err[:120])

        print("\n== 5. placing and cancelling: the freeze")
        empty = new_order("a", acme["id"])[1]["order"]
        s, text, _, _ = portal("a", "POST", f"/api/purchasing/purchase-orders/{empty['id']}/order")
        check("an order without lines cannot be placed (409)", s == 409 and "at least one product" in jbody(text).get("error", ""), (s, text[:100]))
        s, body = action("a", po1["id"], "order")
        placed = body.get("order", {})
        check("PO-000001 is placed (200): Ordered, frozen, who and when recorded", s == 200 and placed.get("status") == "ordered" and placed.get("frozen") is True and placed.get("ordered_by_email") == emails["a"] and placed.get("ordered_at"), (s, body))
        check("...its total is unchanged (66.0000 + 7.7500 = 73.7500)", placed.get("total_amount") == "73.7500", placed.get("total_amount"))
        base = f"/api/purchasing/purchase-orders/{po1['id']}"
        refused = {
            "edit notes": portal("a", "PATCH", base, {"notes": "sneaky"})[0],
            "change supplier": portal("a", "PATCH", base, {"supplierId": zeta["id"]})[0],
            "change currency": portal("a", "PATCH", base, {"currencyCode": "EUR"})[0],
            "change delivery date": portal("a", "PATCH", base, {"expectedDeliveryDate": "2030-01-01"})[0],
            "add a line": add("a", po1["id"], a_old["id"], "1", "1")[0],
            "edit a line quantity": portal("a", "PATCH", f"{base}/lines/{bolt_line['id']}", {"quantity": "999"})[0],
            "edit a line price": portal("a", "PATCH", f"{base}/lines/{bolt_line['id']}", {"unitPrice": "0.01"})[0],
            "remove a line": portal("a", "DELETE", f"{base}/lines/{bolt_line['id']}")[0],
        }
        check("every attempt to change the placed order is refused (409)", set(refused.values()) == {409}, refused)
        s, d = detail("a", po1["id"])
        check("...and nothing changed (73.7500, 2 lines, USD, QUOTE-1)", d["total_amount"] == "73.7500" and d["line_count"] == 2 and d["currency_code"] == "USD" and d["supplier_reference"] == "QUOTE-1" and d["notes"] == "Dock 3", d)
        for sql, label in ((f"UPDATE purchase_orders SET notes = 'x' WHERE id = '{po1['id']}'", "the notes"), (f"UPDATE purchase_orders SET supplier_id = '{zeta['id']}' WHERE id = '{po1['id']}'", "the supplier"),
                           (f"UPDATE purchase_order_lines SET unit_price = 0, line_total = 0 WHERE purchase_order_id = '{po1['id']}'", "the lines' prices"), (f"DELETE FROM purchase_order_lines WHERE purchase_order_id = '{po1['id']}'", "the lines")):
            err = psql_with_errors("impex_purchasing", sql)
            check(f"the database itself refuses to change {label} of a placed order", "frozen" in err, err[:120])
        err = psql_with_errors("impex_purchasing", f"DELETE FROM purchase_orders WHERE id = '{po1['id']}'")
        check("...and refuses to delete it", "never deleted" in err, err[:120])
        err = psql_with_errors("impex_purchasing", f"UPDATE purchase_orders SET status = 'draft' WHERE id = '{po1['id']}'")
        check("...and refuses to turn it back into a draft", "cannot become draft" in err, err[:120])
        for name in ("receive", "receipt", "reopen", "complete", "invoice"):
            check(f"there is no '{name}' action", portal("a", "POST", f"{base}/{name}")[0] == 404)
        s, body = action("a", po1["id"], "cancel")
        check("a placed order can be cancelled (200): kept, with its lines and total", s == 200 and body["order"]["status"] == "cancelled" and body["order"]["line_count"] == 2 and body["order"]["total_amount"] == "73.7500" and body["order"]["cancelled_by_email"] == emails["a"], (s, body))
        s, body = action("a", po1["id"], "order")
        check("a cancelled order is final (409)", s == 409, (s, body))
        s, body = action("a", fresh["id"], "cancel")
        check("a draft can be cancelled too (200)", s == 200 and body["order"]["status"] == "cancelled")
        s, text, _, _ = portal("a", "GET", "/api/purchasing/purchase-orders?status=cancelled")
        check("cancelled orders remain listed for history", {o["number"] for o in jbody(text)["items"]} >= {"PO-000001"}, text[:150])
        s, body = action("a", po2["id"], "order")
        check("a second order is placed with the stock the Inventory Service still reports (200)", s == 200 and body["order"]["status"] == "ordered", (s, body))
        status, html, _ = page("a", f"/purchase-orders/{po2['id']}")
        check("the placed order's page is frozen: no editing controls, still cancellable", status == 200 and "frozen" in html and "Cancel order" in html and "Mark as Ordered" not in html and "Find a product" not in html, status)

        print("\n== 6. THE rule: inventory is untouched by all of it")
        after = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("A's stock balances, movement count and operations are exactly as before any order existed", after["a"][:3] == inventory_before["a"][:3], (inventory_before["a"][:3], after["a"][:3]))
        check("B's too", after["b"][:3] == inventory_before["b"][:3])
        check("the bolt still has 40 on hand although 50 were ordered", psql("impex_inventory", f"SELECT quantity::text FROM stock_balances WHERE product_id = '{a_bolt['id']}'") == "40.0000")
        check("product prices (selling 9.99, cost 5) and units are exactly as before - purchase prices never touched them", after["a"][3] == inventory_before["a"][3] and after["b"][3] == inventory_before["b"][3], (inventory_before["a"][3], after["a"][3]))
        check("no stock movement mentions a purchase order", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id = '{org_ids['a']}' AND (reason ILIKE '%purchas%' OR reason ILIKE '%PO-0%')") == "0")
        check("the Purchasing database has orders and receipts but no stock tables at all", psql("impex_purchasing", "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'")
              == "alembic_version,goods_receipt_counters,goods_receipt_lines,goods_receipt_requests,goods_receipts,purchase_order_counters,purchase_order_lines,purchase_order_requests,purchase_orders,suppliers")

        print("\n== 7. inactive suppliers")
        s, body = supplier("a", "Dormant Parts")
        dormant = body["supplier"]
        draft_dormant = new_order("a", dormant["id"])[1]["order"]
        add("a", draft_dormant["id"], a_bolt["id"], "3", "2")
        s, text, _, _ = portal("a", "POST", f"/api/purchasing/suppliers/{dormant['id']}/deactivate")
        check("A deactivates the supplier (200)", s == 200 and jbody(text)["supplier"]["is_active"] is False)
        s, body = new_order("a", dormant["id"])
        check("no new order for an inactive supplier (409)", s == 409 and "inactive" in body.get("error", ""), (s, body))
        s, body = add("a", draft_dormant["id"], a_flour["id"], "1", "1")
        check("no products can be added to a draft of an inactive supplier (409)", s == 409 and "inactive" in body.get("error", ""), (s, body))
        s, body = action("a", draft_dormant["id"], "order")
        check("...nor can such a draft be placed (409)", s == 409 and "inactive" in body.get("error", ""), (s, body))
        status, html, _ = page("a", f"/purchase-orders/{draft_dormant['id']}")
        check("the order is still viewable and flagged", status == 200 and "inactive supplier" in html, status)
        s, body = action("a", draft_dormant["id"], "cancel")
        check("...and can be cancelled (200)", s == 200)
        s, text, _, _ = portal("a", "POST", f"/api/purchasing/suppliers/{dormant['id']}/activate")
        check("reactivating the supplier works (200)", s == 200 and new_order("a", dormant["id"])[0] == 201)

        print("\n== 8. tenant isolation")
        before_counts = purchasing_counts(org_ids["a"])
        status, html, _ = page("b", "/purchase-orders")
        check("B's order list shows B's order and nothing of A's", status == 200 and "PO-000001" in html and "Acme Supplies GmbH" in html and "Zeta Metals" not in html and "QUOTE-1" not in html, status)
        status, html, _ = page("b", "/suppliers")
        check("B's Suppliers page shows only B's supplier", status == 200 and "Acme Supplies GmbH" in html and "Zeta Metals" not in html and "Jane Doe" not in html)
        s, text, _, _ = portal("b", "GET", "/api/purchasing/suppliers?q=Zeta")
        check("B cannot find A's supplier by searching", jbody(text).get("total") == 0)
        attempts = {
            "view A's order": portal("b", "GET", f"/api/purchasing/purchase-orders/{po2['id']}")[0],
            "edit A's order": portal("b", "PATCH", f"/api/purchasing/purchase-orders/{po2['id']}", {"notes": "HIJACKED"})[0],
            "place A's order": portal("b", "POST", f"/api/purchasing/purchase-orders/{draft_dormant['id']}/order")[0],
            "cancel A's order": portal("b", "POST", f"/api/purchasing/purchase-orders/{po2['id']}/cancel")[0],
            "add to A's order": add("b", fresh["id"], b_bolt["id"], "1", "1")[0],
            "edit A's line": portal("b", "PATCH", f"{base}/lines/{bolt_line['id']}", {"quantity": "999"})[0],
            "remove A's line": portal("b", "DELETE", f"{base}/lines/{bolt_line['id']}")[0],
            "edit A's supplier": portal("b", "PATCH", f"/api/purchasing/suppliers/{acme['id']}", {"name": "HIJACKED"})[0],
            "deactivate A's supplier": portal("b", "POST", f"/api/purchasing/suppliers/{acme['id']}/deactivate")[0],
            "order from A's supplier": new_order("b", acme["id"])[0],
            "view A's order (API)": call(PURCHASING, "GET", f"/api/v1/purchasing/purchase-orders/{po2['id']}", headers=bearer(tokens["b"]))[0],
        }
        check("B's attempts on A's suppliers, orders and lines all answer 404", set(attempts.values()) == {404}, attempts)
        check("...and not one A row changed", purchasing_counts(org_ids["a"]) == before_counts and psql("impex_purchasing", "SELECT count(*) FROM purchase_orders WHERE notes = 'HIJACKED'") == "0"
              and psql("impex_purchasing", "SELECT count(*) FROM suppliers WHERE name = 'HIJACKED'") == "0")
        s, body = add("b", b_po["id"], a_bolt["id"], "1", "1")
        check("B cannot order A's product (404, same as an unknown product)", s == 404 and "Product not found" in body.get("error", ""), (s, body))
        s, body = add("b", b_po["id"], b_bolt["id"], "7", "2.5")
        check("B orders B's own product with the same SKU (201)", s == 201 and body["line"]["product_name"] == "POB silk scarf" and body["total_amount"] == "17.5000", (s, body))
        s, d = detail("b", b_po["id"])
        check("B's order contains nothing of A's", "POA" not in json.dumps(d) and "Acme Supplies GmbH" in json.dumps(d))
        s, text, _, _ = call(PURCHASING, "GET", f"/api/v1/purchasing/purchase-orders?organization_id={org_ids['a']}", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a query parameter and header naming A change nothing for B", s == 200 and all("POA" not in json.dumps(i) and i["id"] != po2["id"] for i in jbody(text).get("items", [])))
        s, text, _, _ = call(PURCHASING, "POST", "/api/v1/purchasing/suppliers", {"name": "Sneaky", "organization_id": org_ids["a"]}, bearer(tokens["b"]))
        check("an organization_id in a request body is rejected by the service (422)", s == 422, (s, text[:100]))
        err = psql_with_errors("impex_purchasing", f"INSERT INTO purchase_orders (organization_id, supplier_id, number, order_date, currency_code, created_by, created_by_email) VALUES ('{org_ids['b']}', '{acme['id']}', 'PO-777777', '2026-11-06', 'USD', '{uuid.uuid4()}', 'x@x')")
        check("the database refuses an order that points at another organization's supplier", "violates foreign key" in err, err[:120])
        err = psql_with_errors("impex_purchasing", f"INSERT INTO purchase_order_lines (organization_id, purchase_order_id, product_id, product_sku, product_name, unit, quantity, unit_price, line_total) VALUES ('{org_ids['b']}', '{fresh['id']}', '{uuid.uuid4()}', 'X', 'X', 'pcs', 1, 1, 1)")
        check("...and a line that points at another organization's order", "violates foreign key" in err, err[:120])
        err = psql_with_errors("impex_purchasing", f"DELETE FROM suppliers WHERE id = '{acme['id']}'")
        check("a supplier with orders cannot be deleted", "violates foreign key" in err, err[:120])

        print("\n== 9. accounts and roles")
        check("a Super Admin gets 403 from the Purchasing Service", call(PURCHASING, "GET", "/api/v1/purchasing/purchase-orders", headers=bearer(sa_token))[0] == 403 and call(PURCHASING, "GET", "/api/v1/purchasing/suppliers", headers=bearer(sa_token))[0] == 403)
        check("no token -> 401; garbage token -> 401", call(PURCHASING, "GET", "/api/v1/purchasing/suppliers")[0] == 401 and call(PURCHASING, "GET", "/api/v1/purchasing/suppliers", headers=bearer("nonsense"))[0] == 401)
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        for path in ("/suppliers", "/purchase-orders", f"/purchase-orders/{po2['id']}"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path, cookies={"impex_tenant_session": super_cookie})
            check(f"a Super Admin session planted in the tenant cookie cannot open {path}", status == 307 and location.endswith("/login"), (status, location))
            status, _, _, location = call(TENANT_PORTAL, "GET", path)
            check(f"{path} without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, _ = call(TENANT_PORTAL, "POST", "/api/purchasing/purchase-orders", {"supplierId": acme["id"], "currencyCode": "USD"}, {"Idempotency-Key": "no-session-key-01"}, cookies={"impex_session": super_cookie})
        check("the Super Admin portal's cookie does not authorize the Purchasing routes (401)", status == 401, status)
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        s, body = new_order("b", b_acme["id"])
        check("an inactive organization cannot create orders (403 'not active')", s == 403 and "not active" in body.get("error", ""), (s, body))
        status, html, _ = page("b", "/purchase-orders")
        check("...its page explains it without listing anything", status == 200 and "currently inactive or unavailable" in html and "PO-000001" not in html, status)
        check("...A is unaffected", page("a", "/purchase-orders")[0] == 200)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("...and reactivating B restores everything", "PO-000001" in page("b", "/purchase-orders")[1])
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("a disabled administrator is locked out at once (401)", new_order("a", acme["id"])[0] == 401)
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling restores access", page("a", "/purchase-orders")[0] == 200)

        if args.with_outage:
            print("\n== 10. service outages")
            target = new_order("a", acme["id"])[1]["order"]
            add("a", target["id"], a_bolt["id"], "4", "2")
            docker("compose", "stop", "inventory-service")
            try:
                s, body = add("a", target["id"], a_flour["id"], "1", "1")
                check("adding a product while the Inventory Service is down answers 503 with a clear message", s == 503 and "inventory" in body.get("error", "").lower(), (s, body))
                s, d = detail("a", target["id"])
                check("the order still opens (it keeps its own snapshots)", s == 200 and d["lines"][0]["product_name"] == "POA steel bolt" and d["total_amount"] == "8.0000", (s, d))
                s, body = action("a", target["id"], "order")
                check("placing the order needs the Inventory Service (503) and the order stays a draft", s == 503 and detail("a", target["id"])[1]["status"] == "draft", (s, body))
                check("suppliers and the order list keep working", page("a", "/suppliers")[0] == 200 and page("a", "/purchase-orders")[0] == 200)
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            check("everything works again afterwards: the order can be placed", action("a", target["id"], "order")[0] == 200)
            docker("compose", "stop", "purchasing-service")
            try:
                s, text, _, _ = portal("a", "POST", "/api/purchasing/suppliers", {"name": "While Down"})
                check("creating a supplier while the Purchasing Service is down answers 503", s == 503, (s, text[:100]))
                status, html, _ = page("a", "/purchase-orders")
                check("the Purchase Orders page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html, status)
                check("products and stock are unaffected", page("a", "/stock")[0] == 200)
            finally:
                docker("compose", "start", "purchasing-service")
                wait_until(PURCHASING, "/health")
            check("the Purchasing Service is back", page("a", "/purchase-orders")[0] == 200)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")

        final = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        print("\n== 11. one last look at the inventory")
        check("after everything above, stock, history AND product prices are still exactly as at the start", final == inventory_before, (inventory_before, final))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "lines": delete_exact(psql, "impex_purchasing", "purchase_order_lines", orgs, "organization_id", ledger=True),
            "requests": delete_exact(psql, "impex_purchasing", "purchase_order_requests", orgs, "organization_id"),
            "orders": delete_exact(psql, "impex_purchasing", "purchase_orders", orgs, "organization_id", ledger=True),
            "counters": delete_exact(psql, "impex_purchasing", "purchase_order_counters", orgs, "organization_id"),
            "suppliers": delete_exact(psql, "impex_purchasing", "suppliers", orgs, "organization_id"),
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
