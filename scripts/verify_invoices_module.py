#!/usr/bin/env python3
"""Live check of the Invoices module (two tabs) against the RUNNING stack:  Invoices > Suppliers Invoice (the Goods Receipts)  |  Sales Invoice (client invoices).

    docker compose up -d       # stack must be running
    python scripts/verify_invoices_module.py

Creates two throwaway organizations ("Invoices Check Alpha / Beta") and works through the Organization Portal exactly as the browser does. Proves, from the
pages the portal really serves and from the databases themselves:

  * the sidebar has an Invoices group (Suppliers Invoice, Sales Invoice) and Purchasing / Sales no longer list Goods Receipts / Invoices;
  * the existing goods receipt appears once under Suppliers Invoice and the existing sales invoice once under Sales Invoice (no duplicate records), each tab's
    search and filters work, and the receipt / invoice pages, the invoice PDF and the creation page still open at their old addresses;
  * the old list addresses (/goods-receipts, /invoices) redirect, with their filters, to the new tabs;
  * confirming a goods receipt puts the stock in once; invoicing and payment never change stock;
  * another organization sees none of it (lists, detail pages);
  * permissions: Purchasing only -> only Suppliers Invoice (the Sales tab is denied and the sales API refuses), Sales only -> the reverse, both -> both.

Everything it created is deleted afterwards, by exact id. No emails are sent and no existing record is touched.
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
    raw = res.read()
    text = raw.decode(errors="replace")
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    out_headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, text, set_cookies, out_headers, raw


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


def group_html(html: str, group: str) -> str:
    """The part of the sidebar that belongs to one navigation group."""
    match = re.search(rf'data-nav-group="{group}".*?(?=data-nav-group=|</nav>)', html, re.S)
    return match.group(0) if match else ""


def main() -> int:
    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "invcheck-sa@example.org"
    emails = {"a": "invcheck-admin-a@example.org", "b": "invcheck-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        status, text, sc, hdrs, raw = call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})
        return status, text, hdrs, raw

    def page(key, path):
        status, text, hdrs, _ = portal(key, "GET", path)
        return status, text.replace("<!-- -->", ""), hdrs

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (Decimal(x) for x in row.split("|"))
        return on_hand, reserved

    def movements(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}'") or "0")

    def set_modules(org_key, **flags):
        for module, enabled in flags.items():
            psql("impex_organizations", f"UPDATE organization_modules SET enabled = {str(enabled).lower()} WHERE organization_id = '{org_ids[org_key]}' AND module_key = '{module}'")

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='INVcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key, name in (("a", "Invoices Check Alpha"), ("b", "Invoices Check Beta")):
            status, text, _, _, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"invcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
            org_ids[key] = jbody(text).get("id")
            created.add("organizations", org_ids[key])
            status, text, _, _, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[key], "full_name": f"Admin {key.upper()}", "email": emails[key], "password": password}, {"X-Internal-Key": internal_key})
            created.add("users", jbody(text).get("id"))
            status, text, _, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[key], "password": password})
            tokens[key] = jbody(text).get("access_token")
            status, text, sc, _, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[key], "password": password})
            cookies[key] = cookie_value(sc, "impex_tenant_session")
            check(f"organization {key.upper()} and its administrator exist and can sign in", org_ids[key] and tokens[key] and cookies[key], (status, text))
            mark_setup_complete(psql, org_ids[key])
            set_modules(key, inventory=True, purchasing=True, sales=True)

        # ---- real data: a confirmed goods receipt (stock 0 -> 500) and an issued sales invoice, in organization A; something small in B
        def register(key, sku, name):
            status, text, _, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "unit": "pcs", "costPrice": "3.20", "sellingPrice": "6.00", "currencyCode": "USD"})
            product = jbody(text).get("product", {})
            created.add("products", product.get("id"))
            return product

        widget, b_widget = register("a", "IV-WIDGET", "IV Widget"), register("b", "IV-WIDGET", "IV Beta widget")
        s, text, _, _ = portal("a", "POST", "/api/purchasing/suppliers", {"name": "IV Supplier"})
        supplier = jbody(text).get("supplier", {})
        s, text, _, _ = portal("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        po = jbody(text).get("order", {})
        portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/lines", {"productId": widget["id"], "quantity": "500", "unitPrice": "3.10"})
        portal("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/order")
        line_id = jbody(portal("a", "GET", f"/api/purchasing/purchase-orders/{po['id']}")[1]).get("order", {}).get("lines", [{}])[0].get("id")
        s, text, _, _ = portal("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po["id"], "supplierReference": "DN-IV-7", "lines": [{"purchaseOrderLineId": line_id, "acceptedQuantity": "500", "rejectedQuantity": "0"}]}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        receipt = jbody(text).get("receipt", {})
        draft_receipt_state = figures(widget["id"])
        s, text, _, _ = portal("a", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")
        check("a goods receipt is created and confirmed: stock goes 0 -> 500 exactly once (one movement)",
              s == 200 and draft_receipt_state == (Decimal("0"), Decimal("0")) and figures(widget["id"]) == (Decimal("500"), Decimal("0")) and movements(widget["id"]) == 1, (s, text))
        receipt_number = jbody(portal("a", "GET", f"/api/purchasing/goods-receipts/{receipt['id']}")[1]).get("receipt", {}).get("number")

        s, text, _, _ = portal("a", "POST", "/api/sales/clients", {"name": "IV Client Ltd"})
        client = jbody(text).get("client", {})
        s, text, _, _ = portal("a", "POST", "/api/sales/orders", {"clientId": client["id"], "currencyCode": "USD", "lines": [{"productId": widget["id"], "quantity": "100", "unitPrice": "6.00"}]}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        order = jbody(text).get("order", {})
        list_id = (order.get("delivery_list") or {}).get("id")
        dl = jbody(portal("a", "GET", f"/api/sales/delivery-lists/{list_id}")[1]).get("list", {})
        item = next(i for i in dl["items"] if i["product_id"] == widget["id"])
        s, text, _, _ = portal("a", "POST", "/api/sales/dispatches", {"deliveryListId": list_id, "lines": [{"deliveryListItemId": item["id"], "quantity": "100"}]}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        dispatch = jbody(text).get("dispatch", {})
        portal("a", "POST", f"/api/sales/dispatches/{dispatch['id']}/confirm")
        stock_after_delivery = (figures(widget["id"]), movements(widget["id"]))
        dd = jbody(portal("a", "GET", f"/api/sales/dispatches/{dispatch['id']}")[1]).get("dispatch", {})
        dline = next(l for l in dd["lines"] if l["product_id"] == widget["id"])
        s, text, _, _ = portal("a", "POST", "/api/sales/invoices", {"clientId": client["id"], "currencyCode": "USD", "lines": [{"dispatchLineId": dline["id"], "quantity": "100", "unitPrice": "6.50"}]}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        invoice = jbody(text).get("invoice", {})
        s, text, _, _ = portal("a", "POST", f"/api/sales/invoices/{invoice['id']}/issue")
        invoice_number = jbody(text).get("invoice", {}).get("number")
        s, text, _, _ = portal("a", "POST", f"/api/sales/invoices/{invoice['id']}/payments", {"amount": "650.00", "method": "bank_transfer"}, {"Idempotency-Key": f"iv-{uuid.uuid4()}"})
        check("a sales invoice is issued and paid in full; invoicing and payment change no stock",
              bool(invoice_number) and s == 201 and stock_after_delivery == ((Decimal("400"), Decimal("0")), 2) and (figures(widget["id"]), movements(widget["id"])) == stock_after_delivery, (invoice_number, s, stock_after_delivery))

        print("\n== 1. the sidebar: an Invoices group; Purchasing and Sales no longer list Goods Receipts / Invoices")
        s, html, _ = page("a", "/stock")
        names = re.findall(r'data-nav-group="([a-z]+)"', html)
        check("the groups are Main, Inventory, Purchasing, Sales, Invoices, Workspace, in that order", names == ["main", "inventory", "purchasing", "sales", "invoices", "workspace"], names)
        inv, pur, sal = group_html(html, "invoices"), group_html(html, "purchasing"), group_html(html, "sales")
        check("Invoices lists Suppliers Invoice and Sales Invoice", 'href="/invoices/suppliers"' in inv and 'href="/invoices/sales"' in inv and "Suppliers Invoice" in inv and "Sales Invoice" in inv, inv[:200])
        check("Purchasing lists Suppliers and Purchase Orders only (no Goods Receipts)", 'href="/suppliers"' in pur and 'href="/purchase-orders"' in pur and "/goods-receipts" not in pur and "Goods Receipts" not in pur)
        check("Sales lists Clients, Create Order and Delivery Lists only (no Invoices)", all(f'href="{h}"' in sal for h in ("/clients", "/sales-orders/new", "/delivery-lists")) and 'href="/invoices' not in sal)
        check("no Products or Dispatches entries came back", 'href="/products"' not in html and 'href="/dispatches"' not in html and 'href="/scan"' not in html)

        print("\n== 2. Suppliers Invoice: the existing goods receipts, once each")
        s, html, _ = page("a", "/invoices/suppliers")
        check("the page has the Invoices title, the supporting line and both tabs, Suppliers Invoice current",
              s == 200 and "Manage supplier receipts and customer invoices in one place." in html and re.search(r'<a[^>]*aria-current="page"[^>]*href="/invoices/suppliers"|<a[^>]*href="/invoices/suppliers"[^>]*aria-current="page"', html) is not None, s)
        check("the goods receipt is listed ONCE, linked to its own page, with its purchase order, supplier and supplier reference",
              html.count(f'href="/goods-receipts/{receipt["id"]}"') == 1 and receipt_number in html and po["number"] in html and "IV Supplier" in html and "DN-IV-7" in html and "Confirmed" in html)
        check("nothing is invented: no invoice total, due date, paid or payment status on the supplier side", "Outstanding" not in html and "Due date" not in html and "Payment" not in html and "own bill is not recorded" in html)
        for label, query, present in (("search by receipt number", f"?q={receipt_number}", True), ("search by supplier reference", "?q=DN-IV-7", True), ("search that matches nothing", "?q=zzz-nothing", False),
                                      ("status Confirmed", "?status=confirmed", True), ("status Draft", "?status=draft", False),
                                      ("the supplier filter", f"?supplier={supplier['id']}", True), ("a date range containing today", "?from=2000-01-01&to=2100-01-01", True), ("a date range in the past", "?from=2000-01-01&to=2000-01-02", False)):
            s, html, _ = page("a", "/invoices/suppliers" + query)
            check(f"Suppliers Invoice filter: {label} ({'shows' if present else 'hides'} the receipt)", s == 200 and (receipt_number in html) == present, (s, query))
        s, html, _ = page("a", "/invoices/suppliers?page=9")
        check("a page beyond the last one answers 200 with the empty state (pagination is safe)", s == 200 and receipt_number not in html)

        print("\n== 3. Sales Invoice: the existing client invoices, once each")
        s, html, _ = page("a", "/invoices/sales")
        check("the Sales Invoice tab is current, with New Invoice", s == 200 and re.search(r'<a[^>]*aria-current="page"[^>]*href="/invoices/sales"|<a[^>]*href="/invoices/sales"[^>]*aria-current="page"', html) is not None and "New Invoice" in html)
        check("the invoice is listed ONCE, linked to its own page, with client and status", html.count(f'href="/invoices/{invoice["id"]}"') == 1 and invoice_number in html and "IV Client Ltd" in html and "Paid" in html)
        for label, query, present in (("search by number", f"?q={invoice_number}", True), ("search by client", "?q=IV%20Client", True), ("search that matches nothing", "?q=zzz-nothing", False),
                                      ("status Paid", "?status=paid", True), ("status Draft", "?status=draft", False), ("payment Paid", "?payment=paid", True), ("payment Unpaid", "?payment=unpaid", False),
                                      ("the client filter", f"?client={client['id']}", True), ("a date range in the past", "?from=2000-01-01&to=2000-01-02", False)):
            s, html, _ = page("a", "/invoices/sales" + query)
            check(f"Sales Invoice filter: {label} ({'shows' if present else 'hides'} the invoice)", s == 200 and (invoice_number in html) == present, (s, query))

        print("\n== 4. old addresses keep working")
        s, _, h = page("a", "/goods-receipts?q=DN-IV-7&status=confirmed")
        check("/goods-receipts?... redirects to Suppliers Invoice with its filters", s in (307, 308) and h.get("location", "").endswith("/invoices/suppliers?q=DN-IV-7&status=confirmed"), (s, h.get("location")))
        s, _, h = page("a", f"/invoices?client={client['id']}&status=paid")
        check("/invoices?... redirects to Sales Invoice with its filters", s in (307, 308) and h.get("location", "").endswith(f"/invoices/sales?status=paid&client={client['id']}"), (s, h.get("location")))
        s, html, _ = page("a", f"/goods-receipts/{receipt['id']}")
        check("a goods receipt's own page still opens (from a purchase order or a bookmark), under the Suppliers Invoice tab", s == 200 and receipt_number in html and re.search(r'<a[^>]*aria-current="page"[^>]*href="/invoices/suppliers"|<a[^>]*href="/invoices/suppliers"[^>]*aria-current="page"', html) is not None, s)
        s, html, _ = page("a", f"/purchase-orders/{po['id']}")
        check("the purchase order still links to its receipt", s == 200 and f'href="/goods-receipts/{receipt["id"]}"' in html, s)
        s, html, _ = page("a", f"/invoices/{invoice['id']}")
        check("an invoice's own page still opens, under the Sales Invoice tab", s == 200 and invoice_number in html and "IV Client Ltd" in html and re.search(r'<a[^>]*aria-current="page"[^>]*href="/invoices/sales"|<a[^>]*href="/invoices/sales"[^>]*aria-current="page"', html) is not None, s)
        s, html, _ = page("a", f"/invoices/new?client={client['id']}")
        check("the new-invoice page still opens", s == 200 and "IV Client Ltd" in html, s)
        s, html, _ = page("a", f"/clients/{client['id']}")
        check("the client's account page links to its invoices at the new address", s == 200 and f"/invoices/sales?client={client['id']}" in html, s)
        s, text, hdrs, raw = portal("a", "GET", f"/api/sales/invoices/{invoice['id']}/pdf")
        check("the invoice PDF still downloads (application/pdf)", s == 200 and raw.startswith(b"%PDF-") and hdrs.get("content-type") == "application/pdf", (s, hdrs.get("content-type")))
        paid = jbody(portal("a", "GET", f"/api/sales/invoices/{invoice['id']}")[1]).get("invoice", {})
        check("the invoice, its number and its payment are unchanged (paid in full)", paid.get("number") == invoice_number and paid.get("status") == "paid" and paid.get("outstanding") == "0.0000")

        print("\n== 5. tenant isolation")
        s, html, _ = page("b", "/invoices/suppliers")
        check("organization B's Suppliers Invoice tab shows none of A's receipts", s == 200 and receipt_number not in html and "IV Supplier" not in html and "DN-IV-7" not in html)
        s, html, _ = page("b", "/invoices/sales")
        check("organization B's Sales Invoice tab shows none of A's invoices", s == 200 and invoice_number not in html and "IV Client Ltd" not in html)
        s, html, _ = page("b", f"/goods-receipts/{receipt['id']}")
        check("B cannot open A's goods receipt", receipt_number not in html and "IV Supplier" not in html, s)
        s, html, _ = page("b", f"/invoices/{invoice['id']}")
        check("B cannot open A's invoice", invoice_number not in html and "IV Client Ltd" not in html, s)
        check("B has no stock movements of its own that came from A's receipt or invoice", movements(b_widget["id"]) == 0)

        print("\n== 6. permissions (Module Management): each tab needs its own module")
        denied = lambda html, module: f'data-module-denied="{module}"' in html
        # Purchasing only
        set_modules("a", purchasing=True, sales=False)
        s, html, _ = page("a", "/invoices/suppliers")
        inv = group_html(html, "invoices")
        check("Purchasing only: the Suppliers Invoice tab works and the menu offers only that tab", s == 200 and receipt_number in html and 'href="/invoices/suppliers"' in inv and 'href="/invoices/sales"' not in inv, s)
        s, html, _ = page("a", "/invoices/sales")
        check("...the Sales Invoice tab is denied (the page is never rendered)", denied(html, "sales") and invoice_number not in html)
        s, html, _ = page("a", f"/invoices/{invoice['id']}")
        check("...and an invoice's own page is denied too", denied(html, "sales") and invoice_number not in html)
        s, _, h = page("a", "/invoices")
        check("...and /invoices forwards to the tab it may use", s in (307, 308) and h.get("location", "").endswith("/invoices/suppliers"), (s, h.get("location")))
        s, text, _, _ = portal("a", "GET", "/api/sales/invoices")
        check("...and the Sales API itself refuses (403, module_disabled)", s == 403 and jbody(text).get("code") == "module_disabled", (s, text[:120]))
        # Sales only
        set_modules("a", purchasing=False, sales=True)
        s, html, _ = page("a", "/invoices/sales")
        inv = group_html(html, "invoices")
        check("Sales only: the Sales Invoice tab works and the menu offers only that tab", s == 200 and invoice_number in html and 'href="/invoices/sales"' in inv and 'href="/invoices/suppliers"' not in inv, s)
        s, html, _ = page("a", "/invoices/suppliers")
        check("...the Suppliers Invoice tab is denied", denied(html, "purchasing") and receipt_number not in html)
        s, html, _ = page("a", f"/goods-receipts/{receipt['id']}")
        check("...and a goods receipt's own page is denied too", denied(html, "purchasing") and receipt_number not in html)
        s, _, h = page("a", "/invoices")
        check("...and /invoices keeps going to Sales Invoice", s in (307, 308) and h.get("location", "").endswith("/invoices/sales"), (s, h.get("location")))
        s, text, _, _ = portal("a", "GET", "/api/purchasing/goods-receipts")
        check("...and the Purchasing API itself refuses (403, module_disabled)", s == 403 and jbody(text).get("code") == "module_disabled", (s, text[:120]))
        # neither
        set_modules("a", purchasing=False, sales=False)
        s, html, _ = page("a", "/stock")
        check("Inventory only: there is no Invoices group at all", 'data-nav-group="invoices"' not in html)
        # both again
        set_modules("a", purchasing=True, sales=True)
        s, html, _ = page("a", "/invoices/suppliers")
        inv = group_html(html, "invoices")
        check("both enabled again: both tabs are back and the data is exactly as it was", s == 200 and receipt_number in html and 'href="/invoices/sales"' in inv and 'href="/invoices/suppliers"' in inv)
        check("through all of that, stock never changed", (figures(widget["id"]), movements(widget["id"])) == stock_after_delivery)
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
