#!/usr/bin/env python3
"""End-to-end check of Capital, Investment and Profit & Loss (Step 24) against the RUNNING stack.

    docker compose up -d       # stack must be running (impex_finance at 0002; Sales, Purchasing and Inventory at head)
    python -u scripts/verify_capital_pnl.py

It works through the portal's own routes exactly as the browser does, and proves - from the Finance Service's numbers AND the databases themselves - the story of
the specification: the owner puts in 5,000,000; 50 laptops are bought at 100,000 each (an investment ACTIVITY, not a second contribution: capital stays 5,000,000);
20 are delivered at 120,000 (gross profit 400,000, recognised ONCE when the goods leave, from the ACTUAL cost - not the product's cost-price field); an invoice and
its payment recognise nothing again; a loss-making sale lowers capital; partial deliveries are recognised in proportion; an invoice discount is an auditable
adjustment (reversed when the invoice is voided); an expense reduces the net result; a delivery with no reliable cost shows no profit and asks for reconciliation;
the periods, the percentages, currencies (never added), the opening position, tenant isolation, idempotency and the database's own refusal to rewrite a fact.
It also proves the old accounting pages and records are still there.

It creates two throwaway organizations ("PnL Check Alpha / Beta") and deletes exactly what it created, by id, afterwards.
"""
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from decimal import Decimal as D
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, INVENTORY, FINANCE, TENANT_PORTAL = 8000, 8001, 8002, 8006, 3001
results = []
M = 1_000_000


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
    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "pnlcheck-sa@example.org"
    emails = {"a": "pnlcheck-admin-a@example.org", "b": "pnlcheck-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(who, method, path, body=None, headers=None):
        s, text, _, loc = call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]})
        return s, text, loc

    def api(who, method, path, body=None, headers=None):
        s, text, _ = portal(who, method, path, body, headers)[:3]
        return s, jbody(text)

    def key():
        return {"Idempotency-Key": f"pc-{uuid.uuid4()}"}

    def fin(who, method, path, body=None, headers=None):
        """The Finance Service itself, with the administrator's own token (the portal bypassed)."""
        s, text, _, _ = call(FINANCE, method, f"/api/v1/finance{path}", body, {**bearer(tokens[who]), **(headers or {})})
        return s, jbody(text)

    def sync(who="a"):
        return api(who, "POST", "/api/finance/sync/run")

    def summary(who="a", period="1m"):
        s, body = api(who, "GET", f"/api/finance/summary?period={period}")
        return body

    def pkr(who="a", period="1m", currency="PKR"):
        return summary(who, period).get("by_currency", {}).get(currency, {})

    def history(who="a", **params):
        query = "&".join(f"{k}={v}" for k, v in {"period": "1m", "limit": 200, **params}.items())
        return api(who, "GET", f"/api/finance/history?{query}")[1]

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (D(x) for x in row.split("|"))
        return on_hand, reserved

    def fcount(sql_where, table):
        return int(psql("impex_finance", f"SELECT count(*) FROM {table} WHERE organization_id = '{org_ids['a']}' {sql_where}") or "0")

    def invest(who, amount, kind="contribution", currency="PKR", entry_type="cash", day=None, **extra):
        body = {"kind": kind, "entryType": entry_type, "amount": str(amount), "currencyCode": currency, "effectiveDate": day or time.strftime("%Y-%m-%d"), **extra}
        return api(who, "POST", "/api/finance/investments", body, key())

    def register(who, sku, name, cost="90000"):
        s, body = api(who, "POST", "/api/products", {"sku": sku, "name": name, "unit": "pcs", "costPrice": cost, "currencyCode": "PKR"})
        product = body.get("product", {})
        created.add("products", product.get("id"))
        return product

    def order_for(who, client_id, lines, currency="PKR"):
        s, body = api(who, "POST", "/api/sales/orders", {"clientId": client_id, "currencyCode": currency, "lines": [{"productId": p, "quantity": q, "unitPrice": price} for p, q, price in lines]}, key())
        return body.get("order", {})

    def dispatch(who, order, lines):
        """Confirm ONE dispatch of (product id, quantity) lines of the order's delivery list."""
        list_id = (order.get("delivery_list") or {}).get("id")
        dl = api(who, "GET", f"/api/sales/delivery-lists/{list_id}")[1].get("list", {})
        body_lines = [{"deliveryListItemId": next(i for i in dl["items"] if i["product_id"] == p)["id"], "quantity": q} for p, q in lines]
        s, made = api(who, "POST", "/api/sales/dispatches", {"deliveryListId": list_id, "lines": body_lines}, key())
        d = made.get("dispatch", {})
        s, _ = api(who, "POST", f"/api/sales/dispatches/{d['id']}/confirm")
        return api(who, "GET", f"/api/sales/dispatches/{d['id']}")[1].get("dispatch", {}) if s == 200 else {}

    try:
        print("== setup: two organizations (A in PKR, Asia/Karachi), one administrator each, Finance enabled for both")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='PNLcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        s, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", s == 200 and sa_token, (s, text))
        for who, name in (("a", "PnL Check Alpha"), ("b", "PnL Check Beta")):
            s, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"pnlcheck-{who}-{secrets.token_hex(3)}", "country_code": "PK", "contact_email": f"ops-{who}@example.org"}, bearer(sa_token))
            org_ids[who] = jbody(text).get("id")
            created.add("organizations", org_ids[who])
            s, text, _, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[who], "full_name": f"Admin {who.upper()}", "email": emails[who], "password": password}, {"X-Internal-Key": internal_key})
            created.add("users", jbody(text).get("id"))
            s, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[who], "password": password})
            tokens[who] = jbody(text).get("access_token")
            s, text, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[who], "password": password})
            cookies[who] = cookie_value(sc, "impex_tenant_session")
            mark_setup_complete(psql, org_ids[who])
            psql("impex_organizations", f"UPDATE organizations SET default_currency = 'PKR', timezone = 'Asia/Karachi' WHERE id = '{org_ids[who]}'")
            psql("impex_organizations", f"INSERT INTO organization_modules (organization_id, module_key, enabled, updated_at) VALUES ('{org_ids[who]}', 'finance', true, now()) ON CONFLICT (organization_id, module_key) DO UPDATE SET enabled = true, updated_at = now()")
            check(f"organization {who.upper()}, its administrator and Finance exist", org_ids[who] and tokens[who] and cookies[who])
        time.sleep(1.2)
        first = summary()
        check("the first Finance request sets the organization up; nothing is invented: capital needs a setup", first.get("setup_required") is True and first.get("currencies") == []
              and "no starting balance is assumed" in (first.get("setup_message") or ""), first)
        check("the summary carries the organization's time zone and a rolling 1-month period", first.get("period", {}).get("timezone") == "Asia/Karachi" and first["period"]["key"] == "1m", first.get("period"))

        print("\n== 1. Investment: the owner puts in 5,000,000")
        s, body = invest("a", 5 * M, description="Seed money from the owner", reference="BANK-1")
        record = body.get("record", {})
        check("an owner contribution is recorded (201)", s == 201 and record.get("effect") == "5000000.0000" and record.get("kind") == "contribution", (s, body))
        k = key()
        s1, b1 = api("a", "POST", "/api/finance/investments", {"kind": "contribution", "amount": "1000", "currencyCode": "PKR", "effectiveDate": time.strftime("%Y-%m-%d")}, k)
        s2, b2 = api("a", "POST", "/api/finance/investments", {"kind": "contribution", "amount": "1000", "currencyCode": "PKR", "effectiveDate": time.strftime("%Y-%m-%d")}, k)
        check("a duplicate submission (same Idempotency-Key) records ONE (201 then 200, the same record)", s1 == 201 and s2 == 200 and b1["record"]["id"] == b2["record"]["id"] and b2.get("replayed") is True, (s1, s2))
        api("a", "POST", f"/api/finance/investments/{b1['record']['id']}/reverse", {"reason": "Entered to test duplicates"})
        p = pkr()
        check("capital = 5,000,000 and investment = 5,000,000 (the 1,000 test record and its reversal cancel out)", p["capital"]["closing"] == "5000000.0000" and p["investment"]["closing"] == "5000000.0000", p)
        check("the change against a zero baseline is 'New' with its absolute amount - never infinity", p["capital"]["change"]["state"] == "new" and p["capital"]["change"]["percent"] is None and p["capital"]["change"]["absolute"] == "5000000.0000", p["capital"]["change"])
        check("capital can now be established (from the owner's records)", summary()["setup_required"] is False and p["capital"]["basis"] == "owner_records")

        print("\n== 2. Purchasing: 50 laptops at 100,000 - an investment ACTIVITY, not a second contribution")
        laptop = register("a", "PC-LAPTOP", "Dell Latitude Laptop", cost="90000")  # the product's own cost-price field is a DECOY: 90,000, not the 100,000 actually paid
        s, body = api("a", "POST", "/api/purchasing/suppliers", {"name": "PnL Supplies Ltd"})
        supplier = body.get("supplier", {})
        s, body = api("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier["id"], "currencyCode": "PKR"}, key())
        po = body.get("order", {})
        s, body = api("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/lines", {"productId": laptop["id"], "quantity": "50", "unitPrice": "100000"})
        api("a", "POST", f"/api/purchasing/purchase-orders/{po['id']}/order")
        sync()
        before = pkr()
        check("an ORDER alone changes nothing (capital 5,000,000, no purchase activity yet)", before["capital"]["closing"] == "5000000.0000" and before["investment"]["inventory_purchases"] == "0.0000", before)
        placed = api("a", "GET", f"/api/purchasing/purchase-orders/{po['id']}")[1].get("order", {})
        s, body = api("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po["id"], "lines": [{"purchaseOrderLineId": placed["lines"][0]["id"], "acceptedQuantity": "50", "rejectedQuantity": "0"}]}, key())
        receipt = body.get("receipt", {})
        check("a DRAFT goods receipt changes nothing", sync()[0] == 200 and pkr()["investment"]["inventory_purchases"] == "0.0000")
        s, _ = api("a", "POST", f"/api/purchasing/goods-receipts/{receipt['id']}/confirm")
        check("confirming the receipt puts 50 laptops in stock", s == 200 and figures(laptop["id"]) == (D("50"), D("0")), (s, figures(laptop["id"])))
        sync()
        sync()
        sync()
        p = pkr()
        check("inventory purchase activity = 5,000,000 (confirmed quantity x actual cost) - and capital is STILL 5,000,000, not 10,000,000",
              p["investment"]["inventory_purchases"] == "5000000.0000" and p["capital"]["closing"] == "5000000.0000" and p["investment"]["closing"] == "5000000.0000", p["investment"])
        check("the receipt was recorded exactly once (three synchronisations, one cost entry, one journal entry)",
              fcount("AND kind = 'receipt'", "cost_entries") == 1 and fcount("AND source_type = 'purchasing'", "journal_entries") == 1)
        rows = history(category="investments").get("items", [])
        purchase = next((r for r in rows if r["kind"] == "inventory_purchase"), {})
        check("the history lists the purchase: type, amount, supplier, receipt number and purchase order - and says it is not new capital",
              purchase.get("amount") == "5000000.0000" and purchase.get("counterparty") == "PnL Supplies Ltd" and purchase.get("reference") == receipt.get("number") and po.get("number", "?") in (purchase.get("notes") or "")
              and purchase.get("affects_capital") is False and purchase.get("source_type") == "goods_receipt", purchase)
        check("the supplier-credit liability is in the books as before: Dr Inventory / Cr Goods Received Not Invoiced 5,000,000", psql("impex_finance", f"SELECT string_agg(a.code || ':' || l.debit || ':' || l.credit, ',' ORDER BY a.code) FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id WHERE e.organization_id = '{org_ids['a']}' AND e.source_type = 'purchasing'") == "1200:5000000.0000:0.0000,2200:0.0000:5000000.0000")
        check("the owner's contribution is NOT counted twice and the purchase is NOT a contribution", len([r for r in rows if r["kind"] == "owner_contribution" and r["amount"] == "5000000.0000"]) == 1)

        print("\n== 3. Sales: 20 laptops at 120,000 delivered -> gross profit 400,000, recognised ONCE")
        s, body = api("a", "POST", "/api/sales/clients", {"name": "Company A"})
        company_a = body.get("client", {})
        order1 = order_for("a", company_a["id"], [(laptop["id"], "20", "120000")])
        sync()
        mid = pkr()
        check("a saved order (stock reserved) is NOT a sale: no profit, capital unchanged", figures(laptop["id"]) == (D("50"), D("20")) and mid["profit_loss"]["net"] == "0.0000" and mid["capital"]["closing"] == "5000000.0000", mid["profit_loss"])
        d1 = dispatch("a", order1, [(laptop["id"], "20")])
        check("the dispatch is confirmed (stock leaves)", d1.get("status") == "confirmed" and figures(laptop["id"]) == (D("30"), D("0")), d1.get("status"))
        sync()
        p = pkr()
        pl = p["profit_loss"]
        check("revenue 2,400,000 (20 x the price agreed on the order), cost of goods sold 2,000,000 (20 x the ACTUAL 100,000, not the 90,000 field), gross profit 400,000",
              pl["revenue"] == "2400000.0000" and pl["cost_of_goods_sold"] == "2000000.0000" and pl["gross_profit"] == "400000.0000" and pl["net"] == "400000.0000", pl)
        check("capital rises by exactly the profit, once: 5,400,000; investment stays 5,000,000", p["capital"]["closing"] == "5400000.0000" and p["investment"]["closing"] == "5000000.0000", (p["capital"], p["investment"]))
        sync()
        sync()
        check("reading it again recognises nothing again (one delivery row, one cost movement)", fcount("", "trade_deliveries") == 1 and fcount("AND kind = 'delivery'", "cost_entries") == 1)
        sales = history(category="profitable_sales").get("items", [])
        check("the history lists the sale: client, quantity, order, revenue and profit, linked to its dispatch",
              len(sales) == 1 and sales[0]["counterparty"] == "Company A" and sales[0]["amount"] == "2400000.0000" and sales[0]["profit_loss"] == "400000.0000" and sales[0]["status"] == "recognized"
              and order1.get("number") in sales[0]["description"] and sales[0]["source_type"] == "dispatch", sales)

        print("\n== 4. Invoice and payment recognise nothing again")
        s, body = api("a", "POST", f"/api/sales/orders/{order1['id']}/invoice")
        draft = body.get("invoice", {})
        s, body = api("a", "POST", f"/api/sales/invoices/{draft['id']}/issue")
        issued = body.get("invoice", {})
        sync()
        check("delivery-priced invoice: issued (2,400,000) - capital and profit are unchanged, no adjustment", issued.get("status") == "issued" and issued.get("total") == "2400000.0000" and pkr()["capital"]["closing"] == "5400000.0000"
              and pkr()["profit_loss"]["net"] == "400000.0000" and fcount("", "trade_adjustments") == 0, (issued.get("status"), pkr()["profit_loss"]))
        s, body = api("a", "POST", f"/api/sales/invoices/{issued['id']}/payments", {"amount": "1000000", "method": "bank_transfer"}, key())
        sync()
        check("a customer payment is not profit: capital and the net result are unchanged", s in (200, 201) and pkr()["capital"]["closing"] == "5400000.0000" and pkr()["profit_loss"]["net"] == "400000.0000", (s, pkr()["capital"]))
        check("the invoice and the payment are still posted to the books as before (receivable, revenue, cash received)", fcount("AND source_type = 'sales'", "journal_entries") == 2)

        print("\n== 5. A loss-making sale and partial deliveries")
        company_b_s, body = api("a", "POST", "/api/sales/clients", {"name": "Company B"})
        company_b = body.get("client", {})
        order2 = order_for("a", company_b["id"], [(laptop["id"], "10", "90000")])
        dispatch("a", order2, [(laptop["id"], "10")])
        sync()
        p = pkr()
        check("a sale at 90,000 of stock that cost 100,000 is a LOSS of 100,000 from the historical cost; capital falls to 5,300,000",
              p["profit_loss"]["gross_profit"] == "300000.0000" and p["capital"]["closing"] == "5300000.0000", p["profit_loss"])
        losses = history(category="loss_sales").get("items", [])
        check("the loss-making sale is in its own category with a negative profit", len(losses) == 1 and losses[0]["profit_loss"] == "-100000.0000" and losses[0]["counterparty"] == "Company B", losses)
        laptop2 = register("a", "PC-MONITOR", "HP Monitor", cost="1")
        po2 = api("a", "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier["id"], "currencyCode": "PKR"}, key())[1].get("order", {})
        api("a", "POST", f"/api/purchasing/purchase-orders/{po2['id']}/lines", {"productId": laptop2["id"], "quantity": "20", "unitPrice": "30000"})
        api("a", "POST", f"/api/purchasing/purchase-orders/{po2['id']}/order")
        placed2 = api("a", "GET", f"/api/purchasing/purchase-orders/{po2['id']}")[1].get("order", {})
        r2 = api("a", "POST", "/api/purchasing/goods-receipts", {"purchaseOrderId": po2["id"], "lines": [{"purchaseOrderLineId": placed2["lines"][0]["id"], "acceptedQuantity": "20", "rejectedQuantity": "0"}]}, key())[1].get("receipt", {})
        api("a", "POST", f"/api/purchasing/goods-receipts/{r2['id']}/confirm")
        order3 = order_for("a", company_a["id"], [(laptop2["id"], "10", "40000")])
        first_part = dispatch("a", order3, [(laptop2["id"], "4")])
        sync()
        p = pkr()
        check("a partial delivery of 4 of 10 recognises only 4: revenue 160,000, profit 40,000", p["profit_loss"]["gross_profit"] == "340000.0000" and p["capital"]["closing"] == "5340000.0000", p["profit_loss"])
        second_part = dispatch("a", order3, [(laptop2["id"], "6")])
        sync()
        p = pkr()
        check("the second part (6) completes it: profit 60,000 more, 100,000 in all; capital 5,400,000", p["profit_loss"]["gross_profit"] == "400000.0000" and p["capital"]["closing"] == "5400000.0000", p["profit_loss"])

        print("\n== 6. An invoice that bills LESS than delivery recognised is an auditable adjustment")
        line = next(l for l in first_part["lines"] if l["product_id"] == laptop2["id"])
        s, body = api("a", "POST", "/api/sales/invoices", {"clientId": company_a["id"], "currencyCode": "PKR", "lines": [{"dispatchLineId": line["id"], "quantity": "4", "unitPrice": "40000", "discountAmount": "10000"}]}, key())
        disc = body.get("invoice", {})
        s, body = api("a", "POST", f"/api/sales/invoices/{disc['id']}/issue")
        disc = body.get("invoice", disc)
        sync()
        p = pkr()
        check("billed 150,000 (160,000 - 10,000 discount) against 160,000 recognised: an adjustment of -10,000, capital 5,390,000", p["profit_loss"]["adjustments"] == "-10000.0000" and p["capital"]["closing"] == "5390000.0000"
              and p["profit_loss"]["gross_profit"] == "400000.0000", p["profit_loss"])
        adj = [r for r in history(category="expenses_adjustments").get("items", []) if r["kind"] == "invoice_adjustment"]
        check("the adjustment is in the history, linked to the invoice", len(adj) == 1 and adj[0]["profit_loss"] == "-10000.0000" and adj[0]["reference"] == disc.get("number") and adj[0]["source_type"] == "invoice", adj)
        s, _ = api("a", "POST", f"/api/sales/invoices/{disc['id']}/void", {"reason": "client cancelled"})
        sync()
        p = pkr()
        check("voiding the invoice reverses the adjustment (both rows kept): capital 5,400,000 again", s == 200 and p["profit_loss"]["adjustments"] == "0.0000" and p["capital"]["closing"] == "5400000.0000" and fcount("", "trade_adjustments") == 2, (s, p["profit_loss"]))

        print("\n== 7. Expenses reduce the net result")
        s, body = api("a", "GET", "/api/finance/accounts?type=expense&active=true")
        category = body.get("accounts", [{}])[0]
        s, body = api("a", "POST", "/api/finance/expenses", {"expenseDate": time.strftime("%Y-%m-%d"), "description": "Warehouse rent", "vendor": "Landlord", "accountId": category["id"], "amount": "50000", "currencyCode": "PKR", "post": True}, key())
        expense = body.get("expense", {})
        p = pkr()
        check("an expense of 50,000 is counted: net result 350,000 (gross 400,000 - 50,000), capital 5,350,000", s == 201 and p["profit_loss"]["expenses"] == "50000.0000" and p["profit_loss"]["net"] == "350000.0000" and p["capital"]["closing"] == "5350000.0000", (s, p["profit_loss"]))
        check("the history shows the expense under 'Expenses & adjustments', linked to it", any(r["kind"] == "expense" and r["profit_loss"] == "-50000.0000" and r["source_id"] == expense.get("id") for r in history(category="expenses_adjustments").get("items", [])))
        check("the earlier expense page and its records are still there", api("a", "GET", f"/api/finance/expenses/{expense['id']}")[0] == 200 and portal("a", "GET", f"/finance/expenses/{expense['id']}")[0] == 200)

        print("\n== 8. A delivery with no reliable cost shows no profit and asks for reconciliation")
        orphan = register("a", "PC-ORPHAN", "Cisco Router (stock from before Finance)", cost="1")
        api("a", "POST", "/api/stock/opening", {"product_id": orphan["id"], "quantity": "10"}, key())
        order4 = order_for("a", company_a["id"], [(orphan["id"], "4", "50000")])
        dispatch("a", order4, [(orphan["id"], "4")])
        sync()
        p = pkr()
        check("no cost is known: the sale is NOT counted (no fabricated 200,000 profit, no cost of zero); capital and the net result are unchanged",
              p["profit_loss"]["net"] == "350000.0000" and p["capital"]["closing"] == "5350000.0000" and p["profit_loss"]["needs_cost_count"] == 1, p["profit_loss"])
        check("it is announced for reconciliation", summary()["reconciliation"] == {"needs_cost": 1, "needs_price": 0, "total": 1}, summary()["reconciliation"])
        pending = history(category="reconciliation").get("items", [])
        check("the history row says 'needs cost reconciliation' with no profit", len(pending) == 1 and pending[0]["status"] == "needs_cost" and pending[0]["profit_loss"] is None and "needs cost reconciliation" in pending[0]["transaction"], pending)
        s, body = api("a", "POST", "/api/finance/inventory-costs", {"productId": orphan["id"], "quantity": "10", "unitCost": "30000", "currencyCode": "PKR", "effectiveDate": time.strftime("%Y-%m-%d")}, key())
        check("recording the cost of stock already held (opening inventory valuation) is accepted", s == 201 and body.get("entry", {}).get("value") == "300000.0000", (s, body))
        p = pkr()
        check("the waiting delivery is now costed from it: profit 4 x (50,000 - 30,000) = 80,000; capital 5,430,000; nothing waits", p["profit_loss"]["gross_profit"] == "480000.0000" and p["capital"]["closing"] == "5430000.0000" and summary()["reconciliation"]["total"] == 0, p["profit_loss"])
        check("the stock-cost record changed no capital by itself (the contribution is the only capital in; the valuation is a cost basis)", p["investment"]["closing"] == "5000000.0000")

        print("\n== 9. Periods and percentages")
        for period in ("1w", "1m", "1y"):
            block = pkr(period=period)
            check(f"{period}: Capital, Investment and Profit & Loss are all there", block.get("capital", {}).get("closing") == "5430000.0000" and block.get("investment", {}).get("closing") == "5000000.0000" and "net" in block.get("profit_loss", {}), block.get("capital"))
        check("the response says which period it is (1 Week / 1 Month / 1 Year) and a bad one is refused", summary(period="1w")["period"]["label"] == "1 Week" and summary(period="1y")["period"]["label"] == "1 Year" and api("a", "GET", "/api/finance/summary?period=2d")[0] == 400)
        check("the trend has 8, 31 and 13 points ending at the closing capital", [len(pkr(period=p)["trend"]) for p in ("1w", "1m", "1y")] == [8, 31, 13] and pkr()["trend"][-1]["capital"] == "5430000.0000")
        y = pkr(period="1y")["investment"]
        check("everything was recorded today, so against a zero baseline every period reports 'New' with the absolute change (never a percentage of zero)",
              all(pkr(period=p)["investment"]["change"]["state"] == "new" and pkr(period=p)["investment"]["opening"] == "0.0000" for p in ("1w", "1m", "1y")) and y["change"]["percent"] is None, y["change"])

        print("\n== 9b. The Profit & Loss Trend chart reconciles with the summary")
        for period, unit, count in (("1d", "hour", 24), ("1w", "day", 7), ("1m", "week", None), ("6m", "month", 6), ("1y", "month", 12)):
            s_, body = api("a", "GET", f"/api/finance/pnl-trend?period={period}")
            chart = body.get("by_currency", {}).get("PKR", {})
            ok = s_ == 200 and body.get("granularity") == unit and (count is None or len(chart.get("buckets", [])) == count)
            ok = ok and chart["totals"]["net"] == pkr(period=period)["profit_loss"]["net"] and sum(D(b["net"]) for b in chart["buckets"]) == D(chart["totals"]["net"])
            check(f"{period}: {unit} buckets add up to the Profit & Loss card exactly ({chart.get('totals', {}).get('net')})", ok, (s_, body.get("granularity")))
        week = api("a", "GET", "/api/finance/pnl-trend?period=1w")[1]["by_currency"]["PKR"]
        active = [b for b in week["buckets"] if b["has_activity"]]
        check("per bar: revenue - cost of goods sold - expenses and adjustments = net, from the service's own figures", len(active) >= 1 and all(D(b["revenue"]) - D(b["cost_of_goods_sold"]) - D(b["other_costs"]) == D(b["net"]) for b in week["buckets"]), active[:1])
        check("nothing waits for reconciliation any more, so the chart is complete", api("a", "GET", "/api/finance/pnl-trend?period=1w")[1]["incomplete"] == {"needs_price": 0, "needs_cost": 0})
        check("B has no chart data (tenant isolation) and a bad period is refused", api("b", "GET", "/api/finance/pnl-trend?period=1w")[1]["by_currency"] == {} and api("a", "GET", "/api/finance/pnl-trend?period=2d")[0] == 400)
        check("the Finance page carries the Profit & Loss Trend chart", "Profit &amp; Loss Trend" in portal("a", "GET", "/finance")[1].replace("<!-- -->", ""))

        print("\n== 10. Currencies are never added together")
        invest("a", 20_000, currency="USD")
        body = summary()
        check("PKR and USD are reported separately and a combined figure is declared unavailable", sorted(body["currencies"]) == ["PKR", "USD"] and body["combined_available"] is False and "no exchange rates" in (body["combined_note"] or "")
              and body["by_currency"]["USD"]["capital"]["closing"] == "20000.0000", body.get("combined_note"))
        check("PKR capital is unaffected by the USD contribution", body["by_currency"]["PKR"]["capital"]["closing"] == "5430000.0000", body["by_currency"]["PKR"]["capital"])

        print("\n== 11. The opening position (organization B, which has no history)")
        s, body = api("b", "POST", "/api/finance/opening-positions", {"currencyCode": "PKR", "effectiveDate": time.strftime("%Y-%m-%d"), "assets": "8000000", "liabilities": "3000000", "notes": "Balance sheet at the start"}, key())
        check("an opening position (assets 8,000,000, liabilities 3,000,000) is recorded", s == 201 and body.get("position", {}).get("equity") == "5000000.0000", (s, body))
        pb = pkr("b")
        check("capital = the opening equity 5,000,000, from the opening position; a second position in the same currency is refused", pb["capital"]["closing"] == "5000000.0000" and pb["capital"]["basis"] == "opening_position"
              and api("b", "POST", "/api/finance/opening-positions", {"currencyCode": "PKR", "effectiveDate": time.strftime("%Y-%m-%d"), "assets": "1", "liabilities": "0"}, key())[0] == 409, pb["capital"])
        position_id = body["position"]["id"]
        s, body = api("b", "POST", f"/api/finance/opening-positions/{position_id}/reverse", {"reason": "Verification: reversing it"})
        check("reversing it keeps the record (with who and why) and capital needs a setup again - nothing is invented", s == 200 and body["position"]["status"] == "reversed" and summary("b")["setup_required"] is True
              and psql("impex_finance", f"SELECT count(*) FROM opening_positions WHERE id = '{position_id}'") == "1")

        print("\n== 12. Tenant isolation")
        check("B sees nothing of A's capital, history, costs or deliveries", summary("b")["currencies"] == [] and history("b").get("total") == 0 and api("b", "GET", "/api/finance/inventory-costs")[1].get("items") == []
              and api("b", "GET", "/api/finance/reconciliation")[1].get("items") == [])
        check("B cannot reverse A's records or reconcile A's deliveries (404, like a missing one)", api("b", "POST", f"/api/finance/investments/{record['id']}/reverse", {"reason": "not mine"})[0] == 404
              and api("b", "POST", f"/api/finance/deliveries/{sales[0]['delivery_id']}/reconcile", {"unitCost": "1", "reason": "not mine"})[0] == 404)
        check("the Finance Service itself agrees (called with B's own token)", fin("b", "GET", "/summary?period=1m")[1].get("currencies") == [] and fin("b", "POST", f"/deliveries/{sales[0]['delivery_id']}/reconcile", {"unit_cost": "1", "reason": "not mine"})[0] == 404)
        check("a client-supplied organization id is refused by the service (422)", fin("a", "POST", "/investments", {"kind": "contribution", "amount": "1", "effective_date": time.strftime("%Y-%m-%d"), "organization_id": org_ids["b"]}, key())[0] == 422)

        print("\n== 12b. Percentages over real periods (organization B: 1,000,000 put in 40 days ago, 250,000 taken out today)")
        old_day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 40 * 86400))
        invest("b", 1 * M, day=old_day, description="Earlier contribution (40 days ago)")
        invest("b", 250_000, kind="withdrawal")
        for period in ("1w", "1m"):
            inv = pkr("b", period=period)["investment"]
            check(f"{period}: investment 1,000,000 -> 750,000 is -25.0% (negative, arrow down, -250,000.00)", inv["opening"] == "1000000.0000" and inv["closing"] == "750000.0000" and inv["change"] == {"absolute": "-250000.0000", "percent": "-25.0", "state": "value", "direction": "down"}, inv["change"])
        inv = pkr("b", period="1y")["investment"]
        check("1y: a year ago nothing had been invested, so it is 'New' (the 1,000,000 contribution is inside the year)", inv["opening"] == "0.0000" and inv["change"]["state"] == "new" and inv["change"]["percent"] is None, inv["change"])
        flat = pkr("b", period="1w")["capital"]["change"]
        check("capital in B is the same investment (no trading): -25.0% too", flat["percent"] == "-25.0" and flat["direction"] == "down", flat)

        print("\n== 13. The database itself refuses to rewrite or erase a recorded fact")
        for sql, what in ((f"UPDATE capital_records SET description = 'tampered' WHERE organization_id = '{org_ids['a']}'", "an owner record"), (f"DELETE FROM capital_records WHERE organization_id = '{org_ids['a']}'", "deleting owner records"),
                          (f"UPDATE trade_deliveries SET cogs = 1 WHERE organization_id = '{org_ids['a']}'", "a recognised cost"), (f"DELETE FROM trade_deliveries WHERE organization_id = '{org_ids['a']}'", "deleting deliveries"),
                          (f"UPDATE cost_entries SET value = 1 WHERE organization_id = '{org_ids['a']}'", "a cost movement"), (f"DELETE FROM trade_adjustments WHERE organization_id = '{org_ids['a']}'", "deleting adjustments")):
            out = psql_with_errors("impex_finance", sql)
            check(f"the database refuses {what}", "ERROR" in out and ("can never" in out or "cannot be" in out or "is final" in out), out[:140])

        print("\n== 14. The old accounting records and pages are all still there")
        s, accounts = fin("a", "GET", "/accounts")
        check("the chart of accounts is intact (system accounts and the starter categories)", s == 200 and len(accounts) >= 14, len(accounts))
        check("the journal still holds the receipt and invoice entries; expenses are listed", fcount("", "journal_entries") >= 4 and fin("a", "GET", "/journal-entries?limit=50")[1].get("total", 0) >= 4 and fin("a", "GET", "/expenses")[1].get("total") == 1)
        for path, marker in (("/finance", "Finance Overview"), ("/finance/accounting", "Financial Overview"), ("/finance/accounts", "Accounts"), ("/finance/expenses", "Expenses"), ("/finance/journal", "Journal")):
            s, html, loc = portal("a", "GET", path)
            check(f"{path} still opens", s == 200 and marker in html.replace("<!-- -->", ""), (s, loc))
        html = portal("a", "GET", "/")[1]
        check("the sidebar has ONE Finance entry: none of Financial Overview, Accounts, Expenses, Journal Entries", 'href="/finance"' in html and all(f'href="{p}"' not in html for p in ("/finance/accounts", "/finance/expenses", "/finance/journal")) and "Financial Overview" not in html)
        page = portal("a", "GET", "/finance")[1].replace("<!-- -->", "")
        check("the Finance page has the title, the subtitle and the three cards, with the 1 Week | 1 Month | 1 Year selector", all(x in page for x in ("Finance Overview", "Track your business capital, investments, and trading performance.", "Capital", "Investment", "Profit &amp; Loss", "1 Week", "1 Month", "1 Year", "Transaction history")))

        print("\n== 15. Other workflows are untouched")
        check("stock is exactly what the workflow left (laptops 20, monitors 10, routers 6)", figures(laptop["id"])[0] == D("20") and figures(laptop2["id"])[0] == D("10") and figures(orphan["id"])[0] == D("6"), (figures(laptop["id"]), figures(laptop2["id"]), figures(orphan["id"])))
        check("the products' own (editable) cost-price fields were never used or changed", psql("impex_inventory", f"SELECT cost_price::text FROM products WHERE id = '{laptop['id']}'") == "90000.0000")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {}
        finance_tables = (("trade_adjustments", "organization_id"), ("trade_deliveries", "organization_id"), ("cost_entries", "organization_id"), ("inventory_costs", "organization_id"), ("capital_records", "organization_id"),
                          ("opening_positions", "organization_id"), ("expenses", "organization_id"), ("journal_lines", "organization_id"), ("journal_entries", "organization_id"), ("accounts", "organization_id"),
                          ("finance_events", "organization_id"), ("finance_requests", "organization_id"), ("finance_counters", "organization_id"), ("sync_events", "organization_id"), ("sync_sources", "organization_id"),
                          ("finance_organizations", "organization_id"))
        if orgs:
            # the Finance worker is live: the organizations go FIRST (it then stops listing them), the Finance rows afterwards - twice, a worker cycle apart
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
                "purchase orders": delete_exact(psql, "impex_purchasing", "purchase_orders", orgs, "organization_id", ledger=True),
                "po counters": delete_exact(psql, "impex_purchasing", "purchase_order_counters", orgs, "organization_id"),
                "suppliers": delete_exact(psql, "impex_purchasing", "suppliers", orgs, "organization_id"),
                "payments": delete_exact(psql, "impex_sales", "invoice_payments", orgs, "organization_id", ledger=True),
                "allocations": delete_exact(psql, "impex_sales", "invoice_allocations", orgs, "organization_id", ledger=True),
                "invoice lines": delete_exact(psql, "impex_sales", "invoice_lines", orgs, "organization_id", ledger=True),
                "invoice requests": delete_exact(psql, "impex_sales", "invoice_requests", orgs, "organization_id"),
                "invoices": delete_exact(psql, "impex_sales", "invoices", orgs, "organization_id", ledger=True),
                "invoice counters": delete_exact(psql, "impex_sales", "invoice_counters", orgs, "organization_id"),
                "order requests (sales)": delete_exact(psql, "impex_sales", "sales_order_requests", orgs, "organization_id"),
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
