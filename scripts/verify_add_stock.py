#!/usr/bin/env python3
"""Live check of the Stock page's "Add Stock" (register a NEW product, optionally with the quantity already owned) against the RUNNING stack.

    docker compose up -d       # stack must be running
    python scripts/verify_add_stock.py

It works through the portal's own server routes exactly as the browser does (Add Stock = POST /api/products, then, only when a quantity above zero was
entered, POST /api/stock/opening with an Idempotency-Key), and proves from the DATABASES themselves:

  * Scenario A: a product registered with NO opening quantity exists with 0 physical / 0 reserved / 0 available and has NO stock movement;
  * Scenario B: a product registered with 35 already owned gets exactly ONE opening movement (35 on hand, 35 available); retrying the same request (same
    key) is replayed and counts nothing twice; asking again with a different key is refused, because the product already has stock history;
  * a duplicate SKU is refused and creates nothing; no category exists anywhere; the old Products tab and the redundant New product button are not offered;
  * Opening Balance still works for an eligible existing product and is refused once a product has stock history;
  * Stock In / Stock Out of an existing product still work, and Stock Out can never take reserved stock (500/400/100-style protection);
  * a goods receipt still increases stock exactly once; a registered barcode is still found by scanning;
  * another organization can neither see nor change any of it.

It creates two throwaway organizations ("Add Stock Check Alpha / Beta") and deletes exactly what it created, by id. No emails are sent.
"""
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import uuid
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, INVENTORY, TENANT_PORTAL = 8000, 8001, 8002, 3001
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


def check(name: str, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""), flush=True)


def call(port, method, path, body=None, headers=None, cookies=None):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    conn.request(method, path, json.dumps(body) if body is not None else None, hdrs)
    res = conn.getresponse()
    text = res.read().decode(errors="replace")
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    conn.close()
    return res.status, text, set_cookies


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
    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "asccheck-sa@example.org"
    emails = {"a": "asccheck-admin-a@example.org", "b": "asccheck-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        status, text, _ = call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})
        return status, text

    def page(key, path):
        status, text = portal(key, "GET", path)
        return status, text.replace("<!-- -->", "")

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (Decimal(x) for x in row.split("|"))
        return on_hand, reserved, on_hand - reserved

    def movements(product_id, kind=None):
        extra = f" AND movement_type = '{kind}'" if kind else ""
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}'{extra}") or "0")

    def add_stock(key, sku, name, opening=None, unit="pcs", idem=None):
        """What the Add Stock dialog does: register the product; only when a quantity above zero was entered, record it as the opening balance."""
        status, text = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "unit": unit, "costPrice": "620", "sellingPrice": "799", "currencyCode": "USD", "description": ""})
        product = jbody(text).get("product", {})
        created.add("products", product.get("id"))
        op_status = None
        if status == 201 and opening and Decimal(opening) > 0:
            op_status, _ = portal(key, "POST", "/api/stock/opening", {"product_id": product["id"], "quantity": opening}, {"Idempotency-Key": idem or f"asc-{uuid.uuid4()}"})
        return status, product, op_status, text

    def stock_call(key, action, product_id, quantity, idem=None):
        s, text = portal(key, "POST", f"/api/stock/{action}", {"product_id": product_id, "quantity": quantity}, {"Idempotency-Key": idem or f"asc-{uuid.uuid4()}"})
        return s, jbody(text)

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='ASCcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key, name in (("a", "Add Stock Check Alpha"), ("b", "Add Stock Check Beta")):
            status, text, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"asccheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
            org_ids[key] = jbody(text).get("id")
            created.add("organizations", org_ids[key])
            status, text, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[key], "full_name": f"Admin {key.upper()}", "email": emails[key], "password": password}, {"X-Internal-Key": internal_key})
            created.add("users", jbody(text).get("id"))
            status, text, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[key], "password": password})
            tokens[key] = jbody(text).get("access_token")
            status, text, sc = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[key], "password": password})
            cookies[key] = cookie_value(sc, "impex_tenant_session")
            check(f"organization {key.upper()} and its administrator exist and can sign in", org_ids[key] and tokens[key] and cookies[key], (status, text))
            mark_setup_complete(psql, org_ids[key])

        print("\n== 1. the Stock page: Add Stock / Remove Stock / Opening Balance; no New product button, no Products tab")
        s, html = page("a", "/stock")
        check("the three top buttons are there and the redundant 'New product' button is not", s == 200 and all(f">{b}</button>" in html for b in ("Add Stock", "Remove Stock", "Opening Balance")) and ">New product<" not in html, s)
        check("Add Stock is enabled even with no products yet; Remove Stock and Opening Balance wait for a product",
              not re.search(r"<button[^>]*disabled[^>]*>Add Stock", html) and re.search(r"<button[^>]*disabled[^>]*>Remove Stock", html) is not None and "No products yet" in html)
        check("there is no Products tab and no Scan Product tab in the menu", 'href="/products"' not in html and 'href="/scan"' not in html)

        print("\n== 2. Scenario A: Cisco Router, no existing stock")
        s, cisco, op, text = add_stock("a", "cisco-001", "Cisco Router")
        check("the product is registered (201), SKU in capitals, and has no category", s == 201 and cisco.get("sku") == "CISCO-001" and "category" not in cisco, (s, text[:200]))
        check("physical 0 / reserved 0 / available 0 and NO stock movement at all (no artificial ledger entry)", figures(cisco["id"]) == (Decimal("0"), Decimal("0"), Decimal("0")) and movements(cisco["id"]) == 0)
        s, html = page("a", "/stock")
        check("it shows in the Stock table straight away with 0 available and a Total column (there is no On hand column)", 'data-testid="available-CISCO-001">0<' in html and 'data-testid="total-CISCO-001"' in html and 'data-testid="onhand-' not in html, s)
        s, text = portal("a", "POST", "/api/products", {"sku": "Cisco-001", "name": "Duplicate router", "unit": "pcs", "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD"})
        check("a duplicate SKU is refused (409, on the SKU) and creates nothing", s == 409 and "sku" in (jbody(text).get("fieldErrors") or {}) and psql("impex_inventory", f"SELECT count(*) FROM products WHERE organization_id = '{org_ids['a']}'") == "1", (s, text[:160]))

        print("\n== 3. Scenario B: Dell Latitude Laptop, 35 already owned")
        key_b = f"asc-{uuid.uuid4()}"
        s, dell, op, text = add_stock("a", "dell-001", "Dell Latitude Laptop", opening="35", idem=key_b)
        check("the product is registered and its 35 units are recorded through the existing Opening Balance endpoint (201 + 201)", s == 201 and op == 201, (s, op, text[:160]))
        check("exactly ONE movement exists and it is an opening movement of 35", movements(dell["id"]) == 1 and movements(dell["id"], "opening") == 1
              and psql("impex_inventory", f"SELECT quantity::text FROM stock_movements WHERE product_id = '{dell['id']}'") == "35.0000")
        check("35 on hand, 0 reserved, 35 available", figures(dell["id"]) == (Decimal("35"), Decimal("0"), Decimal("35")), figures(dell["id"]))
        s, html = page("a", "/stock?q=dell")
        check("the Stock page shows 35 available and a Total of 35 x 799.00 = 27,965.00 USD", 'data-testid="available-DELL-001">35<' in html and 'data-testid="total-DELL-001">27,965.00 USD<' in html, s)
        s, text = portal("a", "POST", "/api/stock/opening", {"product_id": dell["id"], "quantity": "35"}, {"Idempotency-Key": key_b})
        check("retrying the SAME request (the dialog's 'Record opening quantity') is replayed (200) and counts nothing twice", s == 200 and jbody(text).get("operation", {}).get("replayed") is True and figures(dell["id"])[0] == Decimal("35") and movements(dell["id"]) == 1, (s, text[:160]))
        s, body = stock_call("a", "opening", dell["id"], "35")
        check("asking again with a DIFFERENT key is refused (409: it already has stock history), so even a lost answer cannot double-count", s == 409 and "stock history" in json.dumps(body) and "Stock In" in json.dumps(body) and figures(dell["id"])[0] == Decimal("35") and movements(dell["id"]) == 1, (s, body))

        print("\n== 4. Opening Balance: eligible products only (the backend rule is unchanged)")
        s, late, _, _ = add_stock("a", "late-001", "Late opening")
        s1, b1 = stock_call("a", "opening", late["id"], "10")
        check("Opening Balance for an existing product without history works (201)", s1 == 201 and figures(late["id"])[0] == Decimal("10") and movements(late["id"], "opening") == 1, (s1, b1))
        s, used, _, _ = add_stock("a", "used-001", "Already moved")
        stock_call("a", "in", used["id"], "5")
        s2, b2 = stock_call("a", "opening", used["id"], "99")
        check("...but it is refused once the product has other movements (409) and nothing is overwritten", s2 == 409 and figures(used["id"])[0] == Decimal("5") and movements(used["id"]) == 1, (s2, b2))

        print("\n== 5. Stock In / Stock Out of an existing product, and reserved stock stays protected")
        s, _ = stock_call("a", "in", dell["id"], "5")
        check("Stock In (+5) works: 40 on hand", s == 201 and figures(dell["id"])[0] == Decimal("40"), s)
        s, _ = stock_call("a", "out", dell["id"], "10")
        check("Stock Out (-10) works: 30 on hand", s == 201 and figures(dell["id"])[0] == Decimal("30"), s)
        s, text = portal("a", "POST", "/api/sales/clients", {"name": "ASC Client Ltd"})
        client = jbody(text).get("client", {})
        s, text = portal("a", "POST", "/api/sales/orders", {"clientId": client["id"], "lines": [{"productId": dell["id"], "quantity": "25"}]}, {"Idempotency-Key": f"asc-{uuid.uuid4()}"})
        check("a sales order reserves 25 of the 30 (30 on hand / 25 reserved / 5 available)", s == 201 and figures(dell["id"]) == (Decimal("30"), Decimal("25"), Decimal("5")), (s, text[:160], figures(dell["id"])))
        s, body = stock_call("a", "out", dell["id"], "6")
        check("a Stock Out of 6 is refused (only 5 are available) and nothing changes", s in (400, 409, 422) and figures(dell["id"]) == (Decimal("30"), Decimal("25"), Decimal("5")), (s, body))
        s, _ = stock_call("a", "out", dell["id"], "5")
        check("a Stock Out of exactly the 5 available is allowed, and stock never falls below what is reserved (25 on hand / 25 reserved / 0 available)", s == 201 and figures(dell["id"]) == (Decimal("25"), Decimal("25"), Decimal("0")), figures(dell["id"]))

        print("\n== 6. goods receipts still add stock exactly once; scanning and barcodes still work")
        s, text = portal("a", "POST", "/api/purchasing/suppliers", {"name": "ASC Supplier"})
        supplier = jbody(text).get("supplier", {})
        s, text = portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"asc-{uuid.uuid4()}"})
        po = jbody(text).get("order", {})
        portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/lines", {"productId": cisco["id"], "quantity": "20", "unitPrice": "500"})
        portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/order")
        line_id = jbody(portal("a", "GET", f"/api/purchasing/purchase-orders/{po['id']}")[1]).get("order", {}).get("lines", [{}])[0].get("id")
        s, text = portal("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po["id"], "lines": [{"purchaseOrderLineId": line_id, "acceptedQuantity": "20", "rejectedQuantity": "0"}]}, {"Idempotency-Key": f"asc-{uuid.uuid4()}"})
        receipt = jbody(text).get("receipt", {})
        check("a draft goods receipt changes no stock (Cisco Router still 0)", figures(cisco["id"])[0] == Decimal("0") and movements(cisco["id"]) == 0)
        s, text = portal("a", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")
        portal("a", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")  # a second confirmation must change nothing
        check("confirming the receipt puts 20 in stock exactly once (one receipt movement)", s == 200 and figures(cisco["id"])[0] == Decimal("20") and movements(cisco["id"]) == 1 and movements(cisco["id"], "in") == 1, (s, figures(cisco["id"]), movements(cisco["id"])))
        s, text = portal("a", "POST", f"/api/products/{dell['id']}/identifiers", {"kind": "manufacturer", "value": "5901234123457"})
        check("a manufacturer barcode can still be registered on the new product (201)", s == 201, (s, text[:160]))
        s, text = portal("a", "GET", "/api/scan/resolve?code=5901234123457")
        check("...and scanning it finds the product, with its stock figures", s == 200 and jbody(text).get("product", {}).get("id") == dell["id"] and jbody(text).get("stock", {}).get("total_quantity") == "25.0000", (s, text[:200]))

        print("\n== 7. tenant isolation")
        s, html = page("b", "/stock")
        check("organization B's Stock page shows none of A's products", s == 200 and "Dell Latitude Laptop" not in html and "Cisco Router" not in html and "DELL-001" not in html)
        s, body = stock_call("b", "opening", cisco["id"], "50")
        check("B cannot record an opening balance for A's product (404, like a missing one)", s == 404 and figures(cisco["id"])[0] == Decimal("20"), (s, body))
        s, body = stock_call("b", "in", dell["id"], "1")
        check("...nor Stock In on it", s == 404 and figures(dell["id"])[0] == Decimal("25"), (s, body))
        s, b_dell, op, _ = add_stock("b", "dell-001", "Beta's own Dell", opening="3")
        check("the same SKU in B is allowed and is B's own stock (3), untouched by A's 25", s == 201 and op == 201 and figures(b_dell["id"])[0] == Decimal("3") and figures(dell["id"])[0] == Decimal("25"))
        check("the products table still has no category column", psql("impex_inventory", "SELECT count(*) FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'category'") == "0")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "sales order requests": delete_exact(psql, "impex_sales", "sales_order_requests", orgs, "organization_id"),
            "sales orders": delete_exact(psql, "impex_sales", "sales_orders", orgs, "organization_id", ledger=True),
            "sales counters": delete_exact(psql, "impex_sales", "sales_order_counters", orgs, "organization_id"),
            "list items": delete_exact(psql, "impex_sales", "delivery_list_items", orgs, "organization_id", ledger=True),
            "lists": delete_exact(psql, "impex_sales", "delivery_lists", orgs, "organization_id"),
            "list counters": delete_exact(psql, "impex_sales", "delivery_list_counters", orgs, "organization_id"),
            "clients": delete_exact(psql, "impex_sales", "clients", orgs, "organization_id"),
            "receipt lines": delete_exact(psql, "impex_purchasing", "goods_receipt_lines", orgs, "organization_id", ledger=True),
            "receipt requests": delete_exact(psql, "impex_purchasing", "goods_receipt_requests", orgs, "organization_id"),
            "receipts": delete_exact(psql, "impex_purchasing", "goods_receipts", orgs, "organization_id", ledger=True),
            "receipt counters": delete_exact(psql, "impex_purchasing", "goods_receipt_counters", orgs, "organization_id"),
            "order lines": delete_exact(psql, "impex_purchasing", "purchase_order_lines", orgs, "organization_id", ledger=True),
            "order requests (po)": delete_exact(psql, "impex_purchasing", "purchase_order_requests", orgs, "organization_id"),
            "purchase orders": delete_exact(psql, "impex_purchasing", "purchase_orders", orgs, "organization_id", ledger=True),
            "po counters": delete_exact(psql, "impex_purchasing", "purchase_order_counters", orgs, "organization_id"),
            "suppliers": delete_exact(psql, "impex_purchasing", "suppliers", orgs, "organization_id"),
            "reservations": delete_exact(psql, "impex_inventory", "stock_reservations", orgs, "organization_id"),
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
