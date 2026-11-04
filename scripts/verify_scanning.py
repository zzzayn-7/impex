#!/usr/bin/env python3
"""End-to-end check of QR / barcode codes, labels, scan lookup and the unit-of-measurement lock against the RUNNING stack.

    docker compose up -d                      # stack must be running (and migration 0003 applied)
    python scripts/verify_scanning.py
    python scripts/verify_scanning.py --with-https    # also checks the optional HTTPS proxy (docker compose --profile https up -d https-proxy)

It creates two throwaway organizations ("Scan Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: generate codes, print
data, register supplier barcodes, resolve scanned codes (label code, barcode, SKU), stock changes after a scan, the
unit lock, SKU changes, and then every way of reaching the other organization's products through codes.

Everything it created is deleted afterwards, by exact id (the append-only tables are cleaned with the database's out-of-band
maintenance switch, which the application never uses). No emails are sent and no existing record is touched.
"""
import argparse
import http.client
import json
import os
import secrets
import shutil
import ssl
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402

AUTH, ORG, INVENTORY, SUPER_PORTAL, TENANT_PORTAL, HTTPS_PORTAL = 8000, 8001, 8002, 3000, 3001, 3443
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


def call(port, method, path, body=None, headers=None, cookies=None, https=False):
    if https:
        conn = http.client.HTTPSConnection("localhost", port, timeout=60, context=ssl._create_unverified_context())
    else:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--with-https", action="store_true", help="also check the optional HTTPS proxy on port 3443")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "scancheck-sa@example.org"
    emails = {"a": "scancheck-admin-a@example.org", "b": "scancheck-admin-b@example.org"}
    org_names = {"a": "Scan Check Alpha", "b": "Scan Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, html, _, location = portal(key, "GET", path)
        return status, html.replace("<!-- -->", ""), location

    def product(key, sku, name, unit="pcs"):
        status, text, _, _ = portal(key, "POST", "/api/products", {
            "sku": sku, "name": name, "category": "Scan check", "unit": unit, "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def warehouse(key, code, name):
        status, text, _, _ = portal(key, "POST", "/api/warehouses", {"code": code, "name": name})
        body = jbody(text).get("warehouse", {})
        created.add("warehouses", body.get("id"))
        return body

    def stock(key, action, body, idem=None):
        status, text, _, _ = portal(key, "POST", f"/api/stock/{action}", body, {"Idempotency-Key": idem or f"scan-{uuid.uuid4()}"})
        return status, jbody(text)

    def resolve(key, code):
        status, text, _, _ = portal(key, "GET", f"/api/scan/resolve?code={code}")
        return status, jbody(text)

    def generate(key, pid):
        status, text, _, _ = portal(key, "POST", f"/api/products/{pid}/identifiers/generate")
        body = jbody(text)
        created.add("product_identifiers", body.get("identifier", {}).get("id"))
        return status, body

    def register(key, pid, value, kind="manufacturer", label=""):
        status, text, _, _ = portal(key, "POST", f"/api/products/{pid}/identifiers", {"kind": kind, "value": value, "label": label})
        body = jbody(text)
        created.add("product_identifiers", body.get("identifier", {}).get("id"))
        return status, body

    def counts(org):
        return {t: psql("impex_inventory", f"SELECT count(*) FROM {t} WHERE organization_id = '{org}'") for t in
                ("stock_movements", "stock_balances", "stock_operations", "warehouses", "product_identifiers")}

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='Scancheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"scancheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
            org_ids[key] = jbody(text).get("id")
            created.add("organizations", org_ids[key])
            check(f"organization {key.upper()} created", status == 201 and org_ids[key], (status, text))
            status, text, _, _ = call(AUTH, "POST", "/internal/organization-admins", {
                "organization_id": org_ids[key], "full_name": f"Admin {key.upper()}", "email": emails[key], "password": password},
                {"X-Internal-Key": internal_key})
            created.add("users", jbody(text).get("id"))
            check(f"administrator {key.upper()} created", status == 201, (status, text))
            status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[key], "password": password})
            tokens[key] = jbody(text).get("access_token")
            status, text, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[key], "password": password})
            cookies[key] = cookie_value(sc, "impex_tenant_session")
            check(f"administrator {key.upper()} signs in to the Organization Portal", status == 200 and cookies[key], (status, text))

        # Both organizations use the SAME sku and the SAME manufacturer barcode for different products.
        a_bolt, a_flour, a_nut = product("a", "SC-BOLT", "ScanA steel bolt", "pcs"), product("a", "SC-FLOUR", "ScanA flour", "kg"), product("a", "SC-NUT", "ScanA nut", "pcs")
        b_bolt = product("b", "SC-BOLT", "ScanB silk scarf", "pcs")
        a_main, a_annex, b_main = warehouse("a", "MAIN", "ScanA main depot"), warehouse("a", "ANNEX", "ScanA annex"), warehouse("b", "MAIN", "ScanB main depot")
        check("products and warehouses created (same SKU 'SC-BOLT' in both organizations)", all(x.get("id") for x in (a_bolt, a_flour, a_nut, b_bolt, a_main, a_annex, b_main)))
        a_bolt_sku_before = (a_bolt["id"], a_bolt["sku"])

        print("\n== 1. QR / Code 128 codes for existing products")
        s1, g1 = generate("a", a_bolt["id"])
        s2, g2 = generate("a", a_bolt["id"])
        code_a = g1["identifier"]["value"]
        check("generating a code for an existing product answers 201, and again 200 with the SAME code", (s1, s2) == (201, 200) and g2["identifier"]["value"] == code_a and g1["created"] and not g2["created"], (s1, s2, g1, g2))
        check("the code looks like IMX-XXXXXXXXXXXX and does not contain the SKU or the id", code_a.startswith("IMX-") and len(code_a) == 16 and "BOLT" not in code_a and a_bolt["id"][:8].upper() not in code_a, code_a)
        _, g_b = generate("b", b_bolt["id"])
        code_b = g_b["identifier"]["value"]
        check("B's product gets its own, different code", code_b != code_a and code_b.startswith("IMX-"))
        check("existing product ids and SKUs are untouched", (a_bolt["id"], a_bolt["sku"]) == a_bolt_sku_before and psql("impex_inventory", f"SELECT sku FROM products WHERE id = '{a_bolt['id']}'") == "SC-BOLT")
        status, text, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/products/{a_bolt['id']}/label", headers=bearer(tokens["a"]))
        label = jbody(text)
        check("the label has the name, SKU, a QR code SVG and a Code 128 SVG", status == 200 and label["product"]["name"] == "ScanA steel bolt" and label["code"] == code_a and "<path" in label["qr_svg"] and "<rect" in label["barcode_svg"], status)
        status, html, _ = page("a", f"/products/{a_bolt['id']}/codes")
        check("the Codes & labels page shows the label, code and Print button", status == 200 and all(x in html for x in ("ScanA steel bolt", "SC-BOLT", code_a, "Print label", "data:image/svg+xml")), status)
        status, html, _ = page("a", "/products")
        check("the product list has a Codes link per product", f"/products/{a_bolt['id']}/codes" in html)

        print("\n== 2. manufacturer / supplier barcodes")
        s, r = register("a", a_bolt["id"], " 5901234-ean ", "supplier", "Acme Ltd")
        check("A registers a supplier barcode (normalized to upper case, 201)", s == 201 and r["identifier"]["value"] == "5901234-EAN" and r["identifier"]["label"] == "Acme Ltd", (s, r))
        s, r = register("a", a_flour["id"], "5901234-EAN")
        check("the same barcode cannot be given to a second product in A (409, names the first)", s == 409 and "ScanA steel bolt" in r.get("error", ""), (s, r))
        s, r = register("b", b_bolt["id"], "5901234-EAN")
        check("B can use the very same barcode text for their own product (201)", s == 201, (s, r))
        s, r = register("a", a_flour["id"], "sc-nut")
        check("a barcode equal to another product's SKU is refused (409)", s == 409, (s, r))
        s, r = register("a", a_flour["id"], "https://evil.example/x")
        check("a web address is refused as a barcode (400, never stored)", s == 400, (s, r))
        s, r = register("a", a_flour["id"], "IMX-ABCDEFGHJKMN")
        check("the IMX- prefix is reserved for generated labels (409/422 via the service)", s in (400, 409, 422), (s, r))
        s, r = register("a", a_flour["id"], "FLOUR-EAN-1")
        flour_ident = r.get("identifier", {})
        check("A registers a barcode for the flour (201)", s == 201, (s, r))

        print("\n== 3. scan lookup through the portal (read-only)")
        s, _ = stock("a", "in", {"product_id": a_bolt["id"], "warehouse_id": a_main["id"], "quantity": "40", "reason": "Scan check delivery"})
        stock("a", "in", {"product_id": a_bolt["id"], "warehouse_id": a_annex["id"], "quantity": "10"})
        stock("a", "in", {"product_id": a_flour["id"], "warehouse_id": a_main["id"], "quantity": "2.5"})
        portal("a", "POST", f"/api/warehouses/{a_annex['id']}/archive")
        check("stock was recorded for A's products", s == 201)
        for code, how in ((code_a, "the Impex label code (QR / Code 128 text)"), ("5901234-EAN", "the supplier barcode"), ("sc-bolt", "the SKU in lower case"), (code_a + "%0D%0A", "the label code with the scanner's Enter")):
            s, body = resolve("a", code)
            check(f"A scans {how} -> its bolt (200)", s == 200 and body.get("product", {}).get("id") == a_bolt["id"], (s, body))
        s, body = resolve("a", code_a)
        stock_info = body["stock"]
        check("the result carries unit, stock per warehouse, total and available", body["product"]["unit"] == "pcs" and body["product"]["unit_allows_fractions"] is False
              and stock_info["total_quantity"] == "50.0000" and stock_info["available_quantity"] == "40.0000"
              and {(l["warehouse_code"], l["quantity"]) for l in stock_info["lines"]} == {("MAIN", "40.0000"), ("ANNEX", "10.0000")}, body)
        check("...and no organization id", "organization_id" not in json.dumps(body))
        s, body = resolve("a", "FLOUR-EAN-1")
        check("a kg product reports that decimals are allowed", s == 200 and body["product"]["unit_allows_fractions"] is True and body["stock"]["total_quantity"] == "2.5000", (s, body))
        s, body = resolve("a", "NO-SUCH-CODE")
        check("an unknown code answers 404 with a plain message", s == 404 and "No product" in body.get("error", ""), (s, body))
        s, body = resolve("a", "has%20space")
        check("an invalid code answers 400", s == 400, (s, body))
        s, body = resolve("a", "https%3A%2F%2Fevil.example%2Fpay")
        check("a scanned web address is refused (400) and never followed", s == 400 and "not opened" in body.get("error", ""), (s, body))
        s, text, _, _ = call(INVENTORY, "GET", "/api/v1/inventory/scan/resolve?code=" + "http%3A%2F%2Fevil.example", headers=bearer(tokens["a"]))
        check("the Inventory Service itself also refuses a link (422)", s == 422, (s, text[:80]))

        print("\n== 4. archived, retired and ambiguous codes")
        portal("a", "POST", f"/api/products/{a_nut['id']}/archive")
        s, body = resolve("a", "SC-NUT")
        check("an archived product is returned, flagged inactive", s == 200 and body["product"]["is_active"] is False, (s, body))
        s2, html, _ = page("a", "/scan")
        check("(the Scan Product page itself renders for A)", s2 == 200 and "Scan Product" in html)
        portal("a", "POST", f"/api/products/{a_nut['id']}/restore")
        s, r = portal("a", "POST", f"/api/products/{a_bolt['id']}/identifiers/{flour_ident.get('id', a_bolt['id'])}/retire")[0:2]
        check("a barcode of another product cannot be retired through this product (404)", s == 404, s)
        s, body = register("a", a_nut["id"], "RETIRE-ME-1")
        ident_id = body.get("identifier", {}).get("id")
        s, _, _, _ = portal("a", "POST", f"/api/products/{a_nut['id']}/identifiers/{ident_id}/retire")
        check("A retires a supplier barcode (200)", s == 200)
        s, body = resolve("a", "RETIRE-ME-1")
        check("scanning a retired barcode answers 410 'retired'", s == 410 and "retired" in body.get("error", ""), (s, body))
        s, body = register("a", a_bolt["id"], "RETIRE-ME-1")
        check("the retired code is NOT handed to another product (409)", s == 409, (s, body))
        s, text, _, _ = call(INVENTORY, "POST", f"/api/v1/inventory/products/{a_bolt['id']}/identifiers/{g1['identifier']['id']}/retire", None, bearer(tokens["a"]))
        check("the Impex label code cannot be retired (409)", s == 409, (s, text[:80]))
        ambiguous = product("a", "AMBIG-1", "ScanA created later")
        s0, _ = register("a", a_flour["id"], "AMBIG-2")
        status, text, _, _ = portal("a", "POST", "/api/products", {"sku": "AMBIG-2", "name": "ScanA ambiguous partner", "category": "Scan check", "unit": "pcs", "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD"})
        created.add("products", jbody(text).get("product", {}).get("id"))
        check("a new product cannot take another product's barcode as its SKU (409, names the owner)", status == 409 and "barcode" in jbody(text).get("error", ""), (status, text[:120]))
        s, text, _, _ = portal("a", "PATCH", f"/api/products/{ambiguous['id']}", {"sku": "flour-ean-1"})
        check("...nor can an existing product be renamed to one (409), and its SKU is unchanged", s == 409 and psql("impex_inventory", f"SELECT sku FROM products WHERE id = '{ambiguous['id']}'") == "AMBIG-1", (s, text[:100]))
        s, body = resolve("a", "AMBIG-2")
        check("so the code stays unambiguous: it still finds the flour (200)", s == 200 and body["product"]["id"] == a_flour["id"], (s, body))
        err = psql_with_errors("impex_inventory", f"INSERT INTO products (organization_id, sku, name, category, unit, cost_price, selling_price, currency_code) VALUES ('{org_ids['a']}', 'AMBIG-2', 'x', 'c', 'pcs', 1, 1, 'USD')")
        check("the database refuses the collision too if the API is bypassed", "already a barcode of another product" in err, err[:120])
        check("the unambiguous routes still work", resolve("a", "FLOUR-EAN-1")[0] == 200 and resolve("a", ambiguous["sku"])[0] == 200)

        print("\n== 5. scanning changes nothing; stock changes reuse the Step 14 API")
        before = counts(org_ids["a"])
        for _ in range(4):
            for c in (code_a, "SC-BOLT", "5901234-EAN", "NO-SUCH-CODE"):
                resolve("a", c)
        check("20 scans later: no movement, balance or operation was created", counts(org_ids["a"]) == before, (before, counts(org_ids["a"])))
        body = {"product_id": a_bolt["id"], "warehouse_id": a_main["id"], "quantity": "5", "reason": "Scanned receipt"}
        s1, r1 = stock("a", "in", body, "scan-flow-key-0001")
        s2, r2 = stock("a", "in", body, "scan-flow-key-0001")
        check("a stock-in after a scan, double-tapped, applies once (201 then 200 replay)", (s1, s2) == (201, 200) and r2["operation"]["replayed"], (s1, s2))
        check("...stock is 45 in MAIN, with the movement attributed to the administrator",
              psql("impex_inventory", f"SELECT quantity::text FROM stock_balances WHERE warehouse_id = '{a_main['id']}' AND product_id = '{a_bolt['id']}'") == "45.0000"
              and psql("impex_inventory", f"SELECT created_by_email FROM stock_movements WHERE product_id = '{a_bolt['id']}' AND reason = 'Scanned receipt'") == emails["a"])
        s, r = stock("a", "out", {"product_id": a_bolt["id"], "warehouse_id": a_main["id"], "quantity": "46"})
        check("removing more than is there is refused (409) - never negative", s == 409 and "Insufficient stock" in r.get("error", ""), (s, r))
        s, r = stock("a", "in", {"product_id": a_bolt["id"], "warehouse_id": a_main["id"], "quantity": "1.5"})
        check("a fraction of a piece is refused (400)", s == 400 and "whole number" in r.get("error", ""), (s, r))
        s, r = stock("a", "transfer", {"product_id": a_bolt["id"], "from_warehouse_id": a_main["id"], "to_warehouse_id": a_annex["id"], "quantity": "1"})
        check("an archived warehouse still refuses transfers (409)", s == 409, (s, r))
        s, body = resolve("a", code_a)
        check("the next scan shows the new quantities", body["stock"]["total_quantity"] == "55.0000", body.get("stock"))
        check("the history is intact and unchanged by scanning", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{a_bolt['id']}'") == "3")

        print("\n== 6. the unit of measurement is locked after stock movements")
        s, text, _, _ = portal("a", "PATCH", f"/api/products/{a_bolt['id']}", {"unit": "kg"})
        body = jbody(text)
        check("changing the unit of a product WITH movements is refused (409, shown under the Unit field)", s == 409 and "unit" in (body.get("fieldErrors") or {}) and "stock movements" in body.get("error", ""), (s, body))
        check("the unit and every movement are unchanged", psql("impex_inventory", f"SELECT unit FROM products WHERE id = '{a_bolt['id']}'") == "pcs"
              and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{a_bolt['id']}'") == "3")
        s, text, _, _ = portal("a", "PATCH", f"/api/products/{a_bolt['id']}", {"unit": "pcs", "name": "ScanA steel bolt M10"})
        check("re-sending the same unit while editing other fields is fine (200)", s == 200 and jbody(text)["product"]["name"] == "ScanA steel bolt M10", (s, text[:100]))
        err = psql_with_errors("impex_inventory", f"UPDATE products SET unit = 'kg' WHERE id = '{a_bolt['id']}'")
        check("the database refuses it too if the API is bypassed", "cannot be changed once the product has stock movements" in err, err[:120])
        s, text, _, _ = portal("a", "PATCH", f"/api/products/{a_nut['id']}", {"unit": "box"})
        check("a product with NO movements can still have its unit corrected (200)", s == 200 and jbody(text)["product"]["unit"] == "box", (s, text[:100]))
        status, html, _ = page("a", "/products")
        check("the product list loads (unit_locked is reported per product)", status == 200)
        status, text, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/products/{a_bolt['id']}", headers=bearer(tokens["a"]))
        check("the service reports unit_locked = true for it", jbody(text).get("unit_locked") is True)

        print("\n== 7. an SKU change never moves a code")
        s, text, _, _ = portal("a", "PATCH", f"/api/products/{a_bolt['id']}", {"sku": "SC-BOLT-RENAMED"})
        check("A renames the bolt's SKU (200)", s == 200, (s, text[:100]))
        s, body = resolve("a", code_a)
        check("its printed label code still finds the same product", s == 200 and body["product"]["id"] == a_bolt["id"] and body["product"]["sku"] == "SC-BOLT-RENAMED", (s, body))
        check("its supplier barcode still finds it", resolve("a", "5901234-EAN")[1].get("product", {}).get("id") == a_bolt["id"])
        check("the old SKU finds nothing now (404)", resolve("a", "SC-BOLT")[0] == 404)
        newcomer = product("a", "SC-BOLT", "ScanA newcomer with the recycled SKU")
        s, body = resolve("a", "SC-BOLT")
        check("a new product given the old SKU is found by that SKU...", s == 200 and body["product"]["id"] == newcomer["id"], (s, body))
        s, body = resolve("a", code_a)
        check("...while the old label still means the ORIGINAL product", body["product"]["id"] == a_bolt["id"])
        check("...and the newcomer inherited no codes", psql("impex_inventory", f"SELECT count(*) FROM product_identifiers WHERE product_id = '{newcomer['id']}'") == "0")

        print("\n== 8. tenant isolation")
        for what, code in (("A's label code", code_a), ("A's SKU", "SC-FLOUR"), ("A's flour barcode", "FLOUR-EAN-1")):
            s, body = resolve("b", code)
            unknown = resolve("b", "ZZZ-UNKNOWN-1")
            check(f"B scanning {what} gets 404, identical to an unknown code", s == 404 and (s, body) == unknown, (s, body))
        s, body = resolve("b", "SC-BOLT")
        check("the SAME sku resolves to B's own product for B", s == 200 and body["product"]["name"] == "ScanB silk scarf" and "ScanA" not in json.dumps(body), (s, body))
        s, body = resolve("b", "5901234-EAN")
        check("the SAME barcode resolves to B's own product for B", s == 200 and body["product"]["id"] == b_bolt["id"] and "ScanA" not in json.dumps(body), (s, body))
        s, body = resolve("a", "5901234-EAN")
        check("...and to A's own product for A", body["product"]["id"] == a_bolt["id"])
        check("B's stock figures are B's own (none yet), never A's", resolve("b", "SC-BOLT")[1]["stock"]["total_quantity"] == "0")
        before = counts(org_ids["a"])
        attempts = {
            "generate a code for A's product": portal("b", "POST", f"/api/products/{a_flour['id']}/identifiers/generate")[0],
            "register a barcode on A's product": portal("b", "POST", f"/api/products/{a_flour['id']}/identifiers", {"kind": "supplier", "value": "STOLEN-1"})[0],
            "retire A's barcode": portal("b", "POST", f"/api/products/{a_bolt['id']}/identifiers/{flour_ident.get('id', a_bolt['id'])}/retire")[0],
            "view A's codes page": page("b", f"/products/{a_bolt['id']}/codes")[1].count("Product not found.") and 404,
            "read A's codes (API)": call(INVENTORY, "GET", f"/api/v1/inventory/products/{a_bolt['id']}/identifiers", headers=bearer(tokens["b"]))[0],
            "read A's label (API)": call(INVENTORY, "GET", f"/api/v1/inventory/products/{a_bolt['id']}/label", headers=bearer(tokens["b"]))[0],
            "change A's unit": portal("b", "PATCH", f"/api/products/{a_nut['id']}", {"unit": "kg"})[0],
        }
        check("B's attempts on A's codes, labels and units all answer 404", set(attempts.values()) == {404}, attempts)
        check("...and not one A row changed", counts(org_ids["a"]) == before and psql("impex_inventory", f"SELECT count(*) FROM product_identifiers WHERE value = 'STOLEN-1'") == "0")
        s, text, _, _ = call(INVENTORY, "POST", f"/api/v1/inventory/products/{b_bolt['id']}/identifiers", {"kind": "supplier", "value": "OK-1", "organization_id": org_ids["a"]}, bearer(tokens["b"]))
        check("an organization_id in a request body is rejected by the service (422)", s == 422, (s, text[:80]))
        s, text, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/scan/resolve?code=SC-FLOUR&organization_id={org_ids['a']}", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a query parameter and header naming A change nothing for B (404)", s == 404, (s, text[:80]))

        print("\n== 9. the database enforces it too")
        err = psql_with_errors("impex_inventory", f"UPDATE product_identifiers SET product_id = '{a_flour['id']}' WHERE value = '5901234-EAN' AND organization_id = '{org_ids['a']}'")
        check("a code cannot be re-pointed to another product", "never be re-pointed" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"DELETE FROM product_identifiers WHERE organization_id = '{org_ids['a']}'")
        check("a code cannot be deleted", "never deleted" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"INSERT INTO product_identifiers (organization_id, product_id, kind, value, created_by_email) VALUES ('{org_ids['b']}', '{a_flour['id']}', 'supplier', 'MIX-1', 'x@x')")
        check("a code that mixes two organizations is refused", "violates foreign key" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"INSERT INTO product_identifiers (organization_id, product_id, kind, value, created_by_email) VALUES ('{org_ids['a']}', '{a_flour['id']}', 'supplier', '5901234-EAN', 'x@x')")
        check("the same code twice in one organization is refused", "duplicate key" in err or "unique" in err.lower(), err[:120])

        print("\n== 10. pages, accounts and roles")
        status, html, _ = page("a", "/scan")
        check("the Scan Product page renders with the scan box and the camera button", status == 200 and all(x in html for x in ('id="scan-input"', "Use camera", "Look up")), status)
        check("the camera is not started by loading the page", "Start camera" not in html)
        check("the navigation has 'Scan Product'", 'href="/scan"' in html and "Scan Product" in html)
        status, _, _, location = call(TENANT_PORTAL, "GET", "/scan")
        check("/scan without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        status, _, _, location = call(TENANT_PORTAL, "GET", "/scan", cookies={"impex_tenant_session": super_cookie})
        check("a Super Admin session planted in the tenant cookie cannot open /scan", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, _ = call(TENANT_PORTAL, "GET", "/api/scan/resolve?code=SC-BOLT", cookies={"impex_session": super_cookie})
        check("the Super Admin portal's cookie does not authorize the scan route (401)", status == 401, status)
        check("a Super Admin gets 403 from the scan endpoint", call(INVENTORY, "GET", "/api/v1/inventory/scan/resolve?code=SC-BOLT", headers=bearer(sa_token))[0] == 403)
        check("no token -> 401; garbage token -> 401", call(INVENTORY, "GET", "/api/v1/inventory/scan/resolve?code=X")[0] == 401
              and call(INVENTORY, "GET", "/api/v1/inventory/scan/resolve?code=X", headers=bearer("nonsense"))[0] == 401)
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        s, body = resolve("b", "SC-BOLT")
        check("an inactive organization cannot scan (403 'not active')", s == 403 and "not active" in body.get("error", ""), (s, body))
        check("...A is unaffected", resolve("a", code_a)[0] == 200)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("...and reactivating B restores it", resolve("b", "SC-BOLT")[0] == 200)
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("a disabled administrator is locked out of the scan route at once (401)", resolve("a", code_a)[0] == 401)
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling restores access", resolve("a", code_a)[0] == 200)

        if args.with_https:
            print("\n== 11. optional HTTPS proxy (camera access needs HTTPS)")
            try:
                status, text, sc, _ = call(HTTPS_PORTAL, "POST", "/api/auth/login", {"email": emails["a"], "password": password}, https=True)
                secure_cookie = next((c for c in sc if c.startswith("impex_tenant_session=")), "")
                check("signing in through https://localhost:3443 works and the session cookie is marked Secure", status == 200 and "Secure" in secure_cookie, (status, secure_cookie[:60]))
                token = cookie_value(sc, "impex_tenant_session")
                status, html, _, _ = call(HTTPS_PORTAL, "GET", "/scan", cookies={"impex_tenant_session": token}, https=True)
                check("the Scan Product page is served over HTTPS", status == 200 and "Scan Product" in html, status)
            except OSError as exc:
                check("the HTTPS proxy is reachable (start it with: docker compose --profile https up -d https-proxy)", False, exc)
        else:
            print("\n(skipped: HTTPS proxy check - run with --with-https after starting the 'https' profile)")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "identifiers": delete_exact(psql, "impex_inventory", "product_identifiers", orgs, "organization_id", ledger=True),
            "movements": delete_exact(psql, "impex_inventory", "stock_movements", orgs, "organization_id", ledger=True),
            "balances": delete_exact(psql, "impex_inventory", "stock_balances", orgs, "organization_id"),
            "operations": delete_exact(psql, "impex_inventory", "stock_operations", orgs, "organization_id"),
            "warehouses": delete_exact(psql, "impex_inventory", "warehouses", created.get("warehouses")),
            "products": delete_exact(psql, "impex_inventory", "products", created.get("products")),
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", created.get("users")),
        }
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(created.get('warehouses'))} warehouses, {len(created.get('products'))} products, {len(created.get('users'))} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
