#!/usr/bin/env python3
"""End-to-end check of Sales Orders, stock reservations, automatic delivery lists and Delivered History against the RUNNING stack.

    docker compose up -d       # stack must be running; impex_inventory at 0008 and impex_sales at 0005 (alembic upgrade head)
    python scripts/verify_sales_orders.py
    python scripts/verify_sales_orders.py --with-outage    # also stops the Inventory Service briefly

It creates two throwaway organizations ("Order Check Alpha / Beta") with one administrator each, signs both in to the Organization Portal and
works through the portal's own server routes exactly as the browser does. Every number it asserts is read from the DATABASES themselves:
  * the 500 / 400 / 100 story: saving an order reserves (physical stock unchanged), a second order can take only what is available, an over-ask
    is refused with the reason, and the last units can go to exactly one of several simultaneous orders;
  * all-or-nothing multi-product bookings; saving twice (same Idempotency-Key) makes one order and one booking;
  * editing: reducing releases the difference, increasing books only the difference or is refused whole, stale edits are refused;
  * nothing can take booked stock: a manual stock-out and a plain dispatch are refused, the Inventory API refuses reservation writes without the
    shared secret, and the database itself refuses reserved > on hand;
  * a confirmed dispatch deducts physical stock AND consumes the reservation in one step (500/400 -> 250/150 -> 100/0); retries never deduct twice;
    over-dispatch is refused; invoices are not created by orders;
  * cancelling releases and is idempotent; a partly delivered order keeps its history and its remainder can be cancelled;
  * Delivered History: a delivered order is listed for 24 hours from its completion time (the completion time is moved back in the database to
    prove the cutoff) and then disappears from the operational views while its dispatch, ledger and reservations remain;
  * older lists (made before reservations) are marked unbooked, never eat booked stock, and can be booked; marking a scanned draft Ready books it;
  * the other organization sees and changes nothing, and a module that is switched off refuses the order routes;
  * the stock balance's reserved column always equals the sum of the active reservations, and no order is left half-way.
Everything it created is deleted afterwards, by exact id. No emails are sent and no existing record is touched.
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

AUTH, ORG, INVENTORY, SALES, TENANT_PORTAL = 8000, 8001, 8002, 8003, 3001
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


def wait_until(port, path, timeout=90):
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
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory Service briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "socheck-sa@example.org"
    emails = {"a": "socheck-admin-a@example.org", "b": "socheck-admin-b@example.org"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()

    def portal(key, method, path, body=None, headers=None):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[key]})

    def product(key, sku, name, unit="pcs"):
        _, text, _ = portal(key, "POST", "/api/products", {"sku": sku, "name": name, "category": "SO check", "unit": unit, "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"})
        body = jbody(text).get("product", {})
        created.add("products", body.get("id"))
        return body

    def stock_in(key, pid, quantity):
        return portal(key, "POST", "/api/stock/in", {"product_id": pid, "quantity": quantity}, {"Idempotency-Key": f"so-{uuid.uuid4()}"})[0]

    def new_client(key, name):
        _, text, _ = portal(key, "POST", "/api/sales/clients", {"name": name})
        body = jbody(text).get("client", {})
        created.add("clients", body.get("id"))
        return body

    def make_order(key, client_id, lines, idem=None):
        status, text, _ = portal(key, "POST", "/api/sales/orders", {"clientId": client_id, "lines": [{"productId": p, "quantity": q} for p, q in lines]}, {"Idempotency-Key": idem or f"so-{uuid.uuid4()}"})
        body = jbody(text)
        order = body.get("order") or {}
        created.add("orders", order.get("id"))
        created.add("lists", (order.get("delivery_list") or {}).get("id"))
        return status, body

    def order_detail(key, order_id):
        return jbody(portal(key, "GET", f"/api/sales/orders/{order_id}")[1]).get("order", {})

    def edit_order(key, order, lines):
        status, text, _ = portal(key, "PATCH", f"/api/sales/orders/{order['id']}", {"version": order["version"], "lines": [{"productId": p, "quantity": q} for p, q in lines]})
        return status, jbody(text)

    def order_action(key, order_id, action):
        status, text, _ = portal(key, "POST", f"/api/sales/orders/{order_id}/{action}")
        return status, jbody(text)

    def orders_view(key, view="active"):
        return jbody(portal(key, "GET", f"/api/sales/orders?view={view}")[1]).get("items", [])

    def list_detail(key, list_id):
        return jbody(portal(key, "GET", f"/api/sales/delivery-lists/{list_id}")[1]).get("list", {})

    def figures(product_id):
        row = psql("impex_inventory", f"SELECT quantity || '|' || reserved_quantity FROM stock_balances WHERE product_id = '{product_id}'") or "0|0"
        on_hand, reserved = (Decimal(x) for x in row.split("|"))
        return on_hand, reserved, on_hand - reserved

    def movements(product_id):
        return int(psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE product_id = '{product_id}'") or "0")

    def dispatch_lines(key, delivery_list, product_id, quantity):
        item = next(i for i in delivery_list["items"] if i["product_id"] == product_id)
        return [{"deliveryListItemId": item["id"], "quantity": quantity}]

    def dispatch(key, list_id, lines):
        status, text, _ = portal(key, "POST", "/api/sales/dispatches", {"deliveryListId": list_id, "lines": lines}, {"Idempotency-Key": f"so-{uuid.uuid4()}"})
        body = jbody(text)
        created.add("dispatches", (body.get("dispatch") or {}).get("id"))
        return status, body.get("dispatch") or {}

    def confirm(key, dispatch_id):
        status, text, _ = portal(key, "POST", f"/api/sales/dispatches/{dispatch_id}/confirm")
        return status, jbody(text)

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='SOcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key, name in (("a", "Order Check Alpha"), ("b", "Order Check Beta")):
            status, text, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"socheck-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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

        water, flour, bolt, cup = product("a", "SO-WATER", "SO water bottle"), product("a", "SO-FLOUR", "SO flour", "kg"), product("a", "SO-BOLT", "SO bolt"), product("a", "SO-CUP", "SO cup")
        b_item = product("b", "SO-WATER", "SO beta item")
        stock_in("a", water["id"], "500")
        stock_in("a", flour["id"], "20")
        stock_in("a", bolt["id"], "100")
        stock_in("a", cup["id"], "60")
        stock_in("b", b_item["id"], "50")
        acme, buyer, other, beta_client = new_client("a", "SO Acme Ltd"), new_client("a", "SO Buyer Two"), new_client("a", "SO Buyer Three"), new_client("b", "SO Beta Client")
        check("products and clients created (the same SKU in both organizations)", all(x.get("id") for x in (water, flour, bolt, cup, b_item, acme, buyer, other, beta_client)))

        print("\n== 1. saving an order reserves stock, generates SO + DL numbers, and leaves physical stock alone")
        invoices_before = psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids['a']}'")
        movements_before = movements(water["id"])
        s, body = make_order("a", acme["id"], [(water["id"], "400")], idem="so-live-key-0001")
        order_a = body.get("order", {})
        check("order saved (201): SO-000001, Active, stock reserved, linked list DL-000001 is Ready at once",
              s == 201 and order_a.get("number") == "SO-000001" and order_a.get("status") == "active" and order_a.get("reservation_status") == "reserved"
              and order_a.get("delivery_list", {}).get("number") == "DL-000001" and order_a["delivery_list"]["status"] == "ready" and order_a.get("version") == 1, (s, body))
        on_hand, reserved, available = figures(water["id"])
        check("PHYSICAL stock is unchanged (500), reserved is 400, available is 100 - read from the Inventory database", (on_hand, reserved, available) == (500, 400, 100), (on_hand, reserved, available))
        check("no stock movement was written, and no invoice was created", movements(water["id"]) == movements_before and psql("impex_sales", f"SELECT count(*) FROM invoices WHERE organization_id = '{org_ids['a']}'") == invoices_before)
        check("the Inventory Service holds ONE reservation for the order line", psql("impex_inventory", f"SELECT count(*) || ':' || sum(remaining_quantity) FROM stock_reservations WHERE source_id = '{order_a['id']}'") == "1:400.0000")
        lst = list_detail("a", order_a["delivery_list"]["id"])
        check("the delivery list is linked to the order, Ready, booked, with the same line", lst.get("status") == "ready" and lst.get("booking_state") == "booked" and lst.get("order_number") == "SO-000001" and [i["quantity"] for i in lst["items"]] == ["400.0000"], lst)
        check("the order shows live physical / reserved / available stock", (lambda st: (Decimal(st["total_quantity"]), Decimal(st["reserved_quantity"]), Decimal(st["available_quantity"])) == (500, 400, 100))(order_detail("a", order_a["id"])["lines"][0]["stock"]))
        s2, again = make_order("a", acme["id"], [(water["id"], "400")], idem="so-live-key-0001")
        check("saving the SAME request twice answers 200 with the same order and books nothing twice", s2 == 200 and again["order"]["id"] == order_a["id"] and again.get("replayed") is True and figures(water["id"])[1] == 400, (s2, again))
        s3, _ = make_order("a", acme["id"], [(water["id"], "300")], idem="so-live-key-0001")
        check("the same key for a different order is refused (409)", s3 == 409, s3)
        s, body = make_order("a", acme["id"], [(water["id"], "5"), (water["id"], "6")])
        check("a product twice in one order is refused (400) and nothing is created", s == 400 and "only once" in json.dumps(body), (s, body))

        print("\n== 2. the second order can take only what is available")
        s, body = make_order("a", buyer["id"], [(water["id"], "150")])
        check("150 requested with 100 available: refused (409) with the reason and the numbers",
              s == 409 and "Only 100" in body.get("error", "") and "400" in body.get("error", "") and "reserved for other orders" in body.get("error", ""), (s, body))
        check("...and the refusal changed nothing", figures(water["id"]) == (500, 400, 100) and len(orders_view("a")) == 1)
        s, body = make_order("a", buyer["id"], [(water["id"], "100")])
        order_b = body.get("order", {})
        check("exactly 100 is accepted: physical 500, reserved 500, available 0", s == 201 and figures(water["id"]) == (500, 500, 0), (s, figures(water["id"])))
        s, _ = make_order("a", other["id"], [(water["id"], "1")])
        check("a third order cannot book even one unit", s == 409, s)

        print("\n== 3. simultaneous orders cannot double-book; multi-product orders are all or nothing")
        outcomes = []

        def race(i):
            outcomes.append(make_order("a", other["id"], [(bolt["id"], "40")])[0])

        threads = [threading.Thread(target=race, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        check("6 simultaneous orders for 40 of 100 bolts: exactly 2 succeed, 4 are refused", sorted(outcomes) == [201, 201, 409, 409, 409, 409], outcomes)
        check("...and 80 bolts are reserved (never more than were there)", figures(bolt["id"]) == (100, 80, 20), figures(bolt["id"]))
        s, body = make_order("a", acme["id"], [(cup["id"], "10"), (bolt["id"], "30")])
        check("an order whose second product is short is refused as a whole: the cups were NOT booked either", s == 409 and figures(cup["id"])[1] == 0 and figures(bolt["id"])[1] == 80, (s, figures(cup["id"]), figures(bolt["id"])))

        print("\n== 4. editing an order")
        order_c = make_order("a", acme["id"], [(cup["id"], "40"), (flour["id"], "4")])[1]["order"]
        s, edited = edit_order("a", order_c, [(cup["id"], "25"), (flour["id"], "4")])
        check("reducing 40 -> 25 cups releases 15 (reserved 25), the order is version 2 and its list follows",
              s == 200 and figures(cup["id"])[1] == 25 and edited["order"]["version"] == 2 and [i["quantity"] for i in list_detail("a", order_c["delivery_list"]["id"])["items"] if i["product_sku"] == "SO-CUP"] == ["25.0000"], (s, edited))
        s, edited2 = edit_order("a", edited["order"], [(cup["id"], "35"), (flour["id"], "4")])
        check("increasing 25 -> 35 books only the 10 extra", s == 200 and figures(cup["id"])[1] == 35, (s, figures(cup["id"])))
        s, refused = edit_order("a", edited2["order"], [(cup["id"], "70"), (flour["id"], "4")])
        check("increasing beyond what is available is refused whole, with the message", s == 409 and "Cannot increase" in refused.get("error", "") and figures(cup["id"])[1] == 35, (s, refused))
        s, stale = edit_order("a", edited["order"], [(cup["id"], "30"), (flour["id"], "4")])
        check("an edit made on an out-of-date copy is refused (409)", s == 409 and "changed by someone else" in stale.get("error", ""), (s, stale))
        s, edited3 = edit_order("a", edited2["order"], [(cup["id"], "35"), (flour["id"], "6"), (bolt["id"], "5")])
        check("a product can be added (and later removed) and the reservation follows", s == 200 and figures(bolt["id"])[1] == 85 and figures(flour["id"])[1] == 6, (s, figures(bolt["id"]), figures(flour["id"])))
        s, edited4 = edit_order("a", edited3["order"], [(cup["id"], "35"), (flour["id"], "6")])
        check("...removing it releases it", s == 200 and figures(bolt["id"])[1] == 80, (s, figures(bolt["id"])))

        print("\n== 5. nothing can take stock that an order has booked")
        s, text, _ = portal("a", "POST", "/api/stock/out", {"product_id": water["id"], "quantity": "1"}, {"Idempotency-Key": f"so-{uuid.uuid4()}"})
        check("a manual stock-out of a fully booked product is refused (409) with the reason", s == 409 and "reserved" in text, (s, text[:160]))
        s, text, _ = portal("a", "POST", "/api/stock/out", {"product_id": bolt["id"], "quantity": "30"}, {"Idempotency-Key": f"so-{uuid.uuid4()}"})
        check("a stock-out of more than is AVAILABLE (20 of 100 bolts) is refused", s == 409, (s, text[:160]))
        s, text, _ = portal("a", "POST", "/api/stock/out", {"product_id": bolt["id"], "quantity": "20"}, {"Idempotency-Key": f"so-{uuid.uuid4()}"})
        check("...while taking exactly the available 20 works", s == 201 and figures(bolt["id"]) == (80, 80, 0), (s, figures(bolt["id"])))
        status, text, _ = call(INVENTORY, "POST", "/api/v1/inventory/reservations", {"source_id": str(uuid.uuid4()), "source_reference": "SO-999999", "lines": [{"line_id": str(uuid.uuid4()), "product_id": cup["id"], "quantity": "1", "unit": "pcs"}]},
                               {**bearer(tokens["a"]), "Idempotency-Key": f"so-{uuid.uuid4()}"})
        check("the Inventory API refuses reservation writes without the Sales Service's shared secret (403)", status == 403, (status, text[:120]))
        status, text, _ = call(INVENTORY, "POST", "/api/v1/inventory/dispatches", {"dispatch_number": "DS-999999", "lines": [{"line_id": str(uuid.uuid4()), "product_id": water["id"], "quantity": "1", "unit": "pcs", "order_line_id": str(uuid.uuid4())}]},
                               {**bearer(tokens["a"]), "Idempotency-Key": f"so-{uuid.uuid4()}"})
        check("...nor a dispatch that names an order line (403)", status == 403, (status, text[:120]))
        raw = psql_with_errors("impex_inventory", f"UPDATE stock_balances SET reserved_quantity = quantity + 1 WHERE product_id = '{cup['id']}'")
        check("the database itself refuses reserved > on hand", "violates check constraint" in raw and "reserved_within_stock" in raw, raw[:160])

        print("\n== 6. dispatching consumes the reservation: 500 / 400 / 100 -> 250 / 150 / 100 -> 100 / 0 / 100")
        dl_a = list_detail("a", order_a["delivery_list"]["id"])
        s, d1 = dispatch("a", dl_a["id"], dispatch_lines("a", dl_a, water["id"], "250"))
        check("a prepared dispatch changes nothing: stock 500 / 500 reserved (booked for orders A and B)", s == 201 and d1.get("status") == "draft" and figures(water["id"]) == (500, 500, 0), (s, figures(water["id"])))
        s, confirmed = confirm("a", d1["id"])
        check("confirming deducts 250 and consumes 250 of order A's reservation in one step: physical 250, reserved 250 (150 for A + 100 for B)",
              s == 200 and confirmed["dispatch"]["status"] == "confirmed" and figures(water["id"]) == (250, 250, 0), (s, figures(water["id"])))
        s, again = confirm("a", d1["id"])
        check("confirming again changes nothing (no second deduction, no second consumption)", s == 200 and figures(water["id"]) == (250, 250, 0) and movements(water["id"]) == movements_before + 1, (s, figures(water["id"])))
        mid = order_detail("a", order_a["id"])
        check("the order is partly delivered: still ACTIVE, line shows 250 dispatched / 150 remaining, not in Delivered History",
              mid.get("status") == "active" and mid["delivery_list"]["status"] == "partially_dispatched" and mid["lines"][0]["dispatched_quantity"] == "250.0000" and mid["lines"][0]["remaining_quantity"] == "150.0000"
              and [o["number"] for o in orders_view("a")].count("SO-000001") == 1 and orders_view("a", "delivered") == [], mid)
        s, body = dispatch("a", dl_a["id"], dispatch_lines("a", dl_a, water["id"], "151"))
        check("dispatching more than the order still holds is refused (409)", s == 409, (s, body))
        s, edited = edit_order("a", mid, [(water["id"], "200")])
        check("a line cannot be reduced below what was dispatched (409) - confirmed history is never rewritten", s == 409, (s, edited))
        s, cancel_refused = order_action("a", order_a["id"], "cancel")
        check("an order with goods dispatched cannot be cancelled (409) with an explanation", s == 409 and "already has goods dispatched" in cancel_refused.get("error", ""), (s, cancel_refused))
        s, d2 = dispatch("a", dl_a["id"], dispatch_lines("a", dl_a, water["id"], "150"))
        s, confirmed2 = confirm("a", d2["id"])
        check("the remaining 150 are confirmed: physical 100, reserved 100 (order B), available 0", s == 200 and figures(water["id"]) == (100, 100, 0), (s, figures(water["id"])))
        done = order_detail("a", order_a["id"])
        check("the order is Delivered with a completion time and its list is Dispatched",
              done.get("status") == "delivered" and done.get("reservation_status") == "consumed" and done.get("completed_at") and done["delivery_list"]["status"] == "dispatched", done)
        history = orders_view("a", "delivered")
        check("it is in Delivered History (with its expiry 24 h after completion) and no longer in the active list",
              [o["number"] for o in history] == ["SO-000001"] and history[0]["history_expires_at"] and "SO-000001" not in [o["number"] for o in orders_view("a")], history)
        reservation = psql("impex_inventory", f"SELECT status || ':' || consumed_quantity || ':' || remaining_quantity FROM stock_reservations WHERE source_id = '{order_a['id']}'")
        check("the reservation is fulfilled (400 consumed, none remaining)", reservation == "fulfilled:400.0000:0.0000", reservation)
        status, text, _ = portal("a", "GET", f"/api/sales/billable-lines?clientId={acme['id']}")
        check("the delivered goods are available to invoice (Dispatch -> Invoice -> Payment is untouched)", status == 200 and "SO-WATER" in text, (status, text[:160]))

        print("\n== 7. Delivered History lasts 24 hours from completion, then the order leaves the operational views")
        sales_id = order_a["id"]
        psql("impex_sales", f"ALTER TABLE sales_orders DISABLE TRIGGER trg_sales_orders_guard; UPDATE sales_orders SET completed_at = now() - interval '23 hours 59 minutes' WHERE id = '{sales_id}'; ALTER TABLE sales_orders ENABLE TRIGGER trg_sales_orders_guard")
        check("23 h 59 min after completion it is still listed", [o["number"] for o in orders_view("a", "delivered")] == ["SO-000001"], orders_view("a", "delivered"))
        psql("impex_sales", f"ALTER TABLE sales_orders DISABLE TRIGGER trg_sales_orders_guard; UPDATE sales_orders SET completed_at = now() - interval '24 hours 1 minute' WHERE id = '{sales_id}'; ALTER TABLE sales_orders ENABLE TRIGGER trg_sales_orders_guard")
        check("24 h 1 min after completion it has left Delivered History (same answer on every reload)", orders_view("a", "delivered") == [] and orders_view("a", "delivered") == [])
        check("...and it is in neither operational list, yet NOTHING was deleted: order, list, dispatches, ledger and reservation are all still there",
              "SO-000001" not in [o["number"] for o in orders_view("a")] and order_detail("a", sales_id).get("status") == "delivered"
              and psql("impex_sales", f"SELECT count(*) FROM dispatches WHERE delivery_list_id = '{order_a['delivery_list']['id']}' AND status = 'confirmed'") == "2"
              and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE source_type = 'client_dispatch' AND product_id = '{water['id']}'") == "2"
              and psql("impex_inventory", f"SELECT count(*) FROM stock_reservations WHERE source_id = '{sales_id}'") == "1")
        check("the database refuses to rewrite a finished order", "can never be changed" in psql_with_errors("impex_sales", f"UPDATE sales_orders SET notes = 'x' WHERE id = '{sales_id}'"))

        print("\n== 8. cancelling an order releases its stock (idempotently), keeps a record, and a partly delivered order's remainder can be cancelled")
        before = figures(water["id"])
        s, cancelled = order_action("a", order_b["id"], "cancel")
        check("order B cancelled: list cancelled, 100 released, a record kept (never deleted)", s == 200 and cancelled["order"]["status"] == "cancelled" and cancelled["order"]["cancelled_at"] and figures(water["id"]) == (100, 0, 100), (s, cancelled, figures(water["id"])))
        s, cancelled2 = order_action("a", order_b["id"], "cancel")
        check("cancelling again is harmless (200) and releases nothing twice", s == 200 and figures(water["id"]) == (100, 0, 100) and psql("impex_inventory", f"SELECT count(*) FROM stock_operations WHERE kind = 'release' AND idempotency_key = 'release-{order_b['id']}'") == "1")
        check("a cancelled order is in no operational list but still readable", "SO-000002" not in [o["number"] for o in orders_view("a") + orders_view("a", "delivered")] and order_detail("a", order_b["id"]).get("status") == "cancelled")
        order_e = make_order("a", acme["id"], [(flour["id"], "6"), (cup["id"], "5")])[1].get("order", {})
        check("(order E for flour and cups was saved)", order_e.get("status") == "active", order_e)
        dl_e = list_detail("a", order_e["delivery_list"]["id"])
        s, de = dispatch("a", dl_e["id"], dispatch_lines("a", dl_e, flour["id"], "6"))
        confirm("a", de["id"])
        s, closed = order_action("a", order_e["id"], "cancel-remaining")
        check("after a partial delivery the undelivered remainder is cancelled: order Closed, reservation released, flour stays dispatched",
              s == 200 and closed["order"]["status"] == "closed" and closed["order"]["delivery_list"]["status"] == "dispatched" and figures(cup["id"])[1] == 35 and [o["number"] for o in orders_view("a", "delivered")] == [order_e["number"]], (s, closed))

        print("\n== 9. older lists (made before reservations) and scanned drafts")
        draft = jbody(portal("a", "POST", "/api/sales/delivery-lists", {"clientId": buyer["id"]})[1]).get("list", {})
        created.add("lists", draft.get("id"))
        portal("a", "POST", f"/api/sales/delivery-lists/{draft['id']}/items", {"productId": water["id"], "quantity": "60"})
        portal("a", "POST", f"/api/sales/delivery-lists/{draft['id']}/items", {"productId": flour["id"], "quantity": "50"})
        s, text, _ = portal("a", "POST", f"/api/sales/delivery-lists/{draft['id']}/ready")
        check("a scanned draft cannot be marked Ready when the stock is not there: refused (409), nothing booked", s == 409 and list_detail("a", draft["id"])["status"] == "draft" and figures(water["id"])[1] == 0, (s, text[:200]))
        item = list_detail("a", draft["id"])["items"]
        flour_item = next(i for i in item if i["product_id"] == flour["id"])
        portal("a", "PATCH", f"/api/sales/delivery-lists/{draft['id']}/items/{flour_item['id']}", {"quantity": "2"})
        s, text, _ = portal("a", "POST", f"/api/sales/delivery-lists/{draft['id']}/ready")
        booked = list_detail("a", draft["id"])
        check("with a valid quantity, Ready BOOKS the draft atomically (it becomes a sales order)", s == 200 and booked["status"] == "ready" and booked["booking_state"] == "booked" and figures(water["id"])[1] == 60 and figures(flour["id"])[1] == 8, (s, booked.get("booking_state"), figures(water["id"]), figures(flour["id"])))
        def legacy_ready(quantity):
            made = jbody(portal("a", "POST", "/api/sales/delivery-lists", {"clientId": other["id"]})[1]).get("list", {})
            created.add("lists", made.get("id"))
            portal("a", "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": water["id"], "quantity": quantity})
            psql("impex_sales", f"UPDATE delivery_lists SET status = 'ready' WHERE id = '{made['id']}'")
            return list_detail("a", made["id"])

        big, small = legacy_ready("45"), legacy_ready("30")
        check("OLDER Ready lists (no order) are marked 'unbooked' - never treated as booked", big.get("booking_state") == "unbooked" and big.get("order_id") is None and small.get("booking_state") == "unbooked", big.get("booking_state"))
        s, d = dispatch("a", big["id"], dispatch_lines("a", big, water["id"], "45"))
        s, text_ = confirm("a", d["id"]) if d.get("id") else (0, {})
        check("an older list cannot dispatch stock that an order has booked (45 asked, 40 available): refused, nothing deducted", s == 409 and figures(water["id"]) == (100, 60, 40), (s, figures(water["id"])))
        s, text_, _ = portal("a", "POST", f"/api/sales/delivery-lists/{big['id']}/book")
        check("it cannot be booked either (45 > 40 available): refused and unchanged", s == 409 and figures(water["id"])[1] == 60 and list_detail("a", big["id"])["booking_state"] == "unbooked", (s, text_[:160]))
        s, text_, _ = portal("a", "POST", f"/api/sales/delivery-lists/{small['id']}/book")
        check("the 30-bottle older list CAN be booked ('Book stock'): 30 more reserved, and it becomes order-backed", s == 200 and figures(water["id"])[1] == 90 and list_detail("a", small["id"])["booking_state"] == "booked", (s, text_[:160]))

        print("\n== 10. isolation, modules and the Inventory Service being unavailable")
        some = orders_view("a")[0]
        check("organization B sees none of A's orders", orders_view("b") == [] and orders_view("b", "delivered") == [])
        s, _, _ = portal("b", "GET", f"/api/sales/orders/{some['id']}")
        s2, _ = edit_order("b", some, [(b_item["id"], "1")])
        s3, _ = order_action("b", some["id"], "cancel")
        check("B cannot read, edit or cancel A's order (404 each)", (s, s2, s3) == (404, 404, 404), (s, s2, s3))
        s, _ = make_order("b", acme["id"], [(b_item["id"], "1")])
        check("B cannot use A's client (404), and A's product ids are unknown to B", s == 404 and make_order("b", beta_client["id"], [(water["id"], "1")])[0] == 404)
        s, body = make_order("b", beta_client["id"], [(b_item["id"], "10")])
        check("B has its own SO-000001 and its own stock figures", s == 201 and body["order"]["number"] == "SO-000001" and figures(b_item["id"]) == (50, 10, 40), (s, figures(b_item["id"])))
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = false WHERE organization_id = '{org_ids['b']}' AND module_key = 'sales'")
        s, text, _ = portal("b", "GET", "/api/sales/orders?view=active")
        check("with the Sales module switched off the order routes refuse (403 module_disabled)", s == 403 and "module" in text.lower(), (s, text[:120]))
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = true WHERE organization_id = '{org_ids['b']}' AND module_key = 'sales'")
        if args.with_outage:
            docker("compose", "stop", "inventory-service")
            try:
                orders_before = psql("impex_sales", f"SELECT count(*) FROM sales_orders WHERE organization_id = '{org_ids['a']}'")
                s, body = make_order("a", acme["id"], [(cup["id"], "1")])
                check("with the Inventory Service down an order is refused (503) and NOTHING is created - no unverified booking", s == 503 and psql("impex_sales", f"SELECT count(*) FROM sales_orders WHERE organization_id = '{org_ids['a']}'") == orders_before, (s, body))
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            check("once it is back, orders work again", make_order("a", acme["id"], [(cup["id"], "1")])[0] == 201)
        else:
            print("(skipped: outage check - run with --with-outage)")

        print("\n== 11. one last look: the books agree")
        for org in ("a", "b"):
            drift = psql("impex_inventory", f"SELECT count(*) FROM stock_balances b WHERE b.organization_id = '{org_ids[org]}' AND b.reserved_quantity <> COALESCE((SELECT sum(remaining_quantity) FROM stock_reservations r WHERE r.organization_id = b.organization_id AND r.product_id = b.product_id AND r.status = 'active'), 0)")
            check(f"organization {org.upper()}: every product's reserved quantity equals the sum of its active reservations", drift == "0", drift)
            check(f"organization {org.upper()}: reserved never exceeds on hand, and no balance is negative", psql("impex_inventory", f"SELECT count(*) FROM stock_balances WHERE organization_id = '{org_ids[org]}' AND (reserved_quantity > quantity OR quantity < 0)") == "0")
            check(f"organization {org.upper()}: no order is left half-way", psql("impex_sales", f"SELECT count(*) FROM sales_orders WHERE organization_id = '{org_ids[org]}' AND (status = 'pending_reservation' OR pending_action IS NOT NULL)") == "0")
            mismatch = psql("impex_sales", f"SELECT count(*) FROM sales_orders o JOIN delivery_lists l ON l.id = o.delivery_list_id WHERE o.organization_id = '{org_ids[org]}' AND NOT ((o.status = 'active' AND l.status IN ('ready', 'partially_dispatched')) OR (o.status IN ('delivered', 'closed') AND l.status = 'dispatched') OR (o.status IN ('cancelled', 'failed') AND l.status = 'cancelled'))")
            check(f"organization {org.upper()}: every order agrees with its delivery list", mismatch == "0", mismatch)
        check("the goods the confirmed dispatches carry are exactly the goods deducted from stock",
              psql("impex_sales", f"SELECT coalesce(sum(dl.quantity), 0) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE d.organization_id = '{org_ids['a']}' AND d.status = 'confirmed'")
              == psql("impex_inventory", f"SELECT coalesce(sum(quantity), 0) FROM stock_movements WHERE organization_id = '{org_ids['a']}' AND source_type = 'client_dispatch'"))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        left = {
            "order requests": delete_exact(psql, "impex_sales", "sales_order_requests", orgs, "organization_id"),
            "orders": delete_exact(psql, "impex_sales", "sales_orders", orgs, "organization_id", ledger=True),
            "order counters": delete_exact(psql, "impex_sales", "sales_order_counters", orgs, "organization_id"),
            "invoice lines": delete_exact(psql, "impex_sales", "invoice_lines", orgs, "organization_id", ledger=True),
            "invoices": delete_exact(psql, "impex_sales", "invoices", orgs, "organization_id", ledger=True),
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
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", created.get("users")),
        }
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(created.get('products'))} products, {len(created.get('users'))} users")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
