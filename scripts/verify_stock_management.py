#!/usr/bin/env python3
"""End-to-end check of Warehouses, Stock and Stock Movements against the RUNNING stack.

    docker compose up -d                       # stack must be running (and the migrations applied)
    python scripts/verify_stock_management.py

It creates two throwaway organizations ("Stock Check Alpha / Beta") with one administrator each, signs both in to the
Organization Portal and works through the portal's own server routes exactly as the browser does: warehouses
(create / edit / archive / restore), products, opening balance / stock in / stock out / transfers, retries with the
same Idempotency-Key, ten simultaneous removals against a stock that only fits three, the movement history and its
filters, and then every way of reaching the other organization's warehouses, balances and movements.

Everything it created is deleted afterwards, by exact id (the append-only ledger is cleaned with the database's
out-of-band maintenance switch, which the application itself never uses). No emails are sent and no existing record is
touched. Passwords and tokens are random, kept in memory and never printed.
"""
import http.client
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402

AUTH, ORG, INVENTORY, SUPER_PORTAL, TENANT_PORTAL = 8000, 8001, 8002, 3000, 3001
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
    """Like psql() but keeps what psql prints on stderr (the database's refusal message)."""
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


def main() -> int:
    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "stockcheck-sa@example.org"
    emails = {"a": "stockcheck-admin-a@example.org", "b": "stockcheck-admin-b@example.org"}
    org_names = {"a": "Stock Check Alpha", "b": "Stock Check Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        """A call from the signed-in administrator's browser to the Organization Portal."""
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def page(key, path, query=""):
        status, html, _, location = portal(key, "GET", path + query)
        return status, html.replace("<!-- -->", ""), location

    def warehouse(key, code, name, **extra):
        status, text, _, _ = portal(key, "POST", "/api/warehouses", {"code": code, "name": name, **extra})
        body = jbody(text)
        created.add("warehouses", body.get("warehouse", {}).get("id"))
        return status, body

    def product(key, sku, name, unit):
        status, text, _, _ = portal(key, "POST", "/api/products", {
            "sku": sku, "name": name, "category": "Stock check", "unit": unit, "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD"})
        body = jbody(text)
        created.add("products", body.get("product", {}).get("id"))
        return body.get("product", {})

    def stock(key, action, body, idem=None):
        status, text, _, _ = portal(key, "POST", f"/api/stock/{action}", body, {"Idempotency-Key": idem or f"live-{uuid.uuid4()}"})
        return status, jbody(text)

    def balance(wid, pid):
        return psql("impex_inventory", f"SELECT coalesce(sum(quantity), 0)::text FROM stock_balances WHERE warehouse_id = '{wid}' AND product_id = '{pid}'")

    def counts(org):
        return {t: psql("impex_inventory", f"SELECT count(*) FROM {t} WHERE organization_id = '{org}'") for t in ("warehouses", "stock_balances", "stock_movements", "stock_operations")}

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='Stockcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"stockcheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        print("\n== 1. warehouses: create, edit, archive, restore")
        s, a_main = warehouse("a", "main", "StockA main depot", address="1 Alpha Street")
        check("A creates MAIN (code upper-cased, 201)", s == 201 and a_main["warehouse"]["code"] == "MAIN" and a_main["warehouse"]["address"] == "1 Alpha Street", (s, a_main))
        s, a_annex = warehouse("a", "ANNEX", "StockA annex")
        check("A creates ANNEX without an address", s == 201 and a_annex["warehouse"]["address"] is None, (s, a_annex))
        s, b_main = warehouse("b", "MAIN", "StockB main depot")
        check("B can use the same code 'MAIN' in their own organization", s == 201, (s, b_main))
        s, dup = warehouse("a", "main", "duplicate")
        check("a duplicate code inside A is rejected (409, shown on the Code field)", s == 409 and "code" in (dup.get("fieldErrors") or {}), (s, dup))
        s, bad = warehouse("a", "bad code", "x")
        check("an invalid code is rejected before reaching the service (400)", s == 400 and "code" in (bad.get("fieldErrors") or {}), (s, bad))
        wa_main, wa_annex, wb_main = a_main["warehouse"]["id"], a_annex["warehouse"]["id"], b_main["warehouse"]["id"]
        s, text, _, _ = portal("a", "PATCH", f"/api/warehouses/{wa_annex}", {"name": "StockA annex (renamed)", "address": "2 Alpha Street"})
        check("A edits ANNEX (200)", s == 200 and jbody(text)["warehouse"]["name"] == "StockA annex (renamed)" and jbody(text)["warehouse"]["address"] == "2 Alpha Street", (s, text))
        check("the owner of every new warehouse is the signed-in administrator's organization",
              psql("impex_inventory", f"SELECT organization_id FROM warehouses WHERE id = '{wa_main}'") == org_ids["a"]
              and psql("impex_inventory", f"SELECT organization_id FROM warehouses WHERE id = '{wb_main}'") == org_ids["b"])
        status, html, _ = page("a", "/warehouses")
        check("the Warehouses page lists A's warehouses with address and status", status == 200 and all(x in html for x in ("StockA main depot", "StockA annex (renamed)", "2 Alpha Street", "Add Warehouse")), status)
        check("...and none of B's", "StockB" not in html)

        print("\n== 2. products carry no stock until stock is recorded")
        bolt, flour, nut = product("a", "SC-BOLT", "StockA steel bolt", "pcs"), product("a", "SC-FLOUR", "StockA flour", "kg"), product("a", "SC-NUT", "StockA nut", "pcs")
        b_bolt = product("b", "SC-BOLT", "StockB steel bolt", "pcs")
        check("products were created", all(p.get("id") for p in (bolt, flour, nut, b_bolt)))
        check("the service says which units allow fractions", bolt.get("unit_allows_fractions") is False and flour.get("unit_allows_fractions") is True, (bolt, flour))
        check("a new product has no balance and no movement", psql("impex_inventory", f"SELECT count(*) FROM stock_balances WHERE product_id = '{bolt['id']}'") == "0"
              and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{bolt['id']}'") == "0")

        print("\n== 3. opening balance, stock in, stock out")
        s, b = stock("a", "opening", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "100", "reason": "Stock take"})
        check("A records an opening balance of 100 (201)", s == 201 and b["operation"]["movements"][0]["balance_after"] == "100.0000", (s, b))
        s, b = stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "25", "reason": "Supplier delivery #1"})
        check("stock in of 25 -> 125", s == 201 and balance(wa_main, bolt["id"]) == "125.0000", (s, b))
        s, b = stock("a", "out", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "40", "reason": "Order 7"})
        check("stock out of 40 -> 85", s == 201 and balance(wa_main, bolt["id"]) == "85.0000", (s, b))
        s, b = stock("a", "opening", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "5"})
        check("a second opening balance is refused once there is history (409)", s == 409, (s, b))
        s, b = stock("a", "out", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "86"})
        check("removing more than is there is refused (409, says how much is available)", s == 409 and "85 pcs" in b.get("error", ""), (s, b))
        check("...and the balance did not change", balance(wa_main, bolt["id"]) == "85.0000")
        s, b = stock("a", "out", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "85"})
        check("removing exactly all of it is allowed and ends at 0, never below", s == 201 and balance(wa_main, bolt["id"]) == "0.0000", (s, b))
        stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "50", "reason": "Restock"})
        s, b = stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "1.5"})
        check("a fraction of a piece is refused (400, 'whole number')", s == 400 and "whole number" in b.get("error", ""), (s, b))
        for q, label in (("0", "zero"), ("-5", "negative"), ("abc", "text")):
            s, b = stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": q})
            check(f"a {label} quantity is refused (400)", s == 400, (s, b))
        for _ in range(10):
            stock("a", "in", {"product_id": flour["id"], "warehouse_id": wa_main, "quantity": "0.1"})
        check("measurable units take decimals: ten times 0.1 kg is exactly 1.0000", balance(wa_main, flour["id"]) == "1.0000", balance(wa_main, flour["id"]))
        check("stock is stored as NUMERIC(18,4)", psql("impex_inventory", "SELECT data_type || numeric_precision || ',' || numeric_scale FROM information_schema.columns WHERE table_name = 'stock_balances' AND column_name = 'quantity'") == "numeric18,4")

        print("\n== 4. transfers between warehouses")
        s, b = stock("a", "transfer", {"product_id": bolt["id"], "from_warehouse_id": wa_main, "to_warehouse_id": wa_annex, "quantity": "20", "reason": "Rebalance"})
        moves = b.get("operation", {}).get("movements", [])
        check("A transfers 20 MAIN -> ANNEX (201, two movements)", s == 201 and len(moves) == 2, (s, b))
        check("MAIN 30 / ANNEX 20 and the total is still 50", balance(wa_main, bolt["id"]) == "30.0000" and balance(wa_annex, bolt["id"]) == "20.0000")
        linked = psql("impex_inventory", f"SELECT count(DISTINCT transfer_id) || '|' || count(*) FROM stock_movements WHERE operation_id = '{b.get('operation', {}).get('operation_id')}'")
        check("both halves share one transfer id and one operation", linked == "1|2", linked)
        s, b = stock("a", "transfer", {"product_id": bolt["id"], "from_warehouse_id": wa_main, "to_warehouse_id": wa_annex, "quantity": "31"})
        check("a transfer larger than the source stock is refused (409) and changes nothing", s == 409 and balance(wa_main, bolt["id"]) == "30.0000" and balance(wa_annex, bolt["id"]) == "20.0000", (s, b))
        s, b = stock("a", "transfer", {"product_id": bolt["id"], "from_warehouse_id": wa_main, "to_warehouse_id": wa_main, "quantity": "1"})
        check("a transfer to the same warehouse is refused (400)", s == 400, (s, b))

        print("\n== 5. retries and double clicks (Idempotency-Key)")
        body = {"product_id": nut["id"], "warehouse_id": wa_main, "quantity": "10", "reason": "Delivery"}
        s1, r1 = stock("a", "in", body, "live-idem-key-0001")
        s2, r2 = stock("a", "in", body, "live-idem-key-0001")
        s3, r3 = stock("a", "in", body, "live-idem-key-0001")
        check("the same request sent three times answers 201, 200, 200", (s1, s2, s3) == (201, 200, 200), (s1, s2, s3))
        check("...with the same operation, and the retries say 'replayed'", r1["operation"]["operation_id"] == r2["operation"]["operation_id"] == r3["operation"]["operation_id"] and r2["operation"]["replayed"] and not r1["operation"]["replayed"])
        check("the stock changed exactly once (10, one movement)", balance(wa_main, nut["id"]) == "10.0000" and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{nut['id']}'") == "1")
        s, b = stock("a", "in", {**body, "quantity": "11"}, "live-idem-key-0001")
        check("reusing the key for a DIFFERENT request is refused (409)", s == 409 and balance(wa_main, nut["id"]) == "10.0000", (s, b))
        s, text, _, _ = portal("a", "POST", "/api/stock/in", body)
        check("a request without an Idempotency-Key is refused (400)", s == 400, (s, text))

        print("\n== 6. ten simultaneous removals of 3 from a stock of 10")
        s, race = warehouse("a", "RACE", "StockA race depot")
        wa_race = race["warehouse"]["id"]
        stock("a", "in", {"product_id": nut["id"], "warehouse_id": wa_race, "quantity": "10"})
        outcomes = []

        def remove_three(i):
            outcomes.append(stock("a", "out", {"product_id": nut["id"], "warehouse_id": wa_race, "quantity": "3", "reason": f"parallel {i}"})[0])

        threads = [threading.Thread(target=remove_three, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(90)
        check("exactly 3 succeed (201) and 7 are refused (409)", sorted(outcomes) == [201] * 3 + [409] * 7, sorted(outcomes))
        check("the balance is 1, never negative", balance(wa_race, nut["id"]) == "1.0000", balance(wa_race, nut["id"]))
        check("the ledger holds 1 stock-in and 3 stock-outs for it", psql("impex_inventory", f"SELECT count(*) FILTER (WHERE movement_type = 'in') || '/' || count(*) FILTER (WHERE movement_type = 'out') FROM stock_movements WHERE warehouse_id = '{wa_race}'") == "1/3")

        print("\n== 7. the movement history")
        status, html, _ = page("a", "/movements")
        check("the Movements page shows type, quantities, balance, reason and who", status == 200 and all(x in html for x in ("Opening balance", "Stock in", "Stock out", "Transfer out", "Transfer in", "Supplier delivery #1", "Order 7", "Rebalance", emails["a"])), status)
        check("...and none of B's", "StockB" not in html)
        status, html, _ = page("a", "/movements", f"?product={bolt['id']}&type=in")
        check("filtering by product and type narrows the list", "Supplier delivery #1" in html and "Order 7" not in html and "Rebalance" not in html)
        status, html, _ = page("a", "/movements", f"?warehouse={wa_annex}")
        check("filtering by warehouse shows only that warehouse's movements", "Rebalance" in html and "Supplier delivery #1" not in html)
        status, html, _ = page("a", "/movements", f"?product={flour['id']}")
        check("filtering by another product works", "StockA flour" in html and "Order 7" not in html)
        status, html, _ = page("a", "/stock")
        check("the Stock page shows exact totals and per-warehouse quantities", status == 200 and "StockA steel bolt" in html and "MAIN:" in html and "ANNEX:" in html and "Transfer" in html, status)

        print("\n== 8. history can never be edited or deleted")
        err = psql_with_errors("impex_inventory", f"UPDATE stock_movements SET quantity = 999 WHERE organization_id = '{org_ids['a']}'")
        check("the database refuses to UPDATE a movement", "append-only" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"DELETE FROM stock_movements WHERE organization_id = '{org_ids['a']}'")
        check("the database refuses to DELETE a movement", "append-only" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"UPDATE stock_balances SET quantity = -1 WHERE warehouse_id = '{wa_main}'")
        check("the database refuses a negative balance", "violates check constraint" in err, err[:120])
        err = psql_with_errors("impex_inventory", f"DELETE FROM warehouses WHERE id = '{wa_main}'")
        check("the database refuses to delete a warehouse that has history", "violates foreign key" in err, err[:120])
        check("there is no API route to edit or delete a movement", call(INVENTORY, "DELETE", "/api/v1/inventory/stock/movements", headers=bearer(tokens["a"]))[0] in (404, 405)
              and call(INVENTORY, "PATCH", f"/api/v1/inventory/stock/movements/{uuid.uuid4()}", {}, bearer(tokens["a"]))[0] in (404, 405))
        check("the ledger adds up: every balance equals the sum of its movements", psql("impex_inventory", (
            "SELECT count(*) FROM stock_balances b WHERE b.organization_id = '" + org_ids["a"] + "' AND b.quantity <> coalesce((SELECT sum(CASE WHEN m.movement_type IN ('opening','in','transfer_in') "
            "THEN m.quantity ELSE -m.quantity END) FROM stock_movements m WHERE m.product_id = b.product_id AND m.warehouse_id = b.warehouse_id), 0)")) == "0")

        print("\n== 9. archived warehouses and products")
        s, text, _, _ = portal("a", "POST", f"/api/warehouses/{wa_annex}/archive")
        check("A archives ANNEX (200); its stock stays", s == 200 and jbody(text)["warehouse"]["is_active"] is False and balance(wa_annex, bolt["id"]) == "20.0000", (s, text))
        s, b = stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_annex, "quantity": "1"})
        check("stock cannot be added to an archived warehouse (409)", s == 409 and "archived" in b.get("error", ""), (s, b))
        s, b = stock("a", "transfer", {"product_id": bolt["id"], "from_warehouse_id": wa_main, "to_warehouse_id": wa_annex, "quantity": "1"})
        check("...nor transferred into it (409)", s == 409, (s, b))
        status, html, _ = page("a", "/warehouses", "?status=archived")
        check("it shows under 'Archived' with a Restore button", "StockA annex (renamed)" in html and "Restore" in html)
        check("nothing was deleted (movements kept)", psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE warehouse_id = '{wa_annex}'") == "1")
        s, text, _, _ = portal("a", "POST", f"/api/warehouses/{wa_annex}/restore")
        s2, _ = stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_annex, "quantity": "1"})
        check("after restoring, stock can be added again", s == 200 and s2 == 201)
        portal("a", "POST", f"/api/products/{nut['id']}/archive")
        s, b = stock("a", "in", {"product_id": nut["id"], "warehouse_id": wa_main, "quantity": "1"})
        check("an archived product's stock cannot be changed (409) ...", s == 409, (s, b))
        check("...but its history and balance remain", balance(wa_main, nut["id"]) == "10.0000")
        portal("a", "POST", f"/api/products/{nut['id']}/restore")

        print("\n== 10. B stores stock of their own")
        s, _ = stock("b", "in", {"product_id": b_bolt["id"], "warehouse_id": wb_main, "quantity": "7", "reason": "StockB delivery"})
        check("B adds 7 to their MAIN", s == 201 and balance(wb_main, b_bolt["id"]) == "7.0000")

        print("\n== 11. tenant isolation")
        status, html, _ = page("b", "/stock")
        check("B's Stock page shows B's stock and nothing of A's", status == 200 and "StockB steel bolt" in html and "StockA" not in html)
        status, html, _ = page("b", "/warehouses")
        check("B's Warehouses page shows only B's warehouse", "StockB main depot" in html and "StockA" not in html and "ANNEX" not in html)
        status, html, _ = page("b", "/movements")
        check("B's Movements page shows only B's history", "StockB delivery" in html and "Supplier delivery" not in html and "Order 7" not in html and "Rebalance" not in html and emails["a"] not in html)
        status, html, _ = page("b", "/movements", f"?product={bolt['id']}&warehouse={wa_main}")
        check("B filtering by A's ids finds nothing", "Supplier delivery" not in html and "Order 7" not in html and "No movements match" in html)
        status, html, _ = page("a", "/movements", f"?organization_id={org_ids['b']}&org={org_ids['b']}")
        check("an organization id in the URL changes nothing", status == 200 and "StockB" not in html and "Order 7" in html)

        before = counts(org_ids["a"])
        before_bal = psql("impex_inventory", f"SELECT string_agg(quantity::text, ',' ORDER BY id) FROM stock_balances WHERE organization_id = '{org_ids['a']}'")
        attempts = {
            "stock in to A's warehouse": stock("b", "in", {"product_id": b_bolt["id"], "warehouse_id": wa_main, "quantity": "5"})[0],
            "stock out of A's stock": stock("b", "out", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "5"})[0],
            "opening on A's warehouse": stock("b", "opening", {"product_id": b_bolt["id"], "warehouse_id": wa_race, "quantity": "5"})[0],
            "transfer A's stock away": stock("b", "transfer", {"product_id": bolt["id"], "from_warehouse_id": wa_main, "to_warehouse_id": wb_main, "quantity": "5"})[0],
            "transfer B's stock into A": stock("b", "transfer", {"product_id": b_bolt["id"], "from_warehouse_id": wb_main, "to_warehouse_id": wa_main, "quantity": "1"})[0],
            "edit A's warehouse": portal("b", "PATCH", f"/api/warehouses/{wa_main}", {"name": "HIJACKED"})[0],
            "archive A's warehouse": portal("b", "POST", f"/api/warehouses/{wa_main}/archive")[0],
            "restore A's warehouse": portal("b", "POST", f"/api/warehouses/{wa_main}/restore")[0],
            "view A's warehouse (API)": call(INVENTORY, "GET", f"/api/v1/inventory/warehouses/{wa_main}", headers=bearer(tokens["b"]))[0],
        }
        check("B's attempts on A's warehouses and stock all answer 404", set(attempts.values()) == {404}, attempts)
        check("...and not one A row changed (counts, balances, names)", counts(org_ids["a"]) == before
              and psql("impex_inventory", f"SELECT string_agg(quantity::text, ',' ORDER BY id) FROM stock_balances WHERE organization_id = '{org_ids['a']}'") == before_bal
              and psql("impex_inventory", f"SELECT count(*) FROM warehouses WHERE name = 'HIJACKED'") == "0", (before, counts(org_ids["a"])))
        foreign = call(INVENTORY, "GET", f"/api/v1/inventory/warehouses/{wa_main}", headers=bearer(tokens["b"]))
        missing = call(INVENTORY, "GET", f"/api/v1/inventory/warehouses/{uuid.uuid4()}", headers=bearer(tokens["b"]))
        check("another organization's warehouse is indistinguishable from a missing one", foreign[0] == missing[0] == 404 and foreign[1] == missing[1])
        for path, label in (("stock/in", "stock-in"), ("stock/transfer", "transfer")):
            payload = ({"product_id": b_bolt["id"], "warehouse_id": wb_main, "quantity": "1"} if path == "stock/in"
                       else {"product_id": b_bolt["id"], "from_warehouse_id": wb_main, "to_warehouse_id": wb_main, "quantity": "1"})
            status, _, _, _ = call(INVENTORY, "POST", f"/api/v1/inventory/{path}", {**payload, "organization_id": org_ids["a"]}, {**bearer(tokens["b"]), "Idempotency-Key": f"live-org-{label}-key"})
            check(f"the Inventory Service rejects an organization_id in a {label} body (422)", status == 422, status)
        status, text, _, _ = call(INVENTORY, "GET", f"/api/v1/inventory/stock/movements?limit=200", headers={**bearer(tokens["b"]), "X-Organization-Id": org_ids["a"]})
        check("a header naming A changes nothing for B's movement list", status == 200 and all(m["created_by_email"] == emails["b"] for m in jbody(text)["items"]) and jbody(text)["total"] == 1)
        s, text, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/stock/in", {"product_id": b_bolt["id"], "warehouse_id": wb_main, "quantity": "1"},
                             {**bearer(tokens["b"]), "Idempotency-Key": "live-shared-key-0001"})
        s2, _, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/stock/in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "1"},
                           {**bearer(tokens["a"]), "Idempotency-Key": "live-shared-key-0001"})
        check("the same Idempotency-Key in two organizations is independent (both 201)", s == 201 and s2 == 201, (s, s2))

        print("\n== 12. an inactive organization cannot use stock")
        before = counts(org_ids["b"])
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        s, b = stock("b", "in", {"product_id": b_bolt["id"], "warehouse_id": wb_main, "quantity": "1"})
        check("B cannot change stock while inactive (403 'not active')", s == 403 and "not active" in b.get("error", ""), (s, b))
        s, b = warehouse("b", "NEW", "should not exist")
        check("...nor create warehouses (403)", s == 403, (s, b))
        for path in ("/warehouses", "/stock", "/movements"):
            status, html, _ = page("b", path)
            check(f"B's {path} page explains it without showing any data", status == 200 and "currently inactive or unavailable" in html and "StockB" not in html, status)
        check("A is unaffected", page("a", "/stock")[0] == 200 and stock("a", "in", {"product_id": nut["id"], "warehouse_id": wa_main, "quantity": "1"})[0] == 201)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("reactivating B restores everything, data intact", counts(org_ids["b"]) == before and "StockB steel bolt" in page("b", "/stock")[1])

        print("\n== 13. accounts and roles")
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("a disabled administrator is locked out of the stock routes (401)", stock("a", "in", {"product_id": bolt["id"], "warehouse_id": wa_main, "quantity": "1"})[0] == 401)
        status, _, location = page("a", "/stock")
        check("...and their Stock page redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling restores access", page("a", "/stock")[0] == 200)
        for path in ("warehouses", "stock", "stock/movements"):
            check(f"a Super Admin gets 403 from /{path}", call(INVENTORY, "GET", f"/api/v1/inventory/{path}", headers=bearer(sa_token))[0] == 403)
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        for path in ("/warehouses", "/stock", "/movements"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path, cookies={"impex_tenant_session": super_cookie})
            check(f"a Super Admin session planted in the tenant cookie cannot open {path}", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, _ = call(TENANT_PORTAL, "POST", "/api/stock/in", {}, {"Idempotency-Key": "live-no-session-0001"}, cookies={"impex_session": super_cookie})
        check("the Super Admin portal's cookie does not authorize the stock routes (401)", status == 401, status)
        for path in ("warehouses", "stock", "stock/movements"):
            check(f"no token -> 401 from /{path}; garbage token -> 401",
                  call(INVENTORY, "GET", f"/api/v1/inventory/{path}")[0] == 401 and call(INVENTORY, "GET", f"/api/v1/inventory/{path}", headers=bearer("nonsense"))[0] == 401)
        for path in ("/warehouses", "/stock", "/movements"):
            status, _, _, location = call(TENANT_PORTAL, "GET", path)
            check(f"{path} without a session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
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
