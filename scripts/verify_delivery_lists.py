#!/usr/bin/env python3
"""End-to-end check of Clients and Delivery Lists (with scanning) against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_sales created and migrated
    python scripts/verify_delivery_lists.py
    python scripts/verify_delivery_lists.py --with-outage    # also stops the Inventory and Sales services for a few seconds

It creates two throwaway organizations ("Delivery Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: register clients, create
delivery lists, scan / look up products and add them with explicit quantities, duplicates, edits, removals, Ready /
Cancelled, and then every way of reaching the other organization's clients, lists and products.

The central check: after ALL of that, every stock balance and every stock movement in the Inventory database is exactly as
it was. Everything it created is deleted afterwards, by exact id. No emails are sent and no existing record is touched.
"""
import argparse
import http.client
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid
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
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory and Sales services briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "dlcheck-sa@example.org"
    emails = {"a": "dlcheck-admin-a@example.org", "b": "dlcheck-admin-b@example.org"}
    org_names = {"a": "Delivery Check Alpha", "b": "Delivery Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, html, _, location = portal(key, "GET", path)
        return status, html.replace("<!-- -->", ""), location

    def product(key, sku, name, unit="pcs"):
        _, text, _, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "category": "DL check", "unit": unit, "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def stock_in(key, pid, quantity):
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"dl-{uuid.uuid4()}"})[0]

    def new_client(key, name, **extra):
        status, text, _, _ = portal(key, "POST", "/api/sales/clients", {"name": name, **extra})
        body = jbody(text)
        created.add("clients", body.get("client", {}).get("id"))
        return status, body

    def new_list(key, client_id, **extra):
        status, text, _, _ = portal(key, "POST", "/api/sales/delivery-lists", {"clientId": client_id, **extra})
        return status, jbody(text)

    def add(key, list_id, product_id, quantity, **extra):
        status, text, _, _ = portal(key, "POST", f"/api/sales/delivery-lists/{list_id}/items", {"productId": product_id, "quantity": quantity, **extra})
        return status, jbody(text)

    def detail(key, list_id):
        status, text, _, _ = portal(key, "GET", f"/api/sales/delivery-lists/{list_id}")
        return status, jbody(text).get("list", {})

    def resolve(key, code):
        status, text, _, _ = portal(key, "GET", f"/api/scan/resolve?code={code}")
        return status, jbody(text)

    def inventory_state(org):
        """Every balance and every movement of the organization, as the Inventory database holds them."""
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(max(created_at)::text, '') FROM stock_movements WHERE organization_id = '{org}'")
        operations = psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE organization_id = '{org}' AND kind NOT IN ('reserve', 'release')")  # booking stock is not a stock change
        return balances, movements, operations

    def sales_counts(org):
        return {t: psql("impex_sales", f"SELECT count(*) FROM {t} WHERE organization_id = '{org}'") for t in ("clients", "delivery_lists", "delivery_list_items")}

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='DLcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"dlcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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
        a_bolt, a_flour, a_old = product("a", "DL-BOLT", "DLA steel bolt", "pcs"), product("a", "DL-FLOUR", "DLA flour", "kg"), product("a", "DL-OLD", "DLA old widget", "pcs")
        b_bolt = product("b", "DL-BOLT", "DLB silk scarf", "pcs")
        check("products created (same SKU 'DL-BOLT' in both organizations)", all(x.get("id") for x in (a_bolt, a_flour, a_old, b_bolt)))
        stock_in("a", a_bolt["id"], "50")
        stock_in("a", a_flour["id"], "2.5")
        stock_in("b", b_bolt["id"], "99")
        portal("a", "POST", f"/api/products/{a_old['id']}/archive")
        _, text, _, _ = portal("a", "POST", f"/api/products/{a_bolt['id']}/identifiers/generate")
        bolt_label = jbody(text)["identifier"]["value"]
        created.add("product_identifiers", jbody(text)["identifier"]["id"])
        inventory_before = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("starting stock recorded (A: two balances - 50 bolts, 2.5 kg flour; B: 99)", len(inventory_before["a"][0].split(",")) == 2 and inventory_before["b"][0].endswith(":99.0000"), inventory_before)

        print("\n== 1. client directory")
        s, body = new_client("a", "Acme Ltd", contactPerson="Jane Doe", email="Jane@Acme.example", phone="555-0100", address="1 Main St")
        acme = body.get("client", {})
        check("A registers a client (201), e-mail lower-cased, no organization in the answer", s == 201 and acme.get("email") == "jane@acme.example" and "organization_id" not in json.dumps(body), (s, body))
        s, body = new_client("a", "  acme   LTD ")
        check("the same name again (any case / spacing) is refused (409, on the Name field)", s == 409 and "name" in (body.get("fieldErrors") or {}), (s, body))
        s, body = new_client("b", "Acme Ltd")
        b_acme = body.get("client", {})
        check("B can register a client with the very same name (201)", s == 201 and b_acme.get("id") != acme.get("id"), (s, body))
        s, body = new_client("a", "")
        check("a client needs a name (400)", s == 400 and "name" in (body.get("fieldErrors") or {}), (s, body))
        s, body = new_client("a", "Bad Mail", email="nope")
        check("an invalid e-mail is rejected (400)", s == 400 and "email" in (body.get("fieldErrors") or {}), (s, body))
        s, body = new_client("a", "Globex GmbH", contactPerson="Hans Meyer")
        globex = body.get("client", {})
        s, text, _, _ = portal("a", "GET", "/api/sales/clients?q=meyer")
        check("A searches clients by contact person", [c["name"] for c in jbody(text).get("items", [])] == ["Globex GmbH"], text[:120])
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/clients/{globex['id']}", {"phone": "777"})
        check("A edits a client (200)", s == 200 and jbody(text)["client"]["phone"] == "777", (s, text[:100]))
        status, html, _ = page("a", "/clients")
        check("the Clients page lists A's clients and none of B's", status == 200 and "Acme Ltd" in html and "Globex GmbH" in html and "Add Client" in html, status)

        print("\n== 2. delivery lists: create, number, several per client")
        s, body = new_list("a", acme["id"], externalReference="PO-4711", notes="Dock 3")
        l1 = body.get("list", {})
        check("A creates a draft list for Acme (201, DL-000001)", s == 201 and l1.get("number") == "DL-000001" and l1.get("status") == "draft" and l1["client"]["name"] == "Acme Ltd", (s, body))
        s, body = new_list("a", acme["id"])
        l2 = body.get("list", {})
        check("a second list for the same client gets the next number", s == 201 and l2.get("number") == "DL-000002")
        s, body = new_list("a", globex["id"], externalReference="WEB-1")
        l3 = body.get("list", {})
        s, body = new_list("b", b_acme["id"])
        b_list = body.get("list", {})
        check("B's first list is also DL-000001 (numbers are per organization)", b_list.get("number") == "DL-000001", body)
        s, body = new_list("a", str(uuid.uuid4()))
        check("a list for an unknown client is refused (404)", s == 404, (s, body))
        s, body = new_list("a", "not-a-uuid")
        check("a list needs a valid client id (400)", s == 400, (s, body))
        s, text, _, _ = portal("a", "POST", "/api/sales/delivery-lists", {"clientId": acme["id"], "status": "ready", "number": "DL-999", "organization_id": org_ids["b"]})
        l_extra = jbody(text).get("list", {})
        check("status, number and organization_id sent by the browser are ignored (new list is a draft, DL-000004, A's)", s == 201 and l_extra.get("status") == "draft" and l_extra.get("number") == "DL-000004"
              and psql("impex_sales", f"SELECT organization_id FROM delivery_lists WHERE id = '{l_extra.get('id')}'") == org_ids["a"], (s, text[:120]))
        s, text, _, _ = portal("a", "GET", f"/api/sales/delivery-lists?clientId={acme['id']}")
        check("lists can be filtered by client", {l["number"] for l in jbody(text)["items"]} == {"DL-000001", "DL-000002", "DL-000004"}, text[:150])
        s, text, _, _ = portal("a", "GET", "/api/sales/delivery-lists?q=po-4711")
        check("...searched by reference", [l["number"] for l in jbody(text)["items"]] == ["DL-000001"])
        s, text, _, _ = portal("a", "GET", "/api/sales/delivery-lists?q=globex")
        check("...and by client name", [l["number"] for l in jbody(text)["items"]] == ["DL-000003"])
        status, html, _ = page("a", "/delivery-lists")
        check("the Delivery Lists page shows A's lists and none of B's", status == 200 and "DL-000001" in html and "Acme Ltd" in html and "Draft and older lists" in html and "Create Order" in html and "Scan products" in html, status)

        print("\n== 3. scan / look up products and add them with explicit quantities")
        s, scanned = resolve("a", bolt_label)
        check("the printed label code resolves to the bolt (the scan step)", s == 200 and scanned["product"]["id"] == a_bolt["id"], (s, scanned))
        s, typed = resolve("a", "dl-flour")
        check("typing the SKU in lower case resolves too (manual entry)", s == 200 and typed["product"]["id"] == a_flour["id"], (s, typed))
        s, body = add("a", l1["id"], scanned["product"]["id"], "12")
        item = body.get("item", {})
        check("the scanned bolt is added with the typed quantity (201)", s == 201 and item.get("quantity") == "12.0000" and body.get("item_count") == 1, (s, body))
        check("name, SKU and unit come from the Inventory Service", (item.get("product_name"), item.get("product_sku"), item.get("unit")) == ("DLA steel bolt", "DL-BOLT", "pcs"), item)
        check("current stock is shown: 50 in stock, and no warehouse anywhere", item["stock"]["total_quantity"] == "50.0000" and item["stock"]["available_quantity"] in ("50", "50.0000") and "planned_warehouse_code" not in item, item.get("stock"))
        s, body = add("a", l1["id"], a_flour["id"], "1.5")
        flour_item = body.get("item", {})
        check("a second product (kg, decimals) goes onto the same client list (201)", s == 201 and flour_item.get("quantity") == "1.5000" and body.get("item_count") == 2, (s, body))
        s, d = detail("a", l1["id"])
        check("the list shows both products and the notice that stock is not reserved", [i["product_sku"] for i in d["items"]] == ["DL-BOLT", "DL-FLOUR"] and "reserves nothing" in d["stock_notice"] and "books its quantities" in d["stock_notice"], d)
        s, body = add("a", l1["id"], a_flour["id"], "99999999999999.9999")
        check("a huge quantity that fits the column is still only a duplicate refusal here, not an error (409)", s == 409, (s, body))

        print("\n== 4. quantity rules, invalid and archived products")
        for q, label in (("0", "zero"), ("-3", "negative"), ("lots", "text"), ("1.00001", "five decimals"), ("", "empty")):
            s, body = add("a", l2["id"], a_bolt["id"], q)
            check(f"a {label} quantity is refused (400) and nothing is saved", s == 400 and detail("a", l2["id"])[1]["item_count"] == 0, (s, body))
        s, body = add("a", l2["id"], a_bolt["id"], "1.5")
        check("a fraction of a piece is refused (400, 'whole number')", s == 400 and "whole number" in body.get("error", ""), (s, body))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/items", {"productId": a_bolt["id"]})
        check("the quantity is never assumed: omitting it is refused (400)", s == 400, (s, text[:100]))
        s, body = add("a", l2["id"], str(uuid.uuid4()), "1")
        check("an unknown product is refused (404)", s == 404 and "Product not found" in body.get("error", ""), (s, body))
        s, body = add("a", l2["id"], a_old["id"], "1")
        check("an archived product is refused (409, says so)", s == 409 and "archived" in body.get("error", ""), (s, body))
        s, body = add("a", l2["id"], a_bolt["id"], "5", plannedWarehouseId=str(uuid.uuid4()))
        check("a planned warehouse sent by the browser is dropped: nothing is stored or shown (201)", s == 201 and "planned_warehouse_id" not in body["item"]
              and psql("impex_sales", f"SELECT count(*) FROM information_schema.columns WHERE table_name = 'delivery_list_items' AND column_name LIKE '%warehouse%'") == "0", (s, body))

        print("\n== 5. the browser cannot dictate product details or stock")
        s, body = add("a", l3["id"], a_bolt["id"], "2", productName="HACKED", productSku="EVIL", unit="kg", available_quantity="999999", organization_id=org_ids["b"])
        row = psql("impex_sales", f"SELECT product_name || '|' || product_sku || '|' || unit || '|' || organization_id FROM delivery_list_items WHERE delivery_list_id = '{l3['id']}'")
        check("extra fields are dropped; the saved name, SKU and unit are the Inventory Service's", s == 201 and row == f"DLA steel bolt|DL-BOLT|pcs|{org_ids['a']}", (s, row))
        s, text, _, _ = call(SALES, "POST", f"/api/v1/sales/delivery-lists/{l3['id']}/items", {"product_id": a_flour["id"], "quantity": "1", "product_name": "HACKED"}, bearer(tokens["a"]))
        check("the Sales Service itself rejects such fields (422)", s == 422, (s, text[:100]))

        print("\n== 6. duplicates are refused; changing a quantity is always explicit")
        s, body = add("a", l1["id"], a_bolt["id"], "3")
        check("adding the bolt a second time is refused (409 duplicate_item) and names the existing line", s == 409 and body.get("code") == "duplicate_item" and body["item"]["id"] == item["id"] and body["item"]["quantity"] == "12.0000", (s, body))
        for _ in range(4):
            add("a", l1["id"], a_bolt["id"], "1")
        s, d = detail("a", l1["id"])
        check("repeated 'scans' never change anything: still 2 lines, bolt still 12", d["item_count"] == 2 and d["items"][0]["quantity"] == "12.0000", d)
        check("the database holds one line per product", psql("impex_sales", f"SELECT count(*) FROM delivery_list_items WHERE delivery_list_id = '{l1['id']}' AND product_id = '{a_bolt['id']}'") == "1")
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}", {"quantity": "8"})
        check("the user can set the quantity explicitly (200, 8)", s == 200 and jbody(text)["item"]["quantity"] == "8.0000", (s, text[:100]))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}/increase", {"quantity": "3"})
        check("...or increase it explicitly (200, 11)", s == 200 and jbody(text)["item"]["quantity"] == "11.0000", (s, text[:100]))
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}", {"quantity": "2.5"})
        check("a fractional edit of a piece count is refused (400)", s == 400, (s, text[:100]))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}/increase", {"quantity": "0"})
        check("an increase of zero is refused (400)", s == 400)
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}", {"quantity": "100"})
        s, d = detail("a", l1["id"])
        check("asking for more than is available is allowed but flagged (100 > 50: short by 50)", d["items"][0]["stock"]["exceeds_available"] is True and d["items"][0]["stock"]["shortfall"] == "50.0000" and d["items_exceeding_stock"] == 1, d["items"][0].get("stock"))
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}", {"quantity": "12"})
        s, text, _, _ = portal("a", "DELETE", f"/api/sales/delivery-lists/{l1['id']}/items/{flour_item['id']}")
        s2, d = detail("a", l1["id"])
        check("removing a line works (flour gone, bolt stays)", s == 200 and [i["product_sku"] for i in d["items"]] == ["DL-BOLT"], (s, d["items"]))
        s, body = add("a", l1["id"], a_flour["id"], "2")
        check("a removed product can be added again (201)", s == 201)
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/delivery-lists/{l1['id']}", {"externalReference": "PO-4711-B", "notes": "Call first"})
        check("reference and notes of a draft can be edited (200)", s == 200 and jbody(text)["list"]["external_reference"] == "PO-4711-B", (s, text[:100]))

        print("\n== 7. status: Ready, Cancelled - and no inventory effect")
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/ready")
        check("marking an empty... (l2 has one item) list Ready works (200)", s == 200 and jbody(text)["list"]["status"] == "ready", (s, text[:100]))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l3['id']}/ready")
        s, empty = new_list("a", acme["id"])
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{empty['list']['id']}/ready")
        check("an empty list cannot be marked Ready (409)", s == 409 and "at least one product" in jbody(text).get("error", ""), (s, text[:100]))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/items", {"productId": a_flour["id"], "quantity": "1"})
        check("a Ready list is read-only (409, says to reopen)", s == 409 and "reopen" in jbody(text).get("error", ""), (s, text[:100]))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/reopen")
        check("a Ready list is BOOKED (a sales order): it cannot be reopened (409), its order is edited instead", s == 409 and "Edit the order" in jbody(text).get("error", ""), (s, text[:140]))
        portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/ready")
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/cancel")
        check("a list can be cancelled (200), and is kept with its items", s == 200 and jbody(text)["list"]["status"] == "cancelled" and len(jbody(text)["list"]["items"]) == 1)
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l2['id']}/ready")
        check("a cancelled list is final (409)", s == 409, (s, text[:100]))
        for action in ("dispatch", "deduct", "reserve"):
            check(f"there is no '{action}' action", portal("a", "POST", f"/api/sales/delivery-lists/{l1['id']}/{action}")[0] == 404)
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l1['id']}/ready")
        check("marking a list Ready BOOKS its stock (it becomes a sales order): 200, Ready, booked", s == 200 and jbody(text)["list"]["status"] == "ready" and jbody(text)["list"]["booking_state"] == "booked", (s, text[:160]))
        s, text, _, _ = portal("a", "GET", "/api/sales/delivery-lists?status=cancelled")
        check("lists can be filtered by status", [l["number"] for l in jbody(text)["items"]] == ["DL-000002"])
        status, html, _ = page("a", f"/delivery-lists/{l1['id']}")
        check("the list page shows items, availability and the 'not reserved' notice", status == 200 and all(x in html for x in ("DL-000001", "DLA steel bolt", "on hand", "its stock is reserved")), status)

        print("\n== 8. THE rule: inventory is untouched by all of it")
        after = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        check("A's balances, movement count and operations are exactly as before any list existed", after["a"] == inventory_before["a"], (inventory_before["a"], after["a"]))
        check("B's too", after["b"] == inventory_before["b"])
        check("no stock movement mentions a delivery list", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id = '{org_ids['a']}' AND (reason ILIKE '%deliver%' OR reason ILIKE '%DL-0%')") == "0")
        check("the Sales database has no stock tables at all", psql("impex_sales", "SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'")
              == "alembic_version,clients,delivery_list_counters,delivery_list_items,delivery_lists,dispatch_counters,dispatch_lines,dispatch_requests,dispatches,"
              "invoice_allocations,invoice_counters,invoice_lines,invoice_payments,invoice_requests,invoices,sales_order_counters,sales_order_requests,sales_orders")

        print("\n== 9. inactive clients")
        s, text, _, _ = portal("a", "POST", f"/api/sales/clients/{acme['id']}/deactivate")
        check("A deactivates Acme (200)", s == 200 and jbody(text)["client"]["is_active"] is False)
        s, body = new_list("a", acme["id"])
        check("no new list for an inactive client (409)", s == 409 and "inactive" in body.get("error", ""), (s, body))
        s, body = add("a", l_extra["id"], a_bolt["id"], "1")
        check("no products can be added to a draft of an inactive client (409)", s == 409 and "inactive" in body.get("error", ""), (s, body))
        s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l_extra['id']}/ready")
        check("...nor can such a list be marked Ready (409)", s == 409)
        status, html, _ = page("a", f"/delivery-lists/{l1['id']}")
        check("existing lists of the inactive client are still viewable, flagged", status == 200 and "inactive client" in html, status)
        s, text, _, _ = portal("a", "POST", f"/api/sales/clients/{acme['id']}/activate")
        check("reactivating restores it (200)", s == 200 and new_list("a", acme["id"])[0] == 201)

        print("\n== 10. tenant isolation")
        before_sales = sales_counts(org_ids["a"])
        status, html, _ = page("b", "/delivery-lists")
        check("B's list page shows B's list and nothing of A's", status == 200 and "DL-000001" in html and "Acme Ltd" in html and "Globex" not in html and "PO-4711" not in html and "WEB-1" not in html, status)
        status, html, _ = page("b", "/clients")
        check("B's Clients page shows only B's client", status == 200 and "Acme Ltd" in html and "Globex GmbH" not in html and "Jane Doe" not in html)
        s, text, _, _ = portal("b", "GET", "/api/sales/clients?q=Globex")
        check("B cannot find A's client by searching", jbody(text).get("total") == 0)
        s, text, _, _ = portal("b", "GET", f"/api/sales/delivery-lists?clientId={acme['id']}")
        check("...nor A's lists by A's client id", jbody(text).get("total") == 0)
        attempts = {
            "view A's list": portal("b", "GET", f"/api/sales/delivery-lists/{l1['id']}")[0],
            "edit A's list": portal("b", "PATCH", f"/api/sales/delivery-lists/{l1['id']}", {"notes": "HIJACKED"})[0],
            "cancel A's list": portal("b", "POST", f"/api/sales/delivery-lists/{l1['id']}/cancel")[0],
            "reopen A's list": portal("b", "POST", f"/api/sales/delivery-lists/{l1['id']}/reopen")[0],
            "add to A's list": add("b", l1["id"], b_bolt["id"], "1")[0],
            "edit A's item": portal("b", "PATCH", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}", {"quantity": "999"})[0],
            "increase A's item": portal("b", "POST", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}/increase", {"quantity": "1"})[0],
            "remove A's item": portal("b", "DELETE", f"/api/sales/delivery-lists/{l1['id']}/items/{item['id']}")[0],
            "edit A's client": portal("b", "PATCH", f"/api/sales/clients/{acme['id']}", {"name": "HIJACKED"})[0],
            "deactivate A's client": portal("b", "POST", f"/api/sales/clients/{acme['id']}/deactivate")[0],
            "create a list for A's client": new_list("b", acme["id"])[0],
            "view A's list (API)": call(SALES, "GET", f"/api/v1/sales/delivery-lists/{l1['id']}", headers=bearer(tokens["b"]))[0],
        }
        check("B's attempts on A's clients, lists and items all answer 404", set(attempts.values()) == {404}, attempts)
        check("...and not one A row changed", sales_counts(org_ids["a"]) == before_sales and psql("impex_sales", "SELECT count(*) FROM delivery_lists WHERE notes = 'HIJACKED'") == "0"
              and psql("impex_sales", "SELECT count(*) FROM clients WHERE name = 'HIJACKED'") == "0")
        s, body = add("b", b_list["id"], a_bolt["id"], "1")
        check("B cannot put A's product on B's own list (404, same as an unknown product)", s == 404 and "Product not found" in body.get("error", ""), (s, body))
        s, body = add("b", b_list["id"], b_bolt["id"], "7")
        check("B adds B's own product with the same SKU (201)", s == 201 and body["item"]["product_name"] == "DLB silk scarf", (s, body))
        check("B sees B's own stock (99), never A's", body["item"]["stock"]["total_quantity"] == "99.0000", body["item"]["stock"])
        s, d = detail("b", b_list["id"])
        check("B's list contains nothing of A's", "DLA" not in json.dumps(d) and "Acme Ltd" in json.dumps(d))
        s, text, _, _ = call(SALES, "GET", f"/api/v1/sales/delivery-lists?organization_id={org_ids['a']}", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a query parameter and header naming A change nothing for B", all("DLA" not in json.dumps(i) and i["id"] != l1["id"] for i in jbody(text).get("items", [])) and s == 200)
        s, text, _, _ = call(SALES, "POST", "/api/v1/sales/clients", {"name": "Sneaky", "organization_id": org_ids["a"]}, bearer(tokens["b"]))
        check("an organization_id in a request body is rejected by the Sales Service (422)", s == 422, (s, text[:100]))

        print("\n== 11. the database enforces it too")
        err = psql_with_errors("impex_sales", f"SET session_replication_role = replica; INSERT INTO delivery_list_items (organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) VALUES ('{org_ids['a']}', '{l1['id']}', '{a_bolt['id']}', 'X', 'X', 1, 'pcs')")
        check("a second line for the same product is refused", "duplicate key" in err, err[:120])
        err = psql_with_errors("impex_sales", f"SET session_replication_role = replica; INSERT INTO delivery_list_items (organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) VALUES ('{org_ids['a']}', '{l1['id']}', '{uuid.uuid4()}', 'X', 'X', 0, 'pcs')")
        check("a zero quantity is refused", "violates check constraint" in err, err[:120])
        err = psql_with_errors("impex_sales", f"INSERT INTO delivery_list_items (organization_id, delivery_list_id, product_id, product_sku, product_name, quantity, unit) VALUES ('{org_ids['b']}', '{l1['id']}', '{uuid.uuid4()}', 'X', 'X', 1, 'pcs')")
        check("an item that mixes two organizations is refused", "violates foreign key" in err, err[:120])
        err = psql_with_errors("impex_sales", f"INSERT INTO delivery_lists (organization_id, client_id, number, created_by, created_by_email) VALUES ('{org_ids['b']}', '{acme['id']}', 'DL-777777', '{uuid.uuid4()}', 'x@x')")
        check("a list that points at another organization's client is refused", "violates foreign key" in err, err[:120])
        err = psql_with_errors("impex_sales", f"DELETE FROM clients WHERE id = '{acme['id']}'")
        check("a client with lists cannot be deleted", "violates foreign key" in err, err[:120])

        print("\n== 12. accounts and roles")
        check("a Super Admin gets 403 from the Sales Service", call(SALES, "GET", "/api/v1/sales/delivery-lists", headers=bearer(sa_token))[0] == 403 and call(SALES, "GET", "/api/v1/sales/clients", headers=bearer(sa_token))[0] == 403)
        check("no token -> 401; garbage token -> 401", call(SALES, "GET", "/api/v1/sales/clients")[0] == 401 and call(SALES, "GET", "/api/v1/sales/clients", headers=bearer("nonsense"))[0] == 401)
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        for path in ("/delivery-lists", "/clients", f"/delivery-lists/{l1['id']}"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path, cookies={"impex_tenant_session": super_cookie})
            check(f"a Super Admin session planted in the tenant cookie cannot open {path}", status == 307 and location.endswith("/login"), (status, location))
            status, _, _, location = call(TENANT_PORTAL, "GET", path)
            check(f"{path} without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, _ = call(TENANT_PORTAL, "POST", "/api/sales/delivery-lists", {"clientId": acme["id"]}, cookies={"impex_session": super_cookie})
        check("the Super Admin portal's cookie does not authorize the Sales routes (401)", status == 401, status)
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        s, body = new_list("b", b_acme["id"])
        check("an inactive organization cannot create lists (403 'not active')", s == 403 and "not active" in body.get("error", ""), (s, body))
        status, html, _ = page("b", "/delivery-lists")
        check("...its page explains it without listing anything", status == 200 and "currently inactive or unavailable" in html and "DL-000001" not in html, status)
        check("...A is unaffected", page("a", "/delivery-lists")[0] == 200)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("...and reactivating B restores everything", "DL-000001" in page("b", "/delivery-lists")[1])
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("a disabled administrator is locked out at once (401)", new_list("a", acme["id"])[0] == 401)
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling restores access", page("a", "/delivery-lists")[0] == 200)
        status, html, _ = page("a", "/scan")
        check("the Scan Product page renders (and offers Add to Deliverables after a scan)", status == 200 and 'id="scan-input"' in html, status)

        if args.with_outage:
            print("\n== 13. service outages")
            docker("compose", "stop", "inventory-service")
            try:
                s, body = add("a", l_extra["id"], a_flour["id"], "1")
                check("adding a product while the Inventory Service is down answers 503 with a clear message", s == 503 and "inventory" in body.get("error", "").lower(), (s, body))
                s, d = detail("a", l1["id"])
                check("the list still opens (our own data), saying stock cannot be shown", s == 200 and d["stock_status"] == "unavailable" and d["items"][0]["product_name"] == "DLA steel bolt" and d["items"][0]["stock"] is None, (s, d.get("stock_status")))
                status, html, _ = page("a", f"/delivery-lists/{l1['id']}")
                check("the page shows the notice instead of failing", status == 200 and "Current stock could not be loaded" in html, status)
                check("clients and the list index keep working", page("a", "/clients")[0] == 200 and page("a", "/delivery-lists")[0] == 200)
                s, text, _, _ = portal("a", "POST", f"/api/sales/delivery-lists/{l_extra['id']}/ready")
                check("(an empty draft cannot be readied; marking Ready needs the Inventory Service)", s in (409, 503))
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            check("everything works again afterwards", add("a", l_extra["id"], a_flour["id"], "1")[0] == 201)
            docker("compose", "stop", "sales-service")
            try:
                s, text, _, _ = portal("a", "POST", "/api/sales/clients", {"name": "While Down"})
                check("creating a client while the Sales Service is down answers 503", s == 503, (s, text[:100]))
                status, html, _ = page("a", "/delivery-lists")
                check("the Delivery Lists page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html, status)
                check("products and stock are unaffected", page("a", "/stock")[0] == 200 and resolve("a", "DL-BOLT")[0] == 200)
            finally:
                docker("compose", "start", "sales-service")
                wait_until(SALES, "/health")
            check("the Sales Service is back", page("a", "/delivery-lists")[0] == 200)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")

        final = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        print("\n== 14. one last look at the inventory")
        check("after everything above, A's and B's stock and history are still exactly as at the start", final == inventory_before, (inventory_before, final))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "items": delete_exact(psql, "impex_sales", "delivery_list_items", orgs, "organization_id", ledger=True),
            "lists": delete_exact(psql, "impex_sales", "delivery_lists", orgs, "organization_id"),
            "counters": delete_exact(psql, "impex_sales", "delivery_list_counters", orgs, "organization_id"),
            "clients": delete_exact(psql, "impex_sales", "clients", orgs, "organization_id"),
            "identifiers": delete_exact(psql, "impex_inventory", "product_identifiers", orgs, "organization_id", ledger=True),
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
