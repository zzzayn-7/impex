#!/usr/bin/env python3
"""End-to-end check of multi-tenant isolation against the RUNNING stack.

    docker compose up -d            # stack must be running
    python scripts/verify_tenant_isolation.py                 # safe checks
    python scripts/verify_tenant_isolation.py --with-outage   # also stops the Auth Service for a few seconds

It creates two throwaway organizations ("Isolation Alpha Co" / "Isolation Beta Co") with one administrator each,
signs both in to the Organization Portal, tries to cross from one to the other in every way it can, and then
deletes everything it created. No emails are sent and no existing record is touched. Passwords and tokens are
random, kept in memory and never printed.
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
AUTH, ORG, SUPER_PORTAL, TENANT_PORTAL = 8000, 8001, 3000, 3001
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
    conn = http.client.HTTPConnection("localhost", port, timeout=30)
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


def tenant_get(token, **kwargs):
    return call(ORG, "GET", "/api/v1/tenant/organization", headers=bearer(token) if token else None, **kwargs)


def page(cookie):
    status, html, _, location = call(TENANT_PORTAL, "GET", "/", cookies={"impex_tenant_session": cookie})
    return status, html.replace("<!-- -->", ""), location


def wait_until(url_port, path, timeout=60):
    for _ in range(timeout * 2):
        try:
            if call(url_port, "GET", path)[0] == 200:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--with-outage", action="store_true", help="also stop the Auth Service briefly to check for 503")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "isolation-sa@example.org"
    emails = {"a": "isolation-admin-a@example.org", "b": "isolation-admin-b@example.org"}
    slugs = {"a": "isolation-alpha-co", "b": "isolation-beta-co"}
    names = {"a": "Isolation Alpha Co", "b": "Isolation Beta Co"}
    org_ids = {}

    try:
        print("== setup: two organizations, one administrator each (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
               "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
               "with SessionLocal() as db:\n db.add(User(full_name='Isolation SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')); db.commit()")
        status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(text).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, text))
        tokens, cookies = {}, {}
        for key in ("a", "b"):
            status, text, _, _ = call(ORG, "POST", "/api/v1/organizations", {
                "name": names[key], "slug": slugs[key], "country_code": "DE" if key == "a" else "FR",
                "tax_identifier": f"TAX-{key.upper()}-123", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
            org_ids[key] = jbody(text).get("id")
            check(f"organization {key.upper()} created", status == 201 and org_ids[key], (status, text))
            status, text, _, _ = call(AUTH, "POST", "/internal/organization-admins", {
                "organization_id": org_ids[key], "full_name": f"Admin {key.upper()}", "email": emails[key], "password": password},
                {"X-Internal-Key": internal_key})
            check(f"administrator {key.upper()} created for organization {key.upper()}", status == 201, (status, text))
            status, text, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": emails[key], "password": password})
            tokens[key] = jbody(text).get("access_token")
            status, text, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": emails[key], "password": password})
            cookies[key] = cookie_value(sc, "impex_tenant_session")
            check(f"administrator {key.upper()} signs in to the Organization Portal", status == 200 and cookies[key], (status, text))
        a, b = tokens["a"], tokens["b"]

        print("\n== 1. each administrator gets only their own organization (API)")
        for key, other in (("a", "b"), ("b", "a")):
            status, text, _, _ = tenant_get(tokens[key])
            body = jbody(text)
            check(f"administrator {key.upper()} receives organization {key.upper()}",
                  status == 200 and body.get("id") == org_ids[key] and body.get("name") == names[key], (status, text))
            check(f"...and nothing about organization {other.upper()}",
                  names[other] not in text and org_ids[other] not in text and f"ops-{other}@example.org" not in text)

        print("\n== 2. manipulating the request does not reach the other organization")
        for key, other in (("a", "b"), ("b", "a")):
            oid, slug = org_ids[other], slugs[other]
            attempts = {
                "query string": dict(path=f"/api/v1/tenant/organization?organization_id={oid}&org_id={oid}&slug={slug}"),
                "headers": dict(extra={"X-Organization-Id": oid, "X-Tenant-Id": oid, "X-Org-Id": oid}),
                "role headers": dict(extra={"X-User-Role": "super-admin", "X-User-Id": "1"}),
                "cookie": dict(extra={"Cookie": f"organization_id={oid}"}),
                "JSON body on GET": dict(body={"organization_id": oid}),
            }
            ok = True
            for label, spec in attempts.items():
                status, text, _, _ = call(ORG, "GET", spec.get("path", "/api/v1/tenant/organization"), spec.get("body"),
                                          {**bearer(tokens[key]), **spec.get("extra", {})})
                if not (status == 200 and jbody(text).get("id") == org_ids[key]):
                    ok = False
                    print(f"      attempt '{label}' by {key.upper()} returned {status}")
            check(f"administrator {key.upper()} still gets only organization {key.upper()} (5 manipulation attempts)", ok)
            for path in (f"/api/v1/tenant/organization/{oid}", f"/api/v1/tenant/{oid}/organization", f"/api/v1/tenant/organization/{slug}"):
                status, _, _, _ = call(ORG, "GET", path, headers=bearer(tokens[key]))
                check(f"URL naming the other organization does not exist ({path[:46]}...)", status in (404, 405), status)
            status, _, _, _ = call(ORG, "PUT", "/api/v1/tenant/organization", {"name": "Hacked"}, bearer(tokens[key]))
            check(f"administrator {key.upper()} cannot write through the tenant endpoint (405)", status == 405, status)

        print("\n== 3. the Organization Portal shows each administrator only their own organization")
        for key, other in (("a", "b"), ("b", "a")):
            status, html, _ = page(cookies[key])
            check(f"portal page {key.upper()} shows organization {key.upper()}'s name, id and details",
                  status == 200 and names[key] in html and org_ids[key] in html and f"TAX-{key.upper()}-123" in html and f"ops-{key}@example.org" in html)
            check(f"...and none of organization {other.upper()}'s data",
                  names[other] not in html and org_ids[other] not in html and f"TAX-{other.upper()}-123" not in html and f"ops-{other}@example.org" not in html)

        print("\n== 4. Super Admin APIs stay closed to organization administrators")
        before = psql("impex_organizations", "SELECT count(*) FROM organizations")
        for key, other in (("a", "b"), ("b", "a")):
            calls = [("GET", "/api/v1/organizations", None), ("GET", f"/api/v1/organizations/{org_ids[other]}", None),
                     ("GET", f"/api/v1/organizations/{slugs[other]}", None), ("GET", "/api/v1/organizations/administrators", None),
                     ("POST", "/api/v1/organizations", {"name": "Evil", "slug": "isolation-evil", "country_code": "US", "contact_email": "e@x.org"}),
                     ("POST", f"/api/v1/organizations/{org_ids[other]}/administrators", {"email": "evil@example.org", "full_name": "Evil Admin"})]
            codes = [call(ORG, m, p, body, bearer(tokens[key]))[0] for m, p, body in calls]
            check(f"administrator {key.upper()} gets 403 from all {len(calls)} Super Admin endpoints", set(codes) == {403}, codes)
        check("nothing was created or changed", psql("impex_organizations", "SELECT count(*) FROM organizations") == before
              and psql("impex_organizations", "SELECT count(*) FROM organizations WHERE slug = 'isolation-evil'") == "0")

        print("\n== 5. role separation between the two portals")
        status, _, _, _ = tenant_get(sa_token)
        check("a Super Admin gets 403 from the tenant endpoint", status == 403, status)
        status, text, sc, _ = call(SUPER_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        super_cookie = cookie_value(sc, "impex_session")
        check("(Super Admin signs in to the Super Admin Portal)", status == 200 and super_cookie, (status, text))
        status, _, _, location = call(TENANT_PORTAL, "GET", "/", cookies={"impex_tenant_session": super_cookie})
        check("a Super Admin session planted in the tenant cookie is rejected by the Organization Portal", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, location = call(TENANT_PORTAL, "GET", "/", cookies={"impex_session": super_cookie})
        check("the Super Admin portal's own cookie does not open the Organization Portal", status == 307 and location.endswith("/login"), (status, location))
        status, _, _, location = call(SUPER_PORTAL, "GET", "/organizations", cookies={"impex_session": cookies["a"]})
        check("an organization administrator's session is rejected by the Super Admin Portal", status == 307 and location.endswith("/login"), (status, location))

        print("\n== 6. consistent errors")
        check("no token -> 401", tenant_get(None)[0] == 401)
        check("garbage token -> 401", tenant_get("not-a-real-token")[0] == 401)
        check("only a header 'claiming' an organization, no token -> 401", call(ORG, "GET", "/api/v1/tenant/organization", headers={"X-Organization-Id": org_ids["a"]})[0] == 401)

        print("\n== 7. an inactive organization locks out only its own administrator")
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE slug = '{slugs['b']}'")
        status, text, _, _ = tenant_get(b)
        check("administrator B gets 403 'not active'", status == 403 and "not active" in text, (status, text))
        status, html, _ = page(cookies["b"])
        check("portal B explains it without showing any organization data", status == 200 and "currently inactive or unavailable" in html and names["b"] not in html)
        check("administrator A is unaffected", tenant_get(a)[0] == 200 and page(cookies["a"])[0] == 200)
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE slug = '{slugs['b']}'")
        check("reactivating organization B restores access", tenant_get(b)[0] == 200)

        print("\n== 8. a disabled account is locked out at once")
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE email = '{emails['a']}'")
        check("administrator A's token stops working (401)", tenant_get(a)[0] == 401)
        status, _, location = page(cookies["a"])
        check("administrator A's portal session redirects to /login", status == 307 and location.endswith("/login"), (status, location))
        check("administrator B is unaffected", tenant_get(b)[0] == 200)
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE email = '{emails['a']}'")
        check("re-enabling the account restores access", tenant_get(a)[0] == 200)

        if args.with_outage:
            print("\n== 9. Auth Service outage")
            docker("compose", "stop", "auth-service")
            try:
                status, _, _, _ = tenant_get(a)
                check("tenant endpoint answers 503 (not 401) while the Auth Service is down", status == 503, status)
            finally:
                docker("compose", "start", "auth-service")
                wait_until(AUTH, "/health")
            check("and recovers when the Auth Service is back", tenant_get(a)[0] == 200)
        else:
            print("\n(skipped: Auth Service outage check - run with --with-outage)")
    finally:
        print("\n== cleanup (only what this script created)")
        psql("impex_organizations", "DELETE FROM organizations WHERE slug LIKE 'isolation-%'")
        psql("impex_auth", "DELETE FROM users WHERE email LIKE 'isolation-%@example.org'")
        print("leftover isolation organizations:", psql("impex_organizations", "SELECT count(*) FROM organizations WHERE slug LIKE 'isolation-%'"))
        print("leftover isolation users        :", psql("impex_auth", "SELECT count(*) FROM users WHERE email LIKE 'isolation-%'"))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
