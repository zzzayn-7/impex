#!/usr/bin/env python3
"""End-to-end check of the trading workflow against the RUNNING stack:  Supplier -> Purchase Order -> Goods Receipt -> Stock -> Sales Order -> Delivery -> Invoice.

    docker compose up -d       # stack must be running (inventory 0009, purchasing, sales at head)
    python scripts/verify_trading_flow.py

The standalone Products tab is gone: products are registered while buying (a purchase order's "Add New Product") and viewed / corrected from Stock. This script
works through the portal's own server routes exactly as the browser does and proves, from the DATABASES themselves:

  * the Products entry is not in the menu (Stock and Movements are), the old /products page still answers, and the existing product records are intact;
  * a product registered from the purchase order form (with its barcode) exists in the Inventory Service, can be found again by SKU, by name and by barcode,
    and registering it, ordering it and placing the order do NOT change physical stock;
  * physical stock rises only when the goods receipt is CONFIRMED (0 -> 500);
  * a sales order for 400 reserves 400 (500 physical / 400 reserved / 100 available) and a manual stock-out can take at most the 100 that are available;
  * a confirmed dispatch deducts the physical stock AND consumes the reservation (100 / 0 / 100); an invoice can then be issued and paid in full;
  * duplicate SKUs are refused inside an organization (and allowed in another), the same product can be bought from two suppliers, and another organization
    can neither see nor open the product.

It creates two throwaway organizations ("Trade Check Alpha / Beta") and deletes exactly what it created, by id, afterwards. No emails are sent.
"""
import http.client
import json
import os
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
    sa_email = "tradecheck-sa@example.org"
    emails = {"a": "tradecheck-admin-a@example.org", "b": "tradecheck-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path):
        status, text, _ = portal(key, "GET", path)
        return status, text.replace("<!-- -->", "")

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (Decimal(x) for x in row.split("|"))
        return on_hand, reserved, on_hand - reserved

    def movements(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}'") or "0")

    def register_product(key, sku, name, cost="3.20", selling="6.00", unit="pcs", currency="USD"):
        status, text, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "unit": unit, "costPrice": cost, "sellingPrice": selling, "currencyCode": currency, "description": "check"})
        body = jbody(text)
        created.add("products", (body.get("product") or {}).get("id"))
        return status, body

    def make_po(key, supplier_id, lines):
        status, text, _ = portal(key, "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier_id, "currencyCode": "USD"}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        order = jbody(text).get("order", {})
        added = [portal(key, "POST", f"/api/purchasing/purchase-orders/{order['id']}/lines", {"productId": p, "quantity": q, "unitPrice": price}) for p, q, price in lines]
        return order, added

    def po_detail(key, order_id):
        return jbody(portal(key, "GET", f"/api/purchasing/purchase-orders/{order_id}")[1]).get("order", {})

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='TFcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key, name in (("a", "Trade Check Alpha"), ("b", "Trade Check Beta")):
            status, text, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"tfcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        # an EXISTING product (registered before, with stock): it must stay fully usable once the Products tab is gone
        s, body = register_product("a", "TF-LEGACY", "TF legacy hammer", cost="8.00", selling="12.50")
        legacy = body.get("product", {})
        portal("a", "POST", "/api/stock/opening", {"product_id": legacy.get("id"), "quantity": "20"}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        check("an existing product with 20 in stock is set up", s == 201 and figures(legacy["id"])[0] == Decimal("20"), (s, body))

        print("\n== 1. navigation: Stock and Movements, no Products entry; the old page still answers")
        s, html = page("a", "/stock")
        check("the Stock page's menu has Stock and Movements and NO link to /products", s == 200 and 'href="/stock"' in html and 'href="/movements"' in html and 'href="/products"' not in html)
        check("the Stock page shows the existing product with its prices and its Edit and Delete actions",
              "TF legacy hammer" in html and "12.50 USD" in html and "8.00 USD" in html and "Edit TF legacy hammer" in html and "Delete TF legacy hammer" in html and "Add Stock" in html and "New product" not in html)
        s, html = page("a", "/products")
        check("the old /products page still answers (compatibility) and points to Stock", s == 200 and "TF legacy hammer" in html and "no longer in the menu" in html)

        print("\n== 2. Purchasing: select a supplier, register a NEW product from the purchase order, order 500")
        s, text, _ = portal("a", "POST", "/api/purchasing/suppliers", {"name": "TF Supplier One"})
        sup1 = jbody(text).get("supplier", {})
        s2, text, _ = portal("a", "POST", "/api/purchasing/suppliers", {"name": "TF Supplier Two"})
        sup2 = jbody(text).get("supplier", {})
        check("two suppliers exist", s == 201 and s2 == 201 and sup1.get("id") and sup2.get("id"))
        s, text, _ = portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": sup1["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        po = jbody(text).get("order", {})
        check("a draft purchase order is created for the supplier", s == 201 and po.get("status") == "draft", (s, text))
        s, text, _ = portal("a", "GET", "/api/products?q=widget")
        check("searching the catalog for the product finds nothing yet (it does not exist)", s == 200 and jbody(text).get("items") == [], (s, text))
        s, body = register_product("a", "tf-widget-1", "TF Widget M10")
        widget = body.get("product", {})
        check("Add New Product: registered in the Inventory Service (SKU stored in capitals, selling price kept apart from cost)",
              s == 201 and widget.get("sku") == "TF-WIDGET-1" and widget.get("cost_price") == "3.2000" and widget.get("selling_price") == "6.0000" and "category" not in widget, (s, body))
        s, text, _ = portal("a", "POST", f"/api/products/{widget['id']}/identifiers", {"kind": "manufacturer", "value": "5901234123457"})
        check("...and its manufacturer barcode is registered", s == 201, (s, text))
        s, body = register_product("a", "TF-WIDGET-1", "Duplicate widget")
        check("a duplicate SKU in the same organization is refused (409, on the SKU)", s == 409 and "sku" in (body.get("fieldErrors") or {}), (s, body))
        s, body = register_product("b", "TF-WIDGET-1", "Beta's own widget")
        check("the same SKU in ANOTHER organization is fine", s == 201, (s, body))
        check("registering the product added no stock and no stock movement", figures(widget["id"])[0] == 0 and movements(widget["id"]) == 0)
        for label, query in (("by SKU", "tf-widget"), ("by name", "widget m10")):
            s, text, _ = portal("a", "GET", f"/api/products?q={query.replace(' ', '%20')}")
            check(f"the registered product is found {label}", s == 200 and [i["id"] for i in jbody(text).get("items", [])] == [widget["id"]], (s, text))
        s, text, _ = portal("a", "GET", "/api/scan/resolve?code=5901234123457")
        check("...and by its barcode (scanning)", s == 200 and jbody(text).get("product", {}).get("id") == widget["id"], (s, text))
        s, text, _ = portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/lines", {"productId": widget["id"], "quantity": "500", "unitPrice": "3.10"})
        line = jbody(text).get("line", {})
        check("the product is added to the order: 500 at a purchase price of 3.10 (the product's own cost price stays 3.20)",
              s == 201 and line.get("quantity") == "500.0000" and line.get("unit_price") == "3.1000", (s, text))
        s, text, _ = portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/order")
        placed = po_detail("a", po["id"])
        check("the order is placed (total 1,550.00) and stock is STILL zero: an order adds nothing", s == 200 and placed.get("status") == "ordered" and placed.get("total_amount") == "1550.0000" and figures(widget["id"])[0] == 0 and movements(widget["id"]) == 0, (s, text))
        check("the product's cost and selling prices were not changed by the order", psql("impex_inventory", f"SELECT cost_price::text || '|' || selling_price::text FROM products WHERE id = '{widget['id']}'") == "3.2000|6.0000")

        print("\n== 3. Goods receipt: stock rises only when the receipt is CONFIRMED")
        line_id = placed["lines"][0]["id"]
        s, text, _ = portal("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po["id"], "lines": [{"purchaseOrderLineId": line_id, "acceptedQuantity": "500", "rejectedQuantity": "0"}]}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        receipt = jbody(text).get("receipt", {})
        check("a draft goods receipt for 500 is created", s == 201 and receipt.get("id"), (s, text))
        check("a DRAFT receipt changes no stock", figures(widget["id"])[0] == 0 and movements(widget["id"]) == 0)
        s, text, _ = portal("a", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")
        check("confirming the receipt (200) puts 500 in physical stock, with one movement", s == 200 and figures(widget["id"]) == (Decimal("500"), Decimal("0"), Decimal("500")) and movements(widget["id"]) == 1, (s, text))
        check("the purchase order is now Received", po_detail("a", po["id"]).get("status") == "received")

        print("\n== 4. the same product can be bought from a second supplier, and an existing product can be ordered too")
        po2, added = make_po("a", sup2["id"], [(widget["id"], "50", "3.30"), (legacy["id"], "5", "7.90")])
        check("a second supplier's order takes the same product and the existing one", all(a[0] == 201 for a in added), [a[0] for a in added])
        s, text, _ = portal("b", "GET", f"/api/products/{widget['id']}")
        check("another organization cannot open the product (404, like a missing one)", s == 404, (s, text))
        s, text, _ = portal("a", "GET", f"/api/products/{widget['id']}")
        body = jbody(text)
        check("A can open it: details and its registered barcode", s == 200 and body.get("product", {}).get("sku") == "TF-WIDGET-1" and [i["value"] for i in body.get("identifiers", []) if i["kind"] == "manufacturer"] == ["5901234123457"], (s, text))
        s, text, _ = portal("a", "PATCH", f"/api/products/{widget['id']}", {"name": "TF Widget M10 (steel)", "sellingPrice": "6.50"})
        body = jbody(text).get("product", {})
        check("editing the name and selling price works and leaves SKU, unit and cost alone", s == 200 and body.get("name") == "TF Widget M10 (steel)" and body.get("selling_price") == "6.5000" and body.get("sku") == "TF-WIDGET-1" and body.get("cost_price") == "3.2000", (s, text))
        s, text, _ = portal("a", "PATCH", f"/api/products/{widget['id']}", {"unit": "kg"})
        check("a product that has stock movements keeps its unit (the change is refused)", s in (400, 409, 422) and psql("impex_inventory", f"SELECT unit FROM products WHERE id = '{widget['id']}'") == "pcs", (s, text))

        print("\n== 5. Sales: 400 of 500 reserved, 100 available; a manual stock-out cannot touch the reserved units")
        s, text, _ = portal("a", "POST", "/api/sales/clients", {"name": "TF Client Ltd"})
        client = jbody(text).get("client", {})
        s, text, _ = portal("a", "POST", "/api/sales/orders", {"clientId": client["id"], "lines": [{"productId": widget["id"], "quantity": "400"}]}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        order = jbody(text).get("order", {})
        check("the sales order for 400 is saved and the stock is reserved", s == 201 and figures(widget["id"]) == (Decimal("500"), Decimal("400"), Decimal("100")), (s, text, figures(widget["id"])))
        s, html = page("a", "/stock?q=tf-widget")
        check("the Stock page shows 400 reserved, 100 available and a Total of 500 x 6.50 = 3,250.00 USD for the product",
              s == 200 and 'data-testid="total-TF-WIDGET-1">3,250.00 USD<' in html and 'data-testid="reserved-TF-WIDGET-1">400<' in html and 'data-testid="available-TF-WIDGET-1">100<' in html, s)
        s, text, _ = call(INVENTORY, "GET", "/api/v1/inventory/stock?q=TF-WIDGET", headers=bearer(tokens["a"]))
        item = (jbody(text).get("items") or [{}])[0]
        check("the Inventory Service row carries the prices for the page (cost 3.20, price 6.50)", s == 200 and item.get("cost_price") == "3.2000" and item.get("selling_price") == "6.5000" and item.get("available_quantity") == "100.0000", (s, text))
        s, text, _ = portal("a", "POST", "/api/stock/out", {"product_id": widget["id"], "quantity": "101"}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        check("a manual Stock Out of 101 is refused (only 100 are available)", s in (400, 409, 422) and figures(widget["id"]) == (Decimal("500"), Decimal("400"), Decimal("100")) and movements(widget["id"]) == 1, (s, text))

        print("\n== 6. Delivery: confirming the dispatch deducts the stock and consumes the reservation")
        list_id = (order.get("delivery_list") or {}).get("id")
        dl = jbody(portal("a", "GET", f"/api/sales/delivery-lists/{list_id}")[1]).get("list", {})
        item = next(i for i in dl["items"] if i["product_id"] == widget["id"])
        s, text, _ = portal("a", "POST", "/api/sales/dispatches", {"deliveryListId": list_id, "lines": [{"deliveryListItemId": item["id"], "quantity": "400"}]}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        dispatch = jbody(text).get("dispatch", {})
        check("a dispatch of 400 is prepared (nothing deducted yet)", s == 201 and figures(widget["id"]) == (Decimal("500"), Decimal("400"), Decimal("100")), (s, text))
        s, text, _ = portal("a", "POST", f"/api/sales/dispatches/{dispatch['id']}/confirm")
        check("confirming it: physical 100, reserved 0, available 100", s == 200 and figures(widget["id"]) == (Decimal("100"), Decimal("0"), Decimal("100")) and movements(widget["id"]) == 2, (s, text, figures(widget["id"])))

        print("\n== 7. Invoice and payment")
        dd = jbody(portal("a", "GET", f"/api/sales/dispatches/{dispatch['id']}")[1]).get("dispatch", {})
        dline = next(l for l in dd["lines"] if l["product_id"] == widget["id"])
        s, text, _ = portal("a", "POST", "/api/sales/invoices", {"clientId": client["id"], "currencyCode": "USD", "lines": [{"dispatchLineId": dline["id"], "quantity": "400", "unitPrice": "6.50"}]}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        invoice = jbody(text).get("invoice", {})
        check("an invoice for 400 x 6.50 = 2,600.00 is drafted", s == 201 and invoice.get("total") == "2600.0000", (s, text))
        s, text, _ = portal("a", "POST", f"/api/sales/invoices/{invoice['id']}/issue")
        check("...issued (it gets a number)", s == 200 and jbody(text).get("invoice", {}).get("number"), (s, text))
        s, text, _ = portal("a", "POST", f"/api/sales/invoices/{invoice['id']}/payments", {"amount": "2600.00", "method": "bank_transfer"}, {"Idempotency-Key": f"tf-{uuid.uuid4()}"})
        paid = jbody(portal("a", "GET", f"/api/sales/invoices/{invoice['id']}")[1]).get("invoice", {})
        check("...and paid in full: status paid, nothing outstanding", s == 201 and paid.get("status") == "paid" and paid.get("outstanding") == "0.0000", (s, text, paid.get("status")))
        check("invoicing and paying did not touch the stock", figures(widget["id"]) == (Decimal("100"), Decimal("0"), Decimal("100")) and movements(widget["id"]) == 2)

        print("\n== 8. nothing that existed was lost")
        check("the existing product is unchanged: still 20 in stock, same prices", figures(legacy["id"])[0] == Decimal("20") and psql("impex_inventory", f"SELECT cost_price::text || '|' || selling_price::text FROM products WHERE id = '{legacy['id']}'") == "8.0000|12.5000")
        check("the product table still has no category column and no stock column", psql("impex_inventory", "SELECT count(*) FROM information_schema.columns WHERE table_name = 'products' AND column_name IN ('category', 'quantity', 'stock')") == "0")
        check("no purchase order, receipt or dispatch is left half-way", psql("impex_purchasing", f"SELECT count(*) FROM goods_receipts WHERE status = 'posting' AND organization_id = '{org_ids['a']}'") == "0"
              and psql("impex_sales", f"SELECT count(*) FROM dispatches WHERE status = 'posting' AND organization_id = '{org_ids['a']}'") == "0")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "payments": delete_exact(psql, "impex_sales", "invoice_payments", orgs, "organization_id", ledger=True),
            "allocations": delete_exact(psql, "impex_sales", "invoice_allocations", orgs, "organization_id", ledger=True),
            "invoice lines": delete_exact(psql, "impex_sales", "invoice_lines", orgs, "organization_id", ledger=True),
            "invoice requests": delete_exact(psql, "impex_sales", "invoice_requests", orgs, "organization_id"),
            "invoices": delete_exact(psql, "impex_sales", "invoices", orgs, "organization_id", ledger=True),
            "invoice counters": delete_exact(psql, "impex_sales", "invoice_counters", orgs, "organization_id"),
            "order requests": delete_exact(psql, "impex_sales", "sales_order_requests", orgs, "organization_id"),
            "sales orders": delete_exact(psql, "impex_sales", "sales_orders", orgs, "organization_id", ledger=True),
            "sales counters": delete_exact(psql, "impex_sales", "sales_order_counters", orgs, "organization_id"),
            "dispatch lines": delete_exact(psql, "impex_sales", "dispatch_lines", orgs, "organization_id", ledger=True),
            "dispatch requests": delete_exact(psql, "impex_sales", "dispatch_requests", orgs, "organization_id"),
            "dispatches": delete_exact(psql, "impex_sales", "dispatches", orgs, "organization_id", ledger=True),
            "dispatch counters": delete_exact(psql, "impex_sales", "dispatch_counters", orgs, "organization_id"),
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
