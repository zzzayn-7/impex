#!/usr/bin/env python3
"""Live check of Delivery Lists > Generate Invoice against the RUNNING stack.

    docker compose up -d       # stack must be running
    python scripts/verify_generate_invoice.py

Creates two throwaway organizations ("GenInv Check Alpha / Beta") and works through the Organization Portal exactly as the browser does. Proves, from the
pages the portal really serves and from the databases themselves:

  * a dispatched order's card (Delivered History, and the same card the page shows right after the dispatch) has View List at the top and ONE Generate Invoice
    button at the bottom; an order that has not been dispatched keeps Edit / Remove / View List / Dispatch;
  * Generate Invoice saves a DRAFT invoice for the order's client from the goods that were dispatched, priced with the product's selling price, in the
    product's currency, with no discount or tax and no invoice number; each line is backed by the dispatch line it bills;
  * stock never changes; repeating it (or two simultaneous clicks) makes no second invoice; an issued invoice is returned too; a voided one lets the order be
    invoiced again;
  * the Sales Invoice page opens with the "generated" banner and lists the draft;
  * nothing is made for an order that was not dispatched, for products priced in different currencies, or for another organization's order, and a signed-out
    or Sales-less caller is refused.

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
import threading
import uuid
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, TENANT_PORTAL = 8000, 8001, 3001
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
    sa_email = "geninv-sa@example.org"
    emails = {"a": "geninv-admin-a@example.org", "b": "geninv-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        status, text, _ = call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]} if key else None)
        return status, text

    def page(key, path):
        status, text = portal(key, "GET", path)
        return status, text.replace("<!-- -->", "")

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (Decimal(x) for x in row.split("|"))
        return on_hand, reserved

    def movements(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}'") or "0")

    def invoices_of(key):
        return int(psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids[key]}'") or "0")

    def set_modules(org_key, **flags):
        for module, enabled in flags.items():
            psql("impex_organizations", f"UPDATE organization_modules SET enabled = {str(enabled).lower()} WHERE organization_id = '{org_ids[org_key]}' AND module_key = '{module}'")

    def make_order(key, client_id, lines):
        s, text = portal(key, "POST", "/api/sales/orders", {"clientId": client_id, "lines": [{"productId": p, "quantity": q} for p, q in lines]}, {"Idempotency-Key": f"gi-{uuid.uuid4()}"})
        order = jbody(text).get("order", {})
        return s, order

    def dispatch(key, order_id):
        return portal(key, "POST", f"/api/sales/orders/{order_id}/dispatch")

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='GenInv SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key, name in (("a", "GenInv Check Alpha"), ("b", "GenInv Check Beta")):
            status, text, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"geninv-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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
            set_modules(key, inventory=True, sales=True)

        def register(key, sku, name, price, currency):
            status, text = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "unit": "pcs", "costPrice": "3.20", "sellingPrice": price, "currencyCode": currency})
            product = jbody(text).get("product", {})
            created.add("products", product.get("id"))
            portal(key, "POST", "/api/stock/opening", {"product_id": product.get("id"), "quantity": "200"}, {"Idempotency-Key": f"gi-{uuid.uuid4()}"})
            return product

        widget = register("a", "GI-WIDGET", "GI Widget", "6.00", "USD")
        gadget = register("a", "GI-GADGET", "GI Euro gadget", "9.99", "EUR")
        check("two priced products exist with 200 each in stock", figures(widget["id"])[0] == Decimal("200") and figures(gadget["id"])[0] == Decimal("200"), (figures(widget["id"]), figures(gadget["id"])))
        s, text = portal("a", "POST", "/api/sales/clients", {"name": "GI Client Ltd"})
        client = jbody(text).get("client", {})
        s, order = make_order("a", client["id"], [(widget["id"], "100")])
        check("an order for 100 widgets is saved", s == 201 and order.get("id"), (s, order))

        print("\n== 1. the card before and after the dispatch")
        s, html = page("a", "/delivery-lists")
        card = html[max(0, html.find(order["number"]) - 400): html.find(order["number"]) + 6000] if order.get("number") in html else ""
        wanted = (f"Edit {order['number']}", f"Remove {order['number']}", f"View list {order['number']}", f"Dispatch {order['number']}")
        check("before the dispatch the card keeps Edit, Remove, View List and Dispatch, and has no Generate Invoice",
              all(x in card for x in wanted) and "Generate invoice" not in card, (s, [x for x in wanted if x not in card], len(card)))
        stock_before = (figures(widget["id"]), movements(widget["id"]))
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("an order that was NOT dispatched has nothing to invoice (409) and no invoice is made", s == 409 and "Nothing has been dispatched" in text and invoices_of("a") == 0, (s, text))
        s, text = dispatch("a", order["id"])
        check("Dispatch confirms: the widgets leave stock (200 -> 100)", s == 200 and figures(widget["id"])[0] == Decimal("100"), (s, text))
        stock_after_dispatch = (figures(widget["id"]), movements(widget["id"]))
        s, html = page("a", "/delivery-lists?view=history")
        at = html.find(order["number"])
        card = html[max(0, at - 400): at + 4500]
        check("the dispatched order's card shows its View List button and a single Generate Invoice button; Edit / Remove / Dispatch are gone",
              at > 0 and f"View list {order['number']}" in card and f"Generate invoice for {order['number']}" in card and f"Edit {order['number']}" not in card
              and f"Remove {order['number']}" not in card and f"Dispatch {order['number']}" not in card, (s, at))
        check("View List comes before Generate Invoice (top, then bottom)", card.find(f"View list {order['number']}") < card.find(f"Generate invoice for {order['number']}"))

        print("\n== 2. Generate Invoice")
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        made = jbody(text)
        invoice_id = made.get("invoice", {}).get("id")
        check("the draft invoice is made (201) and the answer is only the id and a few facts",
              s == 201 and made.get("created") is True and made["invoice"].get("status") == "draft" and made["invoice"].get("number") is None and made["invoice"].get("total") == "600.0000"
              and made["invoice"].get("currency_code") == "USD" and set(made["invoice"]) == {"id", "number", "status", "total", "currency_code"}, (s, text))
        if invoice_id:
            created.add("invoices", invoice_id)
        row = psql("impex_sales", f"SELECT status || '|' || coalesce(number, '') || '|' || currency_code || '|' || subtotal || '|' || total || '|' || coalesce(notes, '') FROM invoices WHERE id = '{invoice_id}'")
        check("it is saved in the database as a draft, unnumbered, USD, total 600, with a note naming the order", row == f"draft||USD|600.0000|600.0000|Generated from sales order {order['number']} (delivery list {order['delivery_list']['number']}).", row)
        line = psql("impex_sales", f"SELECT product_sku || '|' || quantity || '|' || unit_price || '|' || discount_amount || '|' || tax_rate || '|' || line_total FROM invoice_lines WHERE invoice_id = '{invoice_id}'")
        check("its one line is the dispatched widgets: 100 x 6.00, no discount, no tax", line == "GI-WIDGET|100.0000|6.0000|0.0000|0.0000|600.0000", line)
        allocation = psql("impex_sales", f"SELECT a.quantity FROM invoice_allocations a JOIN dispatch_lines d ON d.id = a.dispatch_line_id WHERE a.invoice_id = '{invoice_id}'")
        check("the line is backed by the dispatch line it bills (100)", allocation == "100.0000", allocation)
        check("stock did not change", (figures(widget["id"]), movements(widget["id"])) == stock_after_dispatch)

        print("\n== 3. repeating it, and two simultaneous clicks, make no second invoice")
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("the second click returns the same invoice (200, not created again)", s == 200 and jbody(text).get("created") is False and jbody(text)["invoice"]["id"] == invoice_id and invoices_of("a") == 1, (s, text))
        outcomes = []

        def click():
            outcomes.append(portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")[0])

        threads = [threading.Thread(target=click) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        check("six simultaneous clicks still leave exactly one invoice", set(outcomes) == {200} and invoices_of("a") == 1, (outcomes, invoices_of("a")))

        print("\n== 4. the Sales Invoice page")
        s, html = page("a", f"/invoices/sales?generated={invoice_id}")
        check("the Sales Invoice page opens with the 'generated' banner, a link to the invoice and the draft in its list",
              s == 200 and "generated from the dispatched order and saved as a draft" in html and f'href="/invoices/{invoice_id}"' in html and "Draft" in html and 'data-generated="true"' in html, s)
        s, html = page("a", f"/invoices/sales?generated={invoice_id}&existing=1")
        check("an order that already had an invoice says so", s == 200 and "This order already had an invoice" in html, s)
        s, html = page("a", "/invoices/sales?generated=not-a-uuid")
        check("a malformed 'generated' value is ignored", s == 200 and "generated from the dispatched order" not in html, s)
        s, text = portal("a", "GET", f"/api/sales/invoices/{invoice_id}")
        check("the draft can be opened and carries the client", s == 200 and jbody(text).get("invoice", {}).get("client", {}).get("name") == "GI Client Ltd", (s, text[:200]))

        print("\n== 5. issued, then voided")
        s, text = portal("a", "POST", f"/api/sales/invoices/{invoice_id}/issue")
        number = jbody(text).get("invoice", {}).get("number")
        check("the draft can be issued (it gets a number)", s == 200 and number, (s, text))
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("with an issued invoice in place, Generate Invoice returns that invoice (200) and makes nothing", s == 200 and jbody(text).get("created") is False and jbody(text)["invoice"]["number"] == number and invoices_of("a") == 1, (s, text))
        s, text = portal("a", "POST", f"/api/sales/invoices/{invoice_id}/void", {"reason": "generated by mistake"})
        check("the issued invoice (no payments) can be voided", s == 200, (s, text))
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        again = jbody(text)
        created.add("invoices", again.get("invoice", {}).get("id"))
        check("a voided invoice lets the order be invoiced again: a NEW draft (201)", s == 201 and again.get("created") is True and again["invoice"]["id"] != invoice_id and invoices_of("a") == 2, (s, text))
        check("through all of that, stock never changed", (figures(widget["id"]), movements(widget["id"])) == stock_after_dispatch)

        print("\n== 6. nothing is made when it should not be")
        s, mixed = make_order("a", client["id"], [(widget["id"], "5"), (gadget["id"], "5")])
        dispatch("a", mixed.get("id"))
        before = invoices_of("a")
        s, text = portal("a", "POST", f"/api/sales/orders/{mixed['id']}/invoice")
        check("products priced in different currencies are refused with the reason (400) and nothing is converted or made", s == 400 and "different currencies" in text and "EUR" in text and "USD" in text and invoices_of("a") == before, (s, text))
        s, text = portal("b", "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("another organization's order answers 404 and makes nothing there", s == 404 and invoices_of("b") == 0, (s, text))
        s, text = portal(None, "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("signed out: refused (401)", s == 401, (s, text))
        s, text = portal("a", "POST", "/api/sales/orders/not-a-uuid/invoice")
        check("a malformed order id answers 404 without asking the Sales Service", s == 404, (s, text))
        set_modules("a", sales=False)
        s, text = portal("a", "POST", f"/api/sales/orders/{order['id']}/invoice")
        check("with the Sales module off the request is refused (403) and nothing is made", s == 403 and invoices_of("a") == before, (s, text[:200]))
        set_modules("a", sales=True)
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
            "reservations": delete_exact(psql, "impex_inventory", "stock_reservations", orgs, "organization_id"),
            "movements": delete_exact(psql, "impex_inventory", "stock_movements", orgs, "organization_id", ledger=True),
            "balances": delete_exact(psql, "impex_inventory", "stock_balances", orgs, "organization_id"),
            "operations": delete_exact(psql, "impex_inventory", "stock_operations", orgs, "organization_id"),
            "products": delete_exact(psql, "impex_inventory", "products", orgs, "organization_id"),
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", created.get("users")),
        }
        print(f"deleted rows belonging to {len(orgs)} organizations and {len(created.get('users'))} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
