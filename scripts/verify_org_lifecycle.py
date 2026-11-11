#!/usr/bin/env python3
"""End-to-end check of LOCKING and DELETING an organization (docs/organization-lock-and-delete.md) against the RUNNING stack.

    docker compose up -d                      # the stack must be running (Organization Service at migration 0007)
    python scripts/verify_org_lifecycle.py
    python scripts/verify_org_lifecycle.py --skip-outage     # do not stop the Sales service to prove a failed deletion can be repeated

It creates two throwaway organizations ("Lifecycle Check A" and "... B"), their administrators and real records in Inventory, Purchasing, Sales, Finance and Support, then:
  LOCK    the Super Admin locks A: A's administrator can still sign in, the Organization Service reports no usable module, every module route of Inventory, Purchasing,
          Sales and Finance refuses (403 module_disabled), while Settings and Help & Support still work; unlocking restores exactly the modules A had; B is never affected.
  DELETE  a wrong name is refused and changes nothing; the right name deletes A: every table of every service has no row of A left, A's accounts, its logo and the organization
          itself are gone, only the append-only record remains, and B's data is exactly as it was. (Unless --skip-outage: with the Sales service stopped the deletion stops
          with A locked and marked, nothing is undone, and running it again once Sales is back finishes it.)
Organization B and the throwaway Super Admin are removed at the end (B with the same delete feature, the Super Admin by exact id).
"""
import argparse
import http.client
import json
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, INVENTORY, SALES, PURCHASING, SUPPORT, FINANCE = 8000, 8001, 8002, 8003, 8004, 8005, 8006
DATABASES = {"impex_finance": "finance", "impex_sales": "sales", "impex_purchasing": "purchasing", "impex_inventory": "inventory", "impex_support": "support"}
DOCKER = shutil.which("docker") or "docker"
results = []


def docker(*args):
    return subprocess.run([DOCKER, *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def psql(db, sql):
    return docker("exec", "impex-postgres", "sh", "-c", f'psql -U $POSTGRES_USER -d {db} -tAc "{sql}"')


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def call(port, method, path, body=None, headers=None, timeout=300):
    conn = http.client.HTTPConnection("localhost", port, timeout=timeout)
    conn.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", **(headers or {})})
    res = conn.getresponse()
    data = res.read()
    conn.close()
    try:
        return res.status, json.loads(data)
    except ValueError:
        return res.status, {}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def rows_of(org_id):
    """{database.table: rows owned by the organization}, over every table that holds organization data (plus Support's tables that belong to it through a ticket)."""
    counts = {}
    for db in DATABASES:
        tables = psql(db, "SELECT table_name FROM information_schema.columns WHERE column_name = 'organization_id' AND table_schema = 'public'").split()
        for table in tables:
            counts[f"{db}.{table}"] = int(psql(db, f"SELECT count(*) FROM {table} WHERE organization_id = '{org_id}'") or 0)
    ticket = f"ticket_id IN (SELECT id FROM support_tickets WHERE organization_id = '{org_id}')"
    for table in ("support_messages", "support_ticket_events", "support_email_outbox", "support_requests"):
        counts[f"impex_support.{table}"] = int(psql("impex_support", f"SELECT count(*) FROM {table} WHERE {ticket}") or 0)
    counts["impex_auth.users"] = int(psql("impex_auth", f"SELECT count(*) FROM users WHERE organization_id = '{org_id}'") or 0)
    counts["impex_organizations.organizations"] = int(psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id = '{org_id}'") or 0)
    return counts


def total(counts):
    return sum(counts.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-outage", action="store_true")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    internal = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
    sa_email = f"lifecycle-sa-{uuid.uuid4().hex[:8]}@example.org"
    sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                   "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                   "with SessionLocal() as db:\n u = User(full_name='Lifecycle Check Root', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
    assert re.match(r"^[0-9a-f-]{36}$", sa_id), sa_id
    status, body = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
    sa = bearer(body["access_token"])

    def make_org(letter):
        slug = f"lifecycle-check-{letter.lower()}-{uuid.uuid4().hex[:6]}"
        status, org = call(ORG, "POST", "/api/v1/organizations", {"name": f"Lifecycle Check {letter}", "slug": slug, "country_code": "DE", "contact_email": f"ops-{slug}@example.org"}, sa)
        assert status == 201, org
        email = f"admin-{slug}@example.org"
        status, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org["id"], "full_name": f"Admin {letter}", "email": email, "password": password}, {"X-Internal-Key": internal})
        assert status in (200, 201), status
        mark_setup_complete(psql, org["id"])
        status, state = call(ORG, "GET", f"/api/v1/organizations/{org['id']}/modules", None, sa)
        status, _ = call(ORG, "PUT", f"/api/v1/organizations/{org['id']}/modules", {"changes": {"finance": True}, "expected_revision": state["revision"]}, sa)
        assert status == 200
        return org, email

    def sign_in(email):
        status, body = call(AUTH, "POST", "/api/v1/auth/login", {"email": email, "password": password})
        return bearer(body["access_token"]) if status == 200 else None

    def seed(token, letter):
        key = lambda: {"Idempotency-Key": f"seed-{uuid.uuid4()}"}  # noqa: E731
        status, product = call(INVENTORY, "POST", "/api/v1/inventory/products", {"sku": f"LC-{letter}-1", "name": f"Check item {letter}", "unit": "pcs", "cost_price": "1.00", "selling_price": "2.00", "currency_code": "USD"}, token)
        assert status == 201, product
        assert call(INVENTORY, "POST", "/api/v1/inventory/stock/in", {"product_id": product["id"], "quantity": "10"}, {**token, **key()})[0] == 201
        status, supplier = call(PURCHASING, "POST", "/api/v1/purchasing/suppliers", {"name": f"Supplier {letter}"}, token)
        assert status == 201, supplier
        status, order = call(PURCHASING, "POST", "/api/v1/purchasing/purchase-orders", {"supplier_id": supplier["id"], "currency_code": "USD"}, {**token, **key()})
        assert status == 201, order
        assert call(PURCHASING, "POST", f"/api/v1/purchasing/purchase-orders/{order['id']}/lines", {"product_id": product["id"], "quantity": "5", "unit_price": "1.50"}, token)[0] == 201
        assert call(PURCHASING, "POST", f"/api/v1/purchasing/purchase-orders/{order['id']}/order", None, token)[0] == 200
        status, client = call(SALES, "POST", "/api/v1/sales/clients", {"name": f"Client {letter}"}, token)
        assert status == 201, client
        assert call(SALES, "POST", "/api/v1/sales/delivery-lists", {"client_id": client["id"]}, token)[0] == 201
        assert call(SUPPORT, "POST", "/api/v1/support/tickets", {"subject": f"Help {letter}", "message": "Hello, please help with this. " * 2, "category": "technical_issue", "priority": "normal"}, {**token, **key()})[0] == 201
        status, accounts = call(FINANCE, "GET", "/api/v1/finance/accounts", None, token)
        account = next(a for a in accounts if a["code"] == "5000")
        status, expense = call(FINANCE, "POST", "/api/v1/finance/expenses", {"expense_date": "2026-11-05", "description": "Printer paper", "account_id": account["id"], "amount": "25.50", "post": True}, {**token, **key()})
        assert status == 201, expense

    # ------------------------------------------------------------------------------------------------ setup
    org_a, email_a = make_org("A")
    org_b, email_b = make_org("B")
    token_a, token_b = sign_in(email_a), sign_in(email_b)
    seed(token_a, "A")
    seed(token_b, "B")
    before_a, before_b = rows_of(org_a["id"]), rows_of(org_b["id"])
    check("organization A has data in every service", all(before_a[f"{db}.{t}"] > 0 for db, t in (("impex_inventory", "stock_movements"), ("impex_purchasing", "purchase_orders"), ("impex_sales", "clients"), ("impex_support", "support_tickets"), ("impex_finance", "journal_entries"))))

    # ------------------------------------------------------------------------------------------------ LOCK
    print("LOCK")
    status, tenant = call(ORG, "GET", "/api/v1/tenant/organization", None, token_a)
    modules_before = tenant["modules"]
    check("before the lock A has its modules", {"inventory", "purchasing", "sales", "finance"} <= set(modules_before), modules_before)
    status, locked = call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/lock", {"reason": "verification: payment overdue"}, sa)
    check("the Super Admin locks A", status == 200 and locked["is_locked"] is True and locked["lock_reason"].startswith("verification"), locked)
    check("an administrator of A cannot lock or unlock it", call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/lock", {}, token_a)[0] == 403 and call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/unlock", None, token_a)[0] == 403)
    check("A's administrator can still sign in", sign_in(email_a) is not None)
    status, tenant = call(ORG, "GET", "/api/v1/tenant/organization", None, token_a)
    check("the tenant answer: locked, no usable module, the Super Admin's note is not sent", status == 200 and tenant["is_locked"] is True and tenant["modules"] == [] and "verification" not in json.dumps(tenant), tenant)
    refused = {
        "inventory": call(INVENTORY, "GET", "/api/v1/inventory/products", None, token_a),
        "purchasing": call(PURCHASING, "GET", "/api/v1/purchasing/suppliers", None, token_a),
        "sales": call(SALES, "GET", "/api/v1/sales/clients", None, token_a),
        "finance": call(FINANCE, "GET", "/api/v1/finance/accounts", None, token_a),
    }
    for name, (status, body) in refused.items():
        check(f"the {name} service refuses a locked organization (403 module_disabled)", status == 403, (status, body))
    check("Help & Support still works while locked", call(SUPPORT, "GET", "/api/v1/support/tickets", None, token_a)[0] == 200)
    status, ticket = call(SUPPORT, "POST", "/api/v1/support/tickets", {"subject": "We paid, please unlock", "message": "The payment was made today. Please restore our access.", "category": "billing_subscription", "priority": "high"}, {**token_a, "Idempotency-Key": f"seed-{uuid.uuid4()}"})
    check("...and a locked organization can open a ticket", status == 201, (status, ticket))
    check("Settings still works while locked", call(ORG, "GET", "/api/v1/tenant/settings", None, token_a)[0] == 200)
    check("organization B is not affected by A's lock", call(INVENTORY, "GET", "/api/v1/inventory/products", None, token_b)[0] == 200)
    now = rows_of(org_a["id"])
    stable = lambda counts: {k: v for k, v in counts.items() if k.split(".")[0] in ("impex_inventory", "impex_purchasing", "impex_sales")}  # noqa: E731  (Finance and Support keep working in the background)
    check("A's business data is untouched by the lock", stable(now) == stable(before_a), {k: (before_a.get(k), v) for k, v in stable(now).items() if before_a.get(k) != v})
    status, unlocked = call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/unlock", None, sa)
    check("the Super Admin unlocks A", status == 200 and unlocked["is_locked"] is False, unlocked)
    status, tenant = call(ORG, "GET", "/api/v1/tenant/organization", None, token_a)
    check("unlocking restores exactly the modules A had", tenant["modules"] == modules_before and tenant["is_locked"] is False, tenant["modules"])
    check("and the modules work again", call(INVENTORY, "GET", "/api/v1/inventory/products", None, token_a)[0] == 200 and call(FINANCE, "GET", "/api/v1/finance/accounts", None, token_a)[0] == 200)

    # ------------------------------------------------------------------------------------------------ DELETE
    print("DELETE")
    before_a = rows_of(org_a["id"])
    status, body = call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/delete", {"confirm_name": "lifecycle check a"}, sa)
    check("a wrong name is refused and nothing changes", status == 422 and rows_of(org_a["id"]) == before_a and call(INVENTORY, "GET", "/api/v1/inventory/products", None, token_a)[0] == 200, (status, body))
    check("an administrator cannot delete their own organization", call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/delete", {"confirm_name": "Lifecycle Check A"}, token_a)[0] == 403)
    if not args.skip_outage:
        print("  (stopping the Sales service to prove a failed deletion stops safely)")
        docker("compose", "stop", "sales-service")
        try:
            status, body = call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/delete", {"confirm_name": "Lifecycle Check A"}, sa)
        finally:
            docker("compose", "start", "sales-service")
        detail = body.get("detail", {}) if isinstance(body, dict) else {}
        check("with the Sales service down the deletion stops (502, names the service)", status == 502 and detail.get("service") == "sales" and detail.get("code") == "deletion_failed", (status, body))
        status, listed = call(ORG, "GET", f"/api/v1/organizations/{org_a['id']}", None, sa)
        check("A is still there, locked and marked 'being deleted'", status == 200 and listed["is_locked"] is True and listed["deletion_pending"] is True, listed)
        check("A's administrators still cannot use any module", call(ORG, "GET", "/api/v1/tenant/organization", None, token_a)[1].get("modules") == [])
        check("it cannot be unlocked while the deletion is pending", call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/unlock", None, sa)[0] == 409)
        for _ in range(90):  # wait for the Sales service to be ready again
            try:
                if call(SALES, "GET", "/health", None, None, timeout=5)[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(1)
    status, body = call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/delete", {"confirm_name": "Lifecycle Check A"}, sa)
    check("the right name deletes the organization", status == 200 and body.get("deleted") is True and set(body["purged"]) == {"finance", "sales", "purchasing", "inventory", "support", "auth"}, (status, body))
    after_a = rows_of(org_a["id"])
    check("not one row of A is left in any table of any service", total(after_a) == 0, {k: v for k, v in after_a.items() if v})
    check("A's administrator can no longer sign in, and the old token is dead", sign_in(email_a) is None and call(ORG, "GET", "/api/v1/tenant/organization", None, token_a)[0] == 401)
    check("A is gone from the Super Admin's list", all(o["id"] != org_a["id"] for o in call(ORG, "GET", "/api/v1/organizations", None, sa)[1]))
    check("only the append-only record remains (no business data)", psql("impex_organizations", f"SELECT string_agg(action, ',' ORDER BY seq) FROM organization_lifecycle_events WHERE organization_id = '{org_a['id']}'").endswith("deleted"))
    check("organization B's data is exactly as it was", rows_of(org_b["id"]) == before_b and call(INVENTORY, "GET", "/api/v1/inventory/products", None, token_b)[0] == 200)
    check("deleting it a second time is a clean 404", call(ORG, "POST", f"/api/v1/organizations/{org_a['id']}/delete", {"confirm_name": "Lifecycle Check A"}, sa)[0] == 404)

    # ------------------------------------------------------------------------------------------------ clean up
    status, body = call(ORG, "POST", f"/api/v1/organizations/{org_b['id']}/delete", {"confirm_name": "Lifecycle Check B"}, sa)
    check("cleanup: B deleted with the same feature", status == 200 and total(rows_of(org_b["id"])) == 0)
    psql("impex_organizations", f"BEGIN; SET LOCAL app.allow_ledger_maintenance = 'on'; DELETE FROM organization_lifecycle_events WHERE organization_id IN ('{org_a['id']}', '{org_b['id']}'); COMMIT;")
    psql("impex_auth", f"DELETE FROM users WHERE id = '{sa_id}'")
    print()
    print(f"{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
