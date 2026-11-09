#!/usr/bin/env python3
"""End-to-end check of Sales Invoicing and Client Payment Tracking against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_sales migrated to head (0003)
    python scripts/verify_invoicing.py
    python scripts/verify_invoicing.py --with-outage    # also stops the Inventory and Sales services briefly

It creates two throwaway organizations ("Invoice Check Alpha / Beta") with one administrator each, signs both in to the Organization
Portal and works through the portal's own server routes exactly as the browser does: puts goods into stock, dispatches them to clients
(confirmed dispatches), then bills them - drafts, partial invoicing, issuing, payments, reversals, voiding, PDFs - and checks, against
the databases themselves, that the money is exact, that the same dispatched quantity is never billed twice, that payments never exceed
what is owed, that payment history is never destroyed, and that INVOICING AND PAYMENTS NEVER TOUCH STOCK: after everything, the
Inventory database (balances, movements, operations, catalog prices) is exactly what it was before the first invoice was drafted.

Everything it created is deleted afterwards, by exact id. No emails are sent, no real payment or bank is involved and no existing
record is touched.
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


def call_binary(port, path, cookies=None):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    conn.request("GET", path, headers={"Cookie": "; ".join(f"{k}={v}" for k, v in (cookies or {}).items())} if cookies else {})
    res = conn.getresponse()
    body = res.read()
    headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, body, headers


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


def run_parallel(count, work):
    outcomes = []
    threads = [threading.Thread(target=lambda i=i: outcomes.append(work(i))) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    return outcomes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory and Sales services briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "invcheck-sa@example.org"
    emails = {"a": "invcheck-admin-a@example.org", "b": "invcheck-admin-b@example.org"}
    org_names = {"a": "Invoice Check Alpha", "b": "Invoice Check Beta"}
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
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"inv-{uuid.uuid4()}"})[0]

    def new_client(key, name):
        _, text, _, _ = portal(key, "POST", "/api/sales/clients", {"name": name})
        body = jbody(text).get("client", {})
        created.add("clients", body.get("id"))
        return body

    def list_detail(key, list_id):
        return jbody(portal(key, "GET", f"/api/sales/delivery-lists/{list_id}")[1]).get("list", {})

    def ready_list(key, client_id, items):
        _, text, _, _ = portal(key, "POST", "/api/sales/delivery-lists", {"clientId": client_id})
        made = jbody(text).get("list", {})
        for product_id, quantity in items:
            portal(key, "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": product_id, "quantity": quantity})
        portal(key, "POST", f"/api/sales/delivery-lists/{made['id']}/ready")
        return list_detail(key, made["id"])

    def dispatch(key, delivery_list, lines, do_confirm=True):
        """lines: (product_id, quantity). Returns the dispatch (confirmed unless do_confirm is False)."""
        items = {i["product_id"]: i["id"] for i in delivery_list["items"]}
        body = [{"deliveryListItemId": items[p], "quantity": q} for p, q in lines]
        _, text, _, _ = portal(key, "POST", "/api/sales/dispatches", {"deliveryListId": delivery_list["id"], "lines": body}, {"Idempotency-Key": f"inv-{uuid.uuid4()}"})
        made = jbody(text).get("dispatch", {})
        if do_confirm:
            portal(key, "POST", f"/api/sales/dispatches/{made['id']}/confirm")
        return jbody(portal(key, "GET", f"/api/sales/dispatches/{made['id']}")[1]).get("dispatch", {})

    def bill(dispatch_doc, product_id, quantity, price, **extra):
        line = next(l for l in dispatch_doc["lines"] if l["product_id"] == product_id)
        return {"dispatchLineId": line["id"], "quantity": quantity, "unitPrice": price, **extra}

    def create(key, client_id, lines, currency="USD", idem=None, **extra):
        status, text, _, _ = portal(key, "POST", "/api/sales/invoices", {"clientId": client_id, "currencyCode": currency, "lines": lines, **extra}, {"Idempotency-Key": idem or f"inv-{uuid.uuid4()}"})
        body = jbody(text)
        return status, body

    def get(key, invoice_id):
        status, text, _, _ = portal(key, "GET", f"/api/sales/invoices/{invoice_id}")
        return status, jbody(text).get("invoice", {})

    def act(key, invoice_id, action, body=None):
        status, text, _, _ = portal(key, "POST", f"/api/sales/invoices/{invoice_id}/{action}", body)
        return status, jbody(text)

    def pay(key, invoice_id, amount, idem=None, method="bank_transfer", **extra):
        status, text, _, _ = portal(key, "POST", f"/api/sales/invoices/{invoice_id}/payments", {"amount": amount, "method": method, **extra}, {"Idempotency-Key": idem or f"pay-{uuid.uuid4()}"})
        return status, jbody(text)

    def reverse(key, invoice_id, payment_id, reason="entered twice", idem=None):
        status, text, _, _ = portal(key, "POST", f"/api/sales/invoices/{invoice_id}/payments/{payment_id}/reverse", {"reason": reason}, {"Idempotency-Key": idem or f"rev-{uuid.uuid4()}"})
        return status, jbody(text)

    def billable(key, client_id):
        status, text, _, _ = portal(key, "GET", f"/api/sales/billable-lines?clientId={client_id}")
        return status, jbody(text).get("lines", [])

    def remaining(key, client_id, product_id, dispatch_number):
        return next((l["remaining_quantity"] for l in billable(key, client_id)[1] if l["product_id"] == product_id and l["dispatch_number"] == dispatch_number), None)

    def inventory_state(org):
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(max(created_at)::text, '') FROM stock_movements WHERE organization_id = '{org}'")
        operations = psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE organization_id = '{org}'")
        prices = psql("impex_inventory", f"SELECT coalesce(string_agg(sku || ':' || cost_price::text || ':' || selling_price::text || ':' || unit || ':' || is_active::text, ',' ORDER BY sku), '') FROM products WHERE organization_id = '{org}'")
        return balances, movements, operations, prices

    def sales_state(org):
        """What a dispatch/list looks like, to prove invoicing never changes it."""
        return psql("impex_sales", f"SELECT coalesce(string_agg(d.id || ':' || d.status || ':' || coalesce(l.s::text, ''), ',' ORDER BY d.id), '') FROM dispatches d LEFT JOIN (SELECT dispatch_id, sum(quantity) AS s FROM dispatch_lines GROUP BY dispatch_id) l ON l.dispatch_id = d.id WHERE d.organization_id = '{org}'") + "|" + \
            psql("impex_sales", f"SELECT coalesce(string_agg(id || ':' || status, ',' ORDER BY id), '') FROM delivery_lists WHERE organization_id = '{org}'")

    def quantity(product_id):
        return Decimal(psql("impex_inventory", f"SELECT coalesce((SELECT quantity FROM stock_balances WHERE product_id = '{product_id}'), 0)") or "0")

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='INVcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"invcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        a_bolt, a_flour, b_bolt = product("a", "INV-BOLT", "INVA steel bolt", "pcs"), product("a", "INV-FLOUR", "INVA flour", "kg"), product("b", "INV-BOLT", "INVB silk scarf", "pcs")
        check("products created (the same SKU 'INV-BOLT' in both organizations)", all(x.get("id") for x in (a_bolt, a_flour, b_bolt)))
        stock_in("a", a_bolt["id"], "100")
        stock_in("a", a_flour["id"], "50")
        stock_in("b", b_bolt["id"], "50")
        acme, zenith, beta_client = new_client("a", "INV Acme Ltd"), new_client("a", "INV Zenith Ltd"), new_client("b", "INV Beta Client")
        dl_acme = ready_list("a", acme["id"], [(a_bolt["id"], "20"), (a_flour["id"], "4")])
        dl_zenith = ready_list("a", zenith["id"], [(a_bolt["id"], "8")])
        dl_beta = ready_list("b", beta_client["id"], [(b_bolt["id"], "20")])
        d1 = dispatch("a", dl_acme, [(a_bolt["id"], "10"), (a_flour["id"], "2.5")])
        d2 = dispatch("a", dl_acme, [(a_bolt["id"], "5")])
        d5 = dispatch("a", dl_acme, [(a_bolt["id"], "5")])  # kept aside for the outage checks
        d_draft = dispatch("a", dl_acme, [(a_flour["id"], "1")], do_confirm=False)  # a dispatch that is NOT confirmed
        d3 = dispatch("a", dl_zenith, [(a_bolt["id"], "8")])
        b_d1 = dispatch("b", dl_beta, [(b_bolt["id"], "20")])
        check("confirmed dispatches exist: A has 3 for Acme (10+2.5 kg, 5, 5) and one for Zenith (8), plus a DRAFT one; B has one of 20",
              all(x.get("status") == "confirmed" for x in (d1, d2, d5, d3, b_d1)) and d_draft.get("status") == "draft", [x.get("status") for x in (d1, d2, d5, d_draft, d3, b_d1)])
        inventory_before = {k: inventory_state(org_ids[k]) for k in ("a", "b")}
        sales_before = {k: sales_state(org_ids[k]) for k in ("a", "b")}
        stock_a_bolt, stock_a_flour = quantity(a_bolt["id"]), quantity(a_flour["id"])
        check("starting stock after the dispatches: bolts 100-10-5-5-8 = 72, flour 50-2.5 = 47.5 (the draft dispatch deducted nothing)", stock_a_bolt == Decimal("72") and stock_a_flour == Decimal("47.5"), (stock_a_bolt, stock_a_flour))

        print("\n== 1. what can be billed: only CONFIRMED dispatches of THIS client")
        s, lines = billable("a", acme["id"])
        by = {(l["product_sku"], l["dispatch_number"]): l for l in lines}
        check("Acme's billable lines are the confirmed dispatch lines only (bolt 10, flour 2.5, bolt 5, bolt 5), nothing from the draft dispatch or from Zenith",
              s == 200 and len(lines) == 4 and by[("INV-BOLT", d1["number"])]["dispatched_quantity"] == "10.0000" and by[("INV-FLOUR", d1["number"])]["remaining_quantity"] == "2.5000"
              and all(l["invoiced_quantity"] == "0.0000" and l["in_drafts_quantity"] == "0.0000" for l in lines) and d_draft["number"] not in {l["dispatch_number"] for l in lines}, (s, lines))
        check("another organization's client has no billable lines for A (404 like a missing client)", billable("a", beta_client["id"])[0] == 404 and billable("a", str(uuid.uuid4()))[0] == 404)
        s, body = create("a", acme["id"], [{"dispatchLineId": d_draft["lines"][0]["id"], "quantity": "1", "unitPrice": "2"}])
        check("a line of a dispatch that is only a DRAFT cannot be billed (404)", s == 404, (s, body))
        s, body = create("a", zenith["id"], [bill(d1, a_bolt["id"], "1", "2")])
        check("another client's dispatched goods cannot be billed (404)", s == 404, (s, body))
        s, body = create("a", acme["id"], [{"dispatchLineId": b_d1["lines"][0]["id"], "quantity": "1", "unitPrice": "2"}])
        check("another organization's dispatched goods cannot be billed (404)", s == 404, (s, body))

        print("\n== 2. a draft: exact money, the selling price is the administrator's own")
        lines_i1 = [bill(d1, a_bolt["id"], "6", "2.50", discountAmount="1.00", taxRate="10", taxLabel="VAT"), bill(d1, a_flour["id"], "0.5", "3.3333")]
        s, body = create("a", acme["id"], lines_i1, idem="inv-live-key-0001", notes="Net 30")
        i1 = body.get("invoice", {})
        bolt_line = next((l for l in i1.get("lines", []) if l["product_sku"] == "INV-BOLT"), {})
        flour_line = next((l for l in i1.get("lines", []) if l["product_sku"] == "INV-FLOUR"), {})
        check("A drafts an invoice (201): no number yet, status draft, USD, for Acme, against DL-000001, no organization id in the answer",
              s == 201 and i1.get("status") == "draft" and i1.get("number") is None and i1.get("currency_code") == "USD" and i1.get("client", {}).get("name") == "INV Acme Ltd"
              and i1.get("delivery_list", {}).get("number") == "DL-000001" and "organization_id" not in json.dumps(body), (s, body))
        check("bolts: 6 x 2.50 = 15.00, less 1.00 discount = 14.00, + 10% VAT 1.40 = 15.40", (bolt_line.get("line_subtotal"), bolt_line.get("line_net"), bolt_line.get("line_tax"), bolt_line.get("line_total")) == ("15.0000", "14.0000", "1.4000", "15.4000"), bolt_line)
        check("flour: 0.5 x 3.3333 = 1.66665 rounds HALF UP to 1.6667", flour_line.get("line_total") == "1.6667", flour_line)
        check("invoice totals: subtotal 16.6667, discount 1.00, tax 1.40, total 17.0667, nothing paid",
              (i1.get("subtotal"), i1.get("discount_total"), i1.get("tax_total"), i1.get("total"), i1.get("paid_total"), i1.get("outstanding")) == ("16.6667", "1.0000", "1.4000", "17.0667", "0.0000", "17.0667"), i1)
        check("name, SKU and unit are snapshots taken from the dispatch (not from the browser); the price is the typed 2.50, not the catalog's 9.99",
              (bolt_line.get("product_name"), bolt_line.get("product_sku"), bolt_line.get("unit"), bolt_line.get("unit_price")) == ("INVA steel bolt", "INV-BOLT", "pcs", "2.5000"))
        s2, again = create("a", acme["id"], lines_i1, idem="inv-live-key-0001", notes="Net 30")
        check("a double click / retry with the same key answers 200 with the SAME draft", s2 == 200 and again["invoice"]["id"] == i1["id"] and again.get("replayed") is True, (s2, again))
        s3, _ = create("a", acme["id"], [bill(d1, a_bolt["id"], "1", "2")], idem="inv-live-key-0001")
        check("the same key for a different invoice is refused (409)", s3 == 409, s3)
        outcomes = run_parallel(6, lambda i: create("a", acme["id"], [bill(d2, a_bolt["id"], "1", "2")], idem="inv-double-click-01"))
        ids = {b["invoice"]["id"] for s, b in outcomes if s in (200, 201)}
        check("6 simultaneous submissions of one form create ONE draft (one 201, five 200)", sorted(s for s, _ in outcomes) == [200] * 5 + [201] and len(ids) == 1, [s for s, _ in outcomes])
        act("a", next(iter(ids)), "void")
        for label, line, expect in (
            ("a zero quantity", bill(d1, a_bolt["id"], "0", "2"), 400), ("a negative price", bill(d1, a_bolt["id"], "1", "-2"), 400), ("a text quantity", bill(d1, a_bolt["id"], "lots", "2"), 400),
            ("five decimals", bill(d1, a_bolt["id"], "1", "2.00001"), 400), ("a tax rate over 100", bill(d1, a_bolt["id"], "1", "2", taxRate="101"), 400),
            ("a discount bigger than the line", bill(d1, a_bolt["id"], "1", "2", discountAmount="2.01"), 422),
        ):
            s, body = create("a", acme["id"], [line])
            check(f"{label} is refused ({expect})", s in (expect, 400, 422) and s != 201, (s, body))
        for currency in ("XYZ", "US", "12A"):
            s, body = create("a", acme["id"], [], currency=currency)
            check(f"currency '{currency}' is not an ISO 4217 code and is refused", s in (400, 422), (s, body))
        s, body = create("a", acme["id"], [{**bill(d1, a_bolt["id"], "1", "2"), "productName": "Hacked", "total": "1", "status": "paid"}])
        check("name / total / status sent by the browser are ignored (the draft takes them from the dispatch and calculates itself)",
              s == 201 and body["invoice"]["status"] == "draft" and body["invoice"]["lines"][0]["product_name"] == "INVA steel bolt" and body["invoice"]["total"] == "2.0000", (s, body))
        act("a", body["invoice"]["id"], "void")
        check("the draft changed no stock and no dispatch", {k: inventory_state(org_ids[k]) for k in ("a", "b")} == inventory_before and {k: sales_state(org_ids[k]) for k in ("a", "b")} == sales_before)

        print("\n== 3. editing a draft")
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/invoices/{i1['id']}", {"invoiceDate": "2026-01-10", "dueDate": "2026-02-10", "notes": "Net 31"})
        edited = jbody(text).get("invoice", {})
        check("the dates and the note of a draft can be changed (200)", s == 200 and (edited.get("invoice_date"), edited.get("due_date"), edited.get("notes")) == ("2026-01-10", "2026-02-10", "Net 31"), (s, text[:200]))
        s, text, _, _ = portal("a", "PATCH", f"/api/sales/invoices/{i1['id']}", {"dueDate": "2025-12-01"})
        check("a due date before the invoice date is refused", s in (400, 422), s)
        s, text, _, _ = portal("a", "PUT", f"/api/sales/invoices/{i1['id']}/lines", {"lines": [bill(d1, a_bolt["id"], "6", "2.50", discountAmount="1.00", taxRate="10", taxLabel="VAT"), bill(d1, a_flour["id"], "0.5", "3.3333")]})
        check("the lines of a draft can be replaced (200); the totals are recalculated by the server", s == 200 and jbody(text)["invoice"]["total"] == "17.0667", (s, text[:200]))
        s, body = create("a", acme["id"], [bill(d1, a_bolt["id"], "11", "2")])
        check("billing more than was dispatched (11 of 10) is refused (409 over_invoiced)", s == 409 and body.get("code") == "over_invoiced", (s, body))
        status, html, _ = page("a", f"/invoices/{i1['id']}/edit")
        check("the Edit draft page opens the draft", status == 200 and "Edit draft invoice" in html and "Save draft and review" in html, status)

        print("\n== 4. partial invoicing: 6 of 10 now, the rest later, never more")
        s, issued1 = act("a", i1["id"], "issue")
        i1 = issued1.get("invoice", {})
        check("A issues the draft (200): INV-000001, issued, with who and when", s == 200 and i1.get("number") == "INV-000001" and i1.get("status") == "issued" and i1.get("issued_by_email") == emails["a"] and i1.get("issued_at"), (s, issued1))
        s2, again = act("a", i1["id"], "issue")
        check("issuing again changes nothing (same number, same time)", s2 == 200 and again["invoice"]["number"] == "INV-000001" and again["invoice"]["issued_at"] == i1["issued_at"])
        check("bolts of the first dispatch: 4 left to bill; flour: 2 kg left", remaining("a", acme["id"], a_bolt["id"], d1["number"]) == "4.0000" and remaining("a", acme["id"], a_flour["id"], d1["number"]) == "2.0000")
        s, body = create("a", acme["id"], [bill(d1, a_bolt["id"], "5", "2")])
        check("billing 5 when only 4 are left is refused, saying at most 4 can still be billed", s == 409 and body.get("code") == "over_invoiced" and "at most 4" in body.get("error", ""), (s, body))
        s, body = create("a", acme["id"], [bill(d1, a_bolt["id"], "4", "3.00"), bill(d2, a_bolt["id"], "5", "3.00")])
        i2 = body.get("invoice", {})
        check("ONE invoice can bill two dispatches of one list (4 + 5 bolts at a different price, 3.00)", s == 201 and len(i2.get("lines", [])) == 2 and i2.get("total") == "27.0000" and
              sorted(a["dispatch_number"] for l in i2["lines"] for a in l["allocations"]) == sorted([d1["number"], d2["number"]]), (s, body))
        s, issued2 = act("a", i2["id"], "issue")
        i2 = issued2.get("invoice", {})
        check("...issued as INV-000002", s == 200 and i2.get("number") == "INV-000002", (s, issued2))
        check("every bolt dispatched to Acme in DS 1 and 2 is now billed: nothing left", remaining("a", acme["id"], a_bolt["id"], d1["number"]) == "0.0000" and remaining("a", acme["id"], a_bolt["id"], d2["number"]) == "0.0000")
        s, body = create("a", acme["id"], [bill(d1, a_bolt["id"], "0.0001", "2")])
        check("not even a fraction more can be billed (409)", s == 409, (s, body))

        print("\n== 5. the same goods cannot be billed twice, even when drafts compete")
        drafts = [create("a", acme["id"], [bill(d1, a_flour["id"], "2", "5")])[1]["invoice"] for _ in range(4)]
        check("drafts reserve nothing: four drafts for the same 2 kg of flour can exist", all(d.get("status") == "draft" for d in drafts))
        outcomes = run_parallel(4, lambda i: act("a", drafts[i]["id"], "issue"))
        check("issuing all four at the same moment: exactly ONE is issued, three are refused (409)", sorted(s for s, _ in outcomes) == [200, 409, 409, 409], [s for s, _ in outcomes])
        winner = next(d for d in drafts if get("a", d["id"])[1].get("status") == "issued")
        check("the winner took the next number (INV-000003); the losers consumed none and are still drafts", get("a", winner["id"])[1]["number"] == "INV-000003" and sum(get("a", d["id"])[1]["status"] == "draft" for d in drafts) == 3)
        for d in drafts:
            if d["id"] != winner["id"]:
                act("a", d["id"], "void")
        check("an issued invoice is frozen: editing its details or its lines is refused (409)",
              portal("a", "PATCH", f"/api/sales/invoices/{i1['id']}", {"notes": "x"})[0] == 409 and portal("a", "PUT", f"/api/sales/invoices/{i1['id']}/lines", {"lines": []})[0] == 409)
        check("a draft with no lines cannot be issued (409)", act("a", create("a", acme["id"], [])[1]["invoice"]["id"], "issue")[0] == 409)

        print("\n== 6. payments")
        s, p1 = pay("a", i1["id"], "10", idem="pay-live-key-01", method="cash", reference="RCPT-1", notes="at the counter")
        inv = p1.get("invoice", {})
        check("A records a partial payment of 10.00 (201): partially paid, 7.0667 outstanding, with method, reference, who and when",
              s == 201 and inv.get("status") == "partially_paid" and (inv.get("paid_total"), inv.get("outstanding")) == ("10.0000", "7.0667") and
              (inv["payments"][0]["method"], inv["payments"][0]["reference"], inv["payments"][0]["recorded_by_email"]) == ("cash", "RCPT-1", emails["a"]), (s, p1))
        s, again = pay("a", i1["id"], "10", idem="pay-live-key-01", method="cash", reference="RCPT-1", notes="at the counter")
        check("a double click / retry with the same key answers 200 and records NOTHING twice", s == 200 and again.get("replayed") is True and len(again["invoice"]["payments"]) == 1 and again["invoice"]["paid_total"] == "10.0000", (s, again))
        check("the same key for a different amount is refused (409)", pay("a", i1["id"], "11", idem="pay-live-key-01", method="cash")[0] == 409)
        s, body = pay("a", i1["id"], "7.0668")
        check("a payment above the outstanding amount is refused (409 overpayment): no credit is held", s == 409 and body.get("code") == "overpayment", (s, body))
        for label, amount in (("a zero", "0"), ("a negative", "-5"), ("a text", "ten"), ("five decimals", "1.00001")):
            s, _ = pay("a", i1["id"], amount)
            check(f"{label} amount is refused", s in (400, 422), s)
        check("an unknown payment method is refused", portal("a", "POST", f"/api/sales/invoices/{i1['id']}/payments", {"amount": "1", "method": "bitcoin"}, {"Idempotency-Key": f"pay-{uuid.uuid4()}"})[0] == 400)
        s, p2 = pay("a", i1["id"], "7.0667", method="bank_transfer")
        check("the second payment settles it exactly: PAID, nothing outstanding", s == 201 and p2["invoice"]["status"] == "paid" and p2["invoice"]["outstanding"] == "0.0000" and len(p2["invoice"]["payments"]) == 2, (s, p2))
        s, body = pay("a", i1["id"], "0.0001")
        check("a paid invoice takes no more payments (409)", s == 409, (s, body))
        s, _ = pay("a", create("a", acme["id"], [])[1]["invoice"]["id"], "1")
        check("a DRAFT takes no payments (409)", s == 409, s)

        print("\n== 7. payments at the same moment can never exceed the invoice")
        s, _ = pay("a", i2["id"], "1", idem="pay-live-key-02")  # 27.00 due -> 26.00
        outcomes = run_parallel(5, lambda i: pay("a", i2["id"], "10"))
        check("five simultaneous payments of 10.00 against 26.00 outstanding: exactly two are recorded, three refused", sorted(s for s, _ in outcomes) == [201, 201, 409, 409, 409], [s for s, _ in outcomes])
        s, current = get("a", i2["id"])
        check("paid 21.00, outstanding 6.00, partially paid", (current.get("paid_total"), current.get("outstanding"), current.get("status")) == ("21.0000", "6.0000", "partially_paid"), current)
        outcomes = run_parallel(6, lambda i: pay("a", i2["id"], "5", idem="pay-double-click-01"))
        check("six simultaneous submissions of one payment form record ONE payment (one 201, five 200)", sorted(s for s, _ in outcomes) == [200] * 5 + [201], [s for s, _ in outcomes])
        s, current = get("a", i2["id"])
        check("paid 26.00, outstanding 1.00", (current.get("paid_total"), current.get("outstanding")) == ("26.0000", "1.0000"), current)

        print("\n== 8. a mistake is corrected by a reversal; nothing is ever edited or deleted")
        five = next(p for p in current["payments"] if p["amount"] == "5.0000")
        s, body = reverse("a", i2["id"], five["id"], reason="")
        check("a reversal needs a reason (400)", s == 400, (s, body))
        s, rv = reverse("a", i2["id"], five["id"], reason="counted twice", idem="rev-live-key-01")
        after = rv.get("invoice", {})
        check("A reverses the 5.00 payment (201): paid 21.00, outstanding 6.00; both records stay, the payment is flagged reversed",
              s == 201 and (after.get("paid_total"), after.get("outstanding")) == ("21.0000", "6.0000") and
              next(p for p in after["payments"] if p["id"] == five["id"])["reversed"] is True and any(p["kind"] == "reversal" and p["reverses_payment_id"] == five["id"] and p["notes"] == "counted twice" for p in after["payments"]), (s, rv))
        s, again = reverse("a", i2["id"], five["id"], reason="counted twice", idem="rev-live-key-01")
        check("a retry of the same reversal answers 200 and adds nothing", s == 200 and len(again["invoice"]["payments"]) == len(after["payments"]), (s, again))
        s, body = reverse("a", i2["id"], five["id"], reason="again")
        check("a payment can be reversed only once (409 already_reversed)", s == 409 and body.get("code") == "already_reversed", (s, body))
        reversal = next(p for p in after["payments"] if p["kind"] == "reversal")
        check("a reversal cannot itself be reversed, and an unknown payment is not found (404)", reverse("a", i2["id"], reversal["id"])[0] == 404 and reverse("a", i2["id"], str(uuid.uuid4()))[0] == 404)
        s, body = act("a", i2["id"], "void", {"reason": "oops"})
        check("an invoice with payments cannot be voided (409 has_payments): the payment history cannot be destroyed", s == 409 and body.get("code") == "has_payments" and get("a", i2["id"])[1]["status"] == "partially_paid", (s, body))
        s, body = act("a", i1["id"], "void", {"reason": "oops"})
        check("...nor can a PAID one", s == 409 and body.get("code") == "has_payments" and get("a", i1["id"])[1]["status"] == "paid", (s, body))
        net = psql("impex_sales", f"SELECT sum(CASE kind WHEN 'payment' THEN amount ELSE -amount END) FROM invoice_payments WHERE invoice_id = '{i2['id']}'")
        check("the stored paid total equals the payment records (payments minus reversals)", Decimal(net) == Decimal(get("a", i2["id"])[1]["paid_total"]), net)
        s, rv2 = reverse("a", i1["id"], p1["invoice"]["payments"][0]["id"], reason="bounced cheque")
        check("reversing a payment of a PAID invoice puts it back to partially paid", s == 201 and rv2["invoice"]["status"] == "partially_paid" and rv2["invoice"]["outstanding"] == "10.0000", (s, rv2))
        s, repaid = pay("a", i1["id"], "10", method="card")
        check("...and the corrected payment can then be recorded: paid again", s == 201 and repaid["invoice"]["status"] == "paid", (s, repaid))

        print("\n== 9. voiding an unpaid invoice frees the goods; the number stays on record")
        s, void = act("a", winner["id"], "void", {})
        check("voiding an issued invoice needs a reason (422/400)", s in (400, 422), (s, void))
        s, void = act("a", winner["id"], "void", {"reason": "issued to the wrong client"})
        voided = void.get("invoice", {})
        check("A voids the unpaid INV-000003 with a reason (200): void, number kept, reason and time recorded", s == 200 and voided.get("status") == "void" and voided.get("number") == "INV-000003" and voided.get("void_reason") == "issued to the wrong client" and voided.get("voided_at"), (s, void))
        check("its 2 kg of flour can be billed again", remaining("a", acme["id"], a_flour["id"], d1["number"]) == "2.0000")
        s, i4 = create("a", acme["id"], [bill(d1, a_flour["id"], "2", "6.10")])
        s, issued4 = act("a", i4["invoice"]["id"], "issue")
        check("...re-billed as INV-000004 (the voided number is never reused)", s == 200 and issued4["invoice"]["number"] == "INV-000004" and issued4["invoice"]["total"] == "12.2000", (s, issued4))
        s, body = pay("a", winner["id"], "1")
        check("a VOID invoice takes no payment, cannot be re-issued and cannot be edited (409)", s == 409 and act("a", winner["id"], "issue")[0] == 409 and portal("a", "PUT", f"/api/sales/invoices/{winner['id']}/lines", {"lines": []})[0] == 409)
        s, repeat = act("a", winner["id"], "void", {"reason": "again"})
        check("voiding twice is harmless (200, still void)", s == 200 and repeat["invoice"]["status"] == "void")
        s, d = create("a", acme["id"], [bill(d5, a_bolt["id"], "1", "2")])
        s, dv = act("a", d["invoice"]["id"], "void")
        check("a draft is discarded by voiding it: it never had a number (200)", s == 200 and dv["invoice"]["status"] == "void" and dv["invoice"]["number"] is None, (s, dv))

        print("\n== 10. currencies are never mixed or converted")
        s, e1 = create("a", zenith["id"], [bill(d3, a_bolt["id"], "3", "10")], currency="eur")
        s, e2 = create("a", zenith["id"], [bill(d3, a_bolt["id"], "3", "100")], currency="PKR")
        s, e3 = create("a", zenith["id"], [bill(d3, a_bolt["id"], "2", "7")], currency="USD")
        check("lower-case 'eur' is accepted as EUR; PKR and USD invoices can sit side by side", e1["invoice"]["currency_code"] == "EUR" and e2["invoice"]["currency_code"] == "PKR" and e3["invoice"]["currency_code"] == "USD")
        eur = act("a", e1["invoice"]["id"], "issue")[1]["invoice"]
        pkr = act("a", e2["invoice"]["id"], "issue")[1]["invoice"]
        usd = e3["invoice"]
        check("EUR and PKR invoices are issued with the organization's next numbers", (eur["number"], pkr["number"]) == ("INV-000005", "INV-000006"), (eur["number"], pkr["number"]))
        s, text, _, _ = portal("a", "GET", f"/api/sales/clients/{zenith['id']}/account")
        account = jbody(text).get("account", {})
        balances = {b["currency_code"]: b for b in account.get("balances", [])}
        check("Zenith's account keeps each currency apart: EUR 30.00 and PKR 300.00 outstanding (the draft USD invoice counts for nothing)",
              s == 200 and set(balances) == {"EUR", "PKR"} and balances["EUR"]["outstanding"] == "30.0000" and balances["PKR"]["outstanding"] == "300.0000", (s, account.get("balances")))

        print("\n== 11. an inactive client: no new invoices, but money received is still recorded")
        portal("a", "POST", f"/api/sales/clients/{zenith['id']}/deactivate")
        s, body = create("a", zenith["id"], [bill(d3, a_bolt["id"], "1", "2")])
        check("a new invoice for an inactive client is refused (409)", s == 409 and "inactive" in body.get("error", "").lower(), (s, body))
        s, body = act("a", usd["id"], "issue")
        check("a draft of an inactive client cannot be issued (409)", s == 409, (s, body))
        s, body = pay("a", eur["id"], "30")
        check("a payment against an issued invoice of the inactive client IS recorded (201): the EUR invoice is paid", s == 201 and body["invoice"]["status"] == "paid", (s, body))
        portal("a", "POST", f"/api/sales/clients/{zenith['id']}/activate")
        s, body = act("a", usd["id"], "issue")
        check("after reactivating the client the draft can be issued (200)", s == 200, (s, body))

        print("\n== 12. the invoice PDF")
        s, body, headers = call_binary(TENANT_PORTAL, f"/api/sales/invoices/{i1['id']}/pdf", {"impex_tenant_session": cookies["a"]})
        check("INV-000001 downloads as a PDF (200, application/pdf, attachment INV-000001.pdf, never cached)",
              s == 200 and body.startswith(b"%PDF-") and headers.get("content-type") == "application/pdf" and 'filename="INV-000001.pdf"' in headers.get("content-disposition", "") and headers.get("cache-control") == "no-store", (s, headers))
        for expected in (b"INV-000001", b"Invoice Check Alpha", b"INV Acme Ltd", b"INVA steel bolt", b"17.0667", b"RCPT-1", b"does not certify"):
            check(f"the PDF contains {expected.decode()}", expected in body)
        check("a draft has a PDF too", call_binary(TENANT_PORTAL, f"/api/sales/invoices/{drafts[0]['id']}/pdf", {"impex_tenant_session": cookies["a"]})[0] == 200)
        check("no session: 401; another organization's invoice: 404; a malformed id: 404",
              call_binary(TENANT_PORTAL, f"/api/sales/invoices/{i1['id']}/pdf")[0] == 401 and call_binary(TENANT_PORTAL, f"/api/sales/invoices/{i1['id']}/pdf", {"impex_tenant_session": cookies["b"]})[0] == 404
              and call_binary(TENANT_PORTAL, "/api/sales/invoices/not-an-id/pdf", {"impex_tenant_session": cookies["a"]})[0] == 404)

        print("\n== 13. the pages")
        status, html, _ = page("a", "/invoices")
        check("the Invoices page lists the invoices and has the filters", status == 200 and all(x in html for x in ("INV-000001", "INV-000002", "INV Acme Ltd", "New Invoice", "Any payment status", "All clients")), status)
        check("the navigation has an Invoices link", 'href="/invoices"' in html)
        status, html, _ = page("a", f"/invoices?status=void&client={acme['id']}")
        check("filtering by status and client works (only the voided INV-000003)", status == 200 and "INV-000003" in html and "INV-000001" not in html, status)
        status, html, _ = page("a", "/invoices?payment=overdue")
        check("the overdue filter loads", status == 200)
        status, html, _ = page("a", f"/invoices/new?client={acme['id']}")
        check("New invoice for a client shows their billable dispatch lines", status == 200 and d5["number"] in html and "Left to bill" in html, status)
        status, html, _ = page("a", f"/invoices/{i1['id']}")
        check("an invoice page shows the parties, lines, totals, payments, Print and Download PDF", status == 200 and all(x in html for x in ("INV-000001", "INVA steel bolt", "17.0667", "Payments", "RCPT-1", "Print", "Download PDF", "Reversed")), status)
        status, html, _ = page("a", f"/clients/{acme['id']}")
        check("the client's page shows the account: invoices, payments and the outstanding balance",
              status == 200 and all(x in html for x in ("INV Acme Ltd", "Outstanding balance", "INV-000002", "Recent payments", "USD")), status)
        status, html, _ = page("a", "/clients")
        check("the Clients page links each client to its account", status == 200 and f'href="/clients/{acme["id"]}"' in html, status)
        status, html, _ = page("a", f"/dispatches/{d5['id']}")
        check("a confirmed dispatch offers 'Create invoice'", status == 200 and "Create invoice" in html, status)

        print("\n== 14. the other organization sees and changes nothing")
        before_b = int(psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids['b']}'"))
        s, mine = create("b", beta_client["id"], [{"dispatchLineId": b_d1["lines"][0]["id"], "quantity": "20", "unitPrice": "1.50"}])
        s, bi = act("b", mine["invoice"]["id"], "issue")
        check("B bills and issues its own invoice: numbered INV-000001 independently of A's", s == 200 and bi["invoice"]["number"] == "INV-000001" and bi["invoice"]["total"] == "30.0000", (s, bi))
        listed = jbody(portal("b", "GET", "/api/sales/invoices")[1])
        check("B lists only its own invoice; A lists only its own", listed.get("total") == 1 and listed["items"][0]["id"] == mine["invoice"]["id"] and all(i["client"]["name"].startswith("INV ") for i in jbody(portal("a", "GET", "/api/sales/invoices?limit=100")[1])["items"]))
        missing = str(uuid.uuid4())
        for label, method, suffix, body_, hdr in (
            ("read", "GET", "", None, None), ("pdf", "GET", "/pdf", None, None), ("edit", "PATCH", "", {"notes": "HIJACKED"}, None), ("replace lines", "PUT", "/lines", {"lines": []}, None),
            ("issue", "POST", "/issue", None, None), ("void", "POST", "/void", {"reason": "x"}, None), ("pay", "POST", "/payments", {"amount": "1", "method": "cash"}, {"Idempotency-Key": "hijack-pay-0001"}),
            ("reverse", "POST", f"/payments/{p1['invoice']['payments'][0]['id']}/reverse", {"reason": "x"}, {"Idempotency-Key": "hijack-rev-0001"}),
        ):
            s1, t1, _, _ = portal("b", method, f"/api/sales/invoices/{i1['id']}{suffix}", body_, hdr)
            s2, t2, _, _ = portal("b", method, f"/api/sales/invoices/{missing}{suffix}", body_, hdr)
            check(f"B cannot {label} A's invoice: 404, indistinguishable from a missing one", s1 == s2 == 404 and jbody(t1) == jbody(t2) and "Invoice Check" not in t1, (s1, s2))
        check("B cannot see A's client account or billable goods, or bill for A's client (404)",
              portal("b", "GET", f"/api/sales/clients/{acme['id']}/account")[0] == 404 and billable("b", acme["id"])[0] == 404 and create("b", acme["id"], [])[0] == 404)
        s, _ = create("b", beta_client["id"], [{"dispatchLineId": d5["lines"][0]["id"], "quantity": "1", "unitPrice": "1"}])
        check("B cannot bill A's dispatched goods (404)", s == 404, s)
        status, html, _ = page("b", f"/invoices/{i1['id']}")
        check("B opening A's invoice page sees 'Invoice not found.' and none of A's data", status == 200 and "Invoice not found." in html and "INV Acme" not in html and "INVA" not in html, status)
        status, html, _ = page("b", f"/clients/{acme['id']}")
        check("...and A's client page likewise ('Client not found.')", status == 200 and "Client not found." in html and "INV Acme" not in html)
        check("B's records are unchanged by all of that (its one invoice, nothing paid, nothing edited)",
              int(psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids['b']}'")) == before_b + 1
              and psql("impex_sales", f"SELECT (coalesce(sum(paid_total), 0) = 0 AND bool_and(notes IS NULL))::text FROM invoices WHERE organization_id = '{org_ids['b']}'") == "true")
        check("without a session every invoice route says 401", all(call(TENANT_PORTAL, m, p, {} if m != "GET" else None)[0] == 401 for m, p in (("GET", "/api/sales/invoices"), ("POST", "/api/sales/invoices"), ("GET", f"/api/sales/invoices/{i1['id']}"), ("POST", f"/api/sales/invoices/{i1['id']}/issue"), ("POST", f"/api/sales/invoices/{i1['id']}/payments"))))
        s, _, _, loc = call(TENANT_PORTAL, "GET", "/invoices")
        check("the Invoices page without a session redirects to the login page", s in (307, 302, 303) and "/login" in loc, (s, loc))

        print("\n== 15. the DATABASE enforces the rules by itself (raw SQL, the application bypassed)")
        payment_id = p1["invoice"]["payments"][0]["id"]
        void_id = winner["id"]
        raw_draft = create("a", acme["id"], [bill(d5, a_bolt["id"], "1", "2")])[1]["invoice"]  # a DRAFT, for the draft-only rules
        for label, sql, word in (
            ("changing the total of an issued invoice", f"UPDATE invoices SET total = 1 WHERE id = '{i1['id']}'", "frozen"),
            ("changing the client name on an issued invoice", f"UPDATE invoices SET client_name = 'Someone else' WHERE id = '{i1['id']}'", "frozen"),
            ("deleting an invoice", f"DELETE FROM invoices WHERE id = '{i1['id']}'", "never deleted"),
            ("editing a payment", f"UPDATE invoice_payments SET amount = 1 WHERE id = '{payment_id}'", "never edited or deleted"),
            ("deleting a payment", f"DELETE FROM invoice_payments WHERE id = '{payment_id}'", "never edited or deleted"),
            ("marking an invoice paid by hand", f"UPDATE invoices SET status = 'paid', paid_total = total WHERE id = '{i2['id']}'", "must follow"),
            ("changing the paid amount by hand", f"UPDATE invoices SET paid_total = 0 WHERE id = '{i2['id']}'", "must follow"),
            ("reopening a void invoice", f"UPDATE invoices SET status = 'issued' WHERE id = '{void_id}'", "kept for history"),
            ("deleting a line of an issued invoice", f"DELETE FROM invoice_lines WHERE invoice_id = '{i1['id']}'", "frozen"),
            ("deleting an allocation of an issued invoice", f"DELETE FROM invoice_allocations WHERE invoice_id = '{i1['id']}'", "frozen"),
            ("a payment above the outstanding amount",
             f"INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) SELECT organization_id, id, current_date, 7, currency_code, 'cash', 'raw-over-1', 'h', created_by, 'x@y.z' FROM invoices WHERE id = '{i2['id']}'", "cannot exceed"),
            ("a payment against a draft",
             f"INSERT INTO invoice_payments (organization_id, invoice_id, payment_date, amount, currency_code, method, idempotency_key, request_hash, recorded_by, recorded_by_email) SELECT organization_id, id, current_date, 1, currency_code, 'cash', 'raw-draft-1', 'h', created_by, 'x@y.z' FROM invoices WHERE id = '{raw_draft['id']}'", "issued invoice"),
            ("billing goods of a dispatch that is not confirmed",
             f"INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) SELECT organization_id, invoice_id, invoice_line_id, '{d_draft['lines'][0]['id']}', 1 FROM invoice_allocations WHERE invoice_id = '{raw_draft['id']}' LIMIT 1", "CONFIRMED"),
            ("billing another client's dispatched goods",
             f"INSERT INTO invoice_allocations (organization_id, invoice_id, invoice_line_id, dispatch_line_id, quantity) SELECT organization_id, invoice_id, invoice_line_id, '{d3['lines'][0]['id']}', 1 FROM invoice_allocations WHERE invoice_id = '{raw_draft['id']}' LIMIT 1", "own client"),
        ):
            out = psql_with_errors("impex_sales", sql)
            check(f"the database refuses {label}", "ERROR" in out and word in out, out[:200])
        check("...and none of those attempts changed anything",
              get("a", i1["id"])[1]["total"] == "17.0667" and get("a", i2["id"])[1]["paid_total"] == "21.0000" and len(get("a", i1["id"])[1]["payments"]) == 4 and get("a", void_id)[1]["status"] == "void")

        print("\n== 16. invoicing and payments never touched stock")
        check("A: balances, movement history, operations and catalog prices are EXACTLY as before the first invoice", inventory_state(org_ids["a"]) == inventory_before["a"], (inventory_state(org_ids["a"]), inventory_before["a"]))
        check("B: likewise", inventory_state(org_ids["b"]) == inventory_before["b"])
        check("no stock movement was written by invoicing (every movement of these organizations is a client dispatch or the opening stock-in)",
              psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id IN ('{org_ids['a']}', '{org_ids['b']}') AND source_type NOT IN ('client_dispatch') AND movement_type NOT IN ('in')") == "0")
        check("the catalog selling price of every product is still 9.99 although invoices were issued at 2.50, 3.00, 6.10 ...", all(f":9.9900:" in inventory_state(org_ids[k])[3] for k in ("a", "b")))
        check("dispatches and delivery lists are exactly as they were", {k: sales_state(org_ids[k]) for k in ("a", "b")} == sales_before)

        print("\n== 17. consistency of the stored records")
        for org in ("a", "b"):
            bad_paid = psql("impex_sales", f"SELECT count(*) FROM invoices i WHERE i.organization_id = '{org_ids[org]}' AND i.status <> 'draft' AND i.status <> 'void' AND i.paid_total <> (SELECT coalesce(sum(CASE kind WHEN 'payment' THEN amount ELSE -amount END), 0) FROM invoice_payments p WHERE p.invoice_id = i.id)")
            over_billed = psql("impex_sales", f"SELECT count(*) FROM (SELECT a.dispatch_line_id, sum(a.quantity) AS billed FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.organization_id = '{org_ids[org]}' AND i.status IN ('issued', 'partially_paid', 'paid') GROUP BY a.dispatch_line_id) b JOIN dispatch_lines d ON d.id = b.dispatch_line_id WHERE b.billed > d.quantity")
            bad_total = psql("impex_sales", f"SELECT count(*) FROM invoices i WHERE i.organization_id = '{org_ids[org]}' AND i.status <> 'draft' AND i.total <> (SELECT coalesce(sum(line_total), 0) FROM invoice_lines l WHERE l.invoice_id = i.id)")
            negative = psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids[org]}' AND (outstanding < 0 OR paid_total < 0)")
            check(f"organization {org.upper()}: every paid total equals its payments, no dispatched quantity is billed above what was dispatched, every total equals its lines, nothing is negative",
                  (bad_paid, over_billed, bad_total, negative) == ("0", "0", "0", "0"), (bad_paid, over_billed, bad_total, negative))
        numbers = psql("impex_sales", f"SELECT string_agg(number, ',' ORDER BY number) FROM invoices WHERE organization_id = '{org_ids['a']}' AND number IS NOT NULL")
        wanted = ",".join(f"INV-{n:06d}" for n in range(1, len(numbers.split(",")) + 1))
        check("A's invoice numbers have no gaps and no duplicates (voided ones keep theirs)", numbers == wanted and len(numbers.split(",")) >= 6, numbers)

        if args.with_outage:
            print("\n== 18. service outages")
            spare = create("a", acme["id"], [bill(d5, a_bolt["id"], "5", "2")])[1]["invoice"]
            docker("compose", "stop", "inventory-service")
            try:
                s, body = act("a", spare["id"], "issue")
                check("with the INVENTORY service down, an invoice is still issued (200): invoicing does not depend on it", s == 200 and body["invoice"]["status"] == "issued", (s, body))
                s, body = pay("a", spare["id"], "3")
                check("...and a payment is still recorded (201)", s == 201 and body["invoice"]["paid_total"] == "3.0000", (s, body))
                s, pdf, _ = call_binary(TENANT_PORTAL, f"/api/sales/invoices/{spare['id']}/pdf", {"impex_tenant_session": cookies["a"]})
                check("...the PDF downloads and the pages load", s == 200 and pdf.startswith(b"%PDF") and page("a", "/invoices")[0] == 200 and page("a", f"/invoices/{spare['id']}")[0] == 200)
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            docker("compose", "stop", "sales-service")
            try:
                s, body = pay("a", spare["id"], "1")
                check("with the SALES service down a payment answers 503 and records nothing", s == 503, (s, body))
                status, html, _ = page("a", "/invoices")
                check("the Invoices page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html, status)
                check("the PDF route answers 503", call_binary(TENANT_PORTAL, f"/api/sales/invoices/{spare['id']}/pdf", {"impex_tenant_session": cookies["a"]})[0] == 503)
            finally:
                docker("compose", "start", "sales-service")
                wait_until(SALES, "/health")
            s, current = get("a", spare["id"])
            check("after it is back the invoice is exactly as left: paid 3.00 of 10.00", s == 200 and (current["paid_total"], current["outstanding"], current["status"]) == ("3.0000", "7.0000", "partially_paid"), (s, current))
            check("the outage changed no stock", quantity(a_bolt["id"]) == stock_a_bolt and quantity(a_flour["id"]) == stock_a_flour)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")
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
