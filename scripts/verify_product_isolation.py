#!/usr/bin/env python3
"""End-to-end check of the Product Catalog and its tenant isolation against the RUNNING stack.

    docker compose up -d                                   # stack must be running (and the migrations applied)
    python scripts/verify_product_isolation.py
    python scripts/verify_product_isolation.py --with-outage    # also stops the Inventory Service for a few seconds

It creates two throwaway organizations ("Isolation Products Alpha / Beta") with one administrator each, signs both
in to the Organization Portal and works through the portal's own server routes exactly as the browser does:
create / edit / search / archive / restore products, then tries every way of reaching the other organization's
catalog. Everything it created is deleted afterwards. No emails are sent and no existing record is touched.
Passwords and tokens are random, kept in memory and never printed.
"""
import argparse
import http.client
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402
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


def check(name: str, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def call(port, method, path, body=None, headers=None, cookies=None):
    conn = http.client.HTTPConnection("localhost", port, timeout=40)
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


def wait_until(port, path, timeout=60):
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
    parser.add_argument("--with-outage", action="store_true", help="also stop the Inventory Service briefly to check the 503 handling")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "isoprod-sa@example.org"
    emails = {"a": "isoprod-admin-a@example.org", "b": "isoprod-admin-b@example.org"}
    org_names = {"a": "Isolation Products Alpha", "b": "Isolation Products Beta"}
    org_ids, tokens, cookies = {}, {}, {}
    created = CreatedIds()  # exact ids of everything this run creates; cleanup deletes only these

    def portal(key, method, path, body=None):
        """A call from the signed-in administrator's browser to the Organization Portal."""
        return call(TENANT_PORTAL, method, path, body, cookies={"impex_tenant_session": cookies[key]})

    def page(key, query=""):
        status, html, _, location = portal(key, "GET", "/products" + query)
        return status, html.replace("<!-- -->", ""), location

    def create(key, **overrides):
        body = {"sku": "ISO-1", "name": "Item", "category": "General", "unit": "pcs", "costPrice": "1.00", "sellingPrice": "2.00",
                "currencyCode": "USD", **overrides}
        status, text, _, _ = portal(key, "POST", "/api/products", body)
        created.add("products", jbody(text).get("product", {}).get("id"))
        return status, jbody(text)

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='Isoprod SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": org_names[key], "slug": f"isoprod-{key}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
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
            mark_setup_complete(psql, org_ids[key])  # this script tests other features: skip the first-time wizard for its throwaway organization (verify_onboarding.py tests the wizard)

        print("\n== 1. create products through the portal (each in their own catalog)")
        made = {"a": {}, "b": {}}
        spec = {"a": [("ISO-BOLT", "IsoAlpha steel bolt", "Hardware", "7318.15"), ("ISO-NUT", "IsoAlpha steel nut", "Hardware", ""), ("SHARED-1", "IsoAlpha shared item", "Common", "")],
                "b": [("ISO-SCARF", "IsoBeta silk scarf", "Textiles", ""), ("SHARED-1", "IsoBeta shared item", "Common", "")]}
        for key in ("a", "b"):
            for sku, name, category, hs in spec[key]:
                status, body = create(key, sku=sku, name=name, category=category, hsCode=hs)
                made[key][sku] = body.get("product", {})
                check(f"{key.upper()} creates {sku} (201)", status == 201 and body.get("product", {}).get("sku") == sku, (status, body))
        check("the same SKU ('SHARED-1') can exist in both catalogs", made["a"]["SHARED-1"].get("id") != made["b"]["SHARED-1"].get("id"))
        status, body = create("a", sku="shared-1", name="duplicate")
        check("a duplicate SKU in the same catalog is rejected (409, on the SKU field)", status == 409 and "sku" in (body.get("fieldErrors") or {}), (status, body))

        print("\n== 2. prices are exact decimals end to end")
        status, body = create("a", sku="ISO-DEC", name="IsoAlpha decimal check", costPrice="0.1", sellingPrice="0.2")
        check("prices come back as exact decimal strings", status == 201 and body["product"]["cost_price"] == "0.1000" and body["product"]["selling_price"] == "0.2000", body)
        row = psql("impex_inventory", f"SELECT cost_price::text, selling_price::text, cost_price + selling_price, pg_typeof(cost_price)::text FROM products WHERE sku = 'ISO-DEC' AND organization_id = '{org_ids['a']}'")
        check("the database holds NUMERIC(14,4) and 0.1 + 0.2 = 0.3000 exactly", row == "0.1000|0.2000|0.3000|numeric", row)
        status, body = create("a", sku="ISO-BAD", costPrice="1.23456")
        check("five decimal places are rejected before reaching the database", status == 400 and "costPrice" in body.get("fieldErrors", {}), (status, body))

        print("\n== 3. the Products page shows each organization only its own catalog")
        for key, other in (("a", "b"), ("b", "a")):
            status, html, _ = page(key)
            own_names = [n for _, n, _, _ in spec[key]]
            other_names = [n for _, n, _, _ in spec[other]]
            check(f"page {key.upper()} lists all of {key.upper()}'s products", status == 200 and all(n in html for n in own_names), status)
            check(f"...and none of {other.upper()}'s", not any(n in html for n in other_names) and f"Isolation Products {'Beta' if key == 'a' else 'Alpha'}" not in html)
        status, html, _ = page("a", "?q=bolt")
        check("search finds the matching product only", "IsoAlpha steel bolt" in html and "IsoAlpha steel nut" not in html)
        status, html, _ = page("a", "?category=Hardware")
        check("category filter works", "IsoAlpha steel bolt" in html and "IsoAlpha steel nut" in html and "IsoAlpha shared item" not in html)
        status, html, _ = page("a", "?q=scarf")
        check("A cannot find B's product by searching for it", "IsoBeta silk scarf" not in html and "No products match" in html)
        status, html, _ = page("a", f"?organization_id={org_ids['b']}&org={org_ids['b']}")
        check("an organization id in the URL changes nothing", status == 200 and "IsoAlpha steel bolt" in html and "IsoBeta" not in html)

        print("\n== 4. the organization cannot be chosen by the browser")
        status, text, _, _ = portal("a", "POST", "/api/products", {"sku": "ISO-SNEAKY", "name": "IsoAlpha sneaky", "category": "General", "unit": "pcs",
                                    "costPrice": "1", "sellingPrice": "2", "currencyCode": "USD", "organization_id": org_ids["b"], "organizationId": org_ids["b"]})
        created.add("products", jbody(text).get("product", {}).get("id"))
        owner = psql("impex_inventory", f"SELECT organization_id FROM products WHERE id = '{jbody(text).get('product', {}).get('id')}'")
        check("a product 'sent for' organization B is stored under A (the signed-in administrator's organization)", status == 201 and owner == org_ids["a"], (status, owner))
        status, text, _, _ = call(INVENTORY, "POST", "/api/v1/inventory/products", {"sku": "ISO-DIRECT", "name": "x", "category": "c", "unit": "pcs",
                                  "cost_price": "1", "selling_price": "2", "currency_code": "USD", "organization_id": org_ids["b"]}, bearer(tokens["a"]))
        check("the Inventory Service itself rejects an organization_id in the body (422)", status == 422, (status, text[:100]))
        check("nothing was stored for it", psql("impex_inventory", "SELECT count(*) FROM products WHERE sku = 'ISO-DIRECT'") == "0")

        print("\n== 5. neither administrator can view or modify the other's products")
        for key, other in (("a", "b"), ("b", "a")):
            target = next(iter(made[other].values()))
            before = psql("impex_inventory", f"SELECT name || '|' || selling_price::text || '|' || is_active::text || '|' || updated_at::text FROM products WHERE id = '{target['id']}'")
            codes = {
                "edit": portal(key, "PATCH", f"/api/products/{target['id']}", {"name": "HIJACKED", "sellingPrice": "0.01"})[0],
                "archive": portal(key, "POST", f"/api/products/{target['id']}/archive")[0],
                "restore": portal(key, "POST", f"/api/products/{target['id']}/restore")[0],
                "view (direct API)": call(INVENTORY, "GET", f"/api/v1/inventory/products/{target['id']}", headers=bearer(tokens[key]))[0],
            }
            check(f"{key.upper()} trying to edit/archive/restore/view {other.upper()}'s product gets 404 every time", set(codes.values()) == {404}, codes)
            after = psql("impex_inventory", f"SELECT name || '|' || selling_price::text || '|' || is_active::text || '|' || updated_at::text FROM products WHERE id = '{target['id']}'")
            check(f"...and {other.upper()}'s product is completely unchanged", before == after and "HIJACKED" not in after, (before, after))
        foreign = call(INVENTORY, "GET", f"/api/v1/inventory/products/{made['b']['ISO-SCARF']['id']}", headers=bearer(tokens["a"]))
        missing = call(INVENTORY, "GET", "/api/v1/inventory/products/00000000-0000-4000-8000-000000000000", headers=bearer(tokens["a"]))
        check("another organization's product is indistinguishable from a missing one", foreign[0] == missing[0] == 404 and foreign[1] == missing[1])
        status, text, _, _ = call(INVENTORY, "GET", "/api/v1/inventory/products?status=all&limit=200", headers={**bearer(tokens["a"]), "X-Organization-Id": org_ids["b"]})
        check("a header naming the other organization changes nothing", all(p["sku"] != "ISO-SCARF" for p in jbody(text).get("items", [])) and status == 200)

        print("\n== 6. edit, archive and restore your own products")
        scarf = made["b"]["ISO-SCARF"]
        status, text, _, _ = portal("b", "PATCH", f"/api/products/{scarf['id']}", {"name": "IsoBeta silk scarf v2", "sellingPrice": "17.25", "description": "Updated"})
        body = jbody(text).get("product", {})
        check("B edits their product (200)", status == 200 and body.get("name") == "IsoBeta silk scarf v2" and body.get("selling_price") == "17.2500", (status, text))
        check("only the edited fields changed", body.get("cost_price") == scarf["cost_price"] and body.get("sku") == "ISO-SCARF" and body.get("category") == "Textiles")
        check("the edit moved updated_at forward", body.get("updated_at", "") > scarf["updated_at"])
        status, text, _, _ = portal("b", "PATCH", f"/api/products/{scarf['id']}", {"sku": "shared-1"})
        check("editing the SKU to one already in B's catalog is rejected (409)", status == 409, (status, text))
        status, text, _, _ = portal("b", "POST", f"/api/products/{scarf['id']}/archive")
        check("B archives it (200)", status == 200 and jbody(text)["product"]["is_active"] is False, (status, text))
        check("an archived product disappears from the default list", "IsoBeta silk scarf v2" not in page("b")[1])
        check("...but shows under 'Archived' with a Restore button", "IsoBeta silk scarf v2" in page("b", "?status=archived")[1] and "Restore" in page("b", "?status=archived")[1])
        check("nothing was deleted", psql("impex_inventory", f"SELECT count(*) FROM products WHERE id = '{scarf['id']}'") == "1")
        status, text, _, _ = portal("b", "POST", f"/api/products/{scarf['id']}/restore")
        check("B restores it (200)", status == 200 and jbody(text)["product"]["is_active"] is True, (status, text))
        check("...and it is back in the default list", "IsoBeta silk scarf v2" in page("b")[1])

        print("\n== 7. an inactive organization cannot use the catalog")
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        status, body = create("b", sku="ISO-BLOCKED")
        check("B cannot add products while inactive (403 'not active')", status == 403 and "not active" in body.get("error", ""), (status, body))
        status, html, _ = page("b")
        check("B's page explains it without listing any product", status == 200 and "currently inactive or unavailable" in html and "IsoBeta" not in html)
        check("A is unaffected", create("a", sku="ISO-A-OK")[0] == 201 and page("a")[0] == 200)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")
        check("reactivating B restores the catalog, data intact", "IsoBeta silk scarf v2" in page("b")[1])

        print("\n== 8. accounts and roles")
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("a disabled administrator is locked out at once (401 from the portal route)", create("a", sku="ISO-LOCKED")[0] == 401)
        status, _, location = page("a")
        check("...and their Products page redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling restores access", page("a")[0] == 200)
        check("a Super Admin gets 403 from the Inventory Service", call(INVENTORY, "GET", "/api/v1/inventory/products", headers=bearer(sa_token))[0] == 403)
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        status, _, _, location = call(TENANT_PORTAL, "GET", "/products", cookies={"impex_tenant_session": super_cookie})
        check("a Super Admin session planted in the tenant cookie cannot open the Products page", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, location = call(TENANT_PORTAL, "POST", "/api/products", {}, cookies={"impex_session": super_cookie})
        check("the Super Admin portal's own cookie does not authorize the product routes (401)", status == 401, status)
        check("no token -> 401 from the Inventory Service", call(INVENTORY, "GET", "/api/v1/inventory/products")[0] == 401)
        check("garbage token -> 401", call(INVENTORY, "GET", "/api/v1/inventory/products", headers=bearer("nonsense"))[0] == 401)

        if args.with_outage:
            print("\n== 9. Inventory Service outage")
            docker("compose", "stop", "inventory-service")
            try:
                status, body = create("a", sku="ISO-DOWN")
                check("creating a product answers 503 with a clear message", status == 503, (status, body))
                status, html, _ = page("a")
                check("the Products page shows a temporary-unavailable notice", status == 200 and "temporarily unavailable" in html)
            finally:
                docker("compose", "start", "inventory-service")
                wait_until(INVENTORY, "/health")
            check("everything works again afterwards", create("a", sku="ISO-BACK")[0] == 201)
        else:
            print("\n(skipped: Inventory Service outage check - run with --with-outage)")
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        left_products = delete_exact(psql, "impex_inventory", "products", created.get("products"))
        left_orgs = delete_exact(psql, "impex_organizations", "organizations", created.get("organizations"))
        left_users = delete_exact(psql, "impex_auth", "users", created.get("users"))
        print(f"deleted {len(created.get('products'))} products, {len(created.get('organizations'))} organizations, {len(created.get('users'))} users")
        print(f"of those ids, rows still present -> products: {left_products}, organizations: {left_orgs}, users: {left_users}")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
