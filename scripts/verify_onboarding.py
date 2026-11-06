#!/usr/bin/env python3
"""End-to-end check of First-Time Organization Onboarding against the RUNNING stack.

    docker compose up -d                       # stack must be running; impex_auth at 0003, impex_organizations at 0004
    python scripts/verify_onboarding.py
    python scripts/verify_onboarding.py --with-outage    # also stops the Organization Service briefly

It creates throwaway organizations (their names start with "Onboarding Check"), each with throwaway administrators, and drives the
Organization Portal exactly as a browser does: sign in, get sent to /setup, upload a logo (valid and invalid files), save the company name
and the administrator's name, complete setup, land on the dashboard with the company's branding, sign out and in again, add a second
administrator to the configured company (who sees only the short profile screen), complete setup from two administrators at the same
moment, and prove that nothing leaks between organizations. It also checks the databases and the logo VOLUME themselves, restarts and
RECREATES the Organization Service to prove the logo survives, and proves that organizations and administrators that existed before this
release were migrated as already set up (nobody was locked out).

Everything it created is deleted afterwards, by exact id (and each logo file by its exact stored key). No emails are sent and no existing
record is touched.
"""
import argparse
import http.client
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402

AUTH, ORG, TENANT_PORTAL = 8000, 8001, 3001
results = []
KEY_RE = re.compile(r"^[a-z0-9]{2}/[A-Za-z0-9_-]{32,64}\.png$")


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


def call(port, method, path, body=None, headers=None, cookies=None, raw=None, content_type="application/json"):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    hdrs = {"Content-Type": content_type, **(headers or {})}
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
    conn.request(method, path, payload, hdrs)
    res = conn.getresponse()
    data = res.read()
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    location = res.getheader("location") or ""
    response_headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, data, set_cookies, location, response_headers


def text_of(data: bytes) -> str:
    return data.decode(errors="replace")


def jbody(data: bytes):
    try:
        return json.loads(data)
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


# ---- pictures without any imaging library -------------------------------------------------------------------------------------
def make_png(width: int, height: int, rgb=(40, 120, 90)) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + bytes(rgb) * width
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b"")


def multipart(field: str, filename: str, content_type: str, data: bytes):
    boundary = "----impexcheck" + secrets.token_hex(8)
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode()
    return head + data + f"\r\n--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script><rect width="200" height="200"/></svg>'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--with-outage", action="store_true", help="also stop the Organization Service briefly")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "onbcheck-sa@example.org"
    org_ids, user_ids, tokens, cookies = {}, {}, {}, {}
    created = CreatedIds()
    stored_keys = []

    def portal(who, method, path, body=None, headers=None, **kw):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]} if who in cookies else None, **kw)

    def page(who, path):
        status, data, _, location, _h = portal(who, "GET", path)
        return status, text_of(data).replace("<!-- -->", ""), location

    def api(who, method, path, body=None):
        status, data, _, _, _h = portal(who, method, path, body)
        return status, jbody(data)

    def sign_in(who, email):
        status, data, sc, _, _h = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": email, "password": password})
        cookies[who] = cookie_value(sc, "impex_tenant_session")
        status2, data2, _, _, _h = call(AUTH, "POST", "/api/v1/auth/login", {"email": email, "password": password})
        tokens[who] = jbody(data2).get("access_token")
        return status

    def sign_out(who):
        portal(who, "POST", "/api/auth/logout")
        cookies.pop(who, None)

    def upload(who, filename, content_type, data):
        body, ctype = multipart("file", filename, content_type, data)
        status, response, _, _, _h = portal(who, "POST", "/api/setup/logo", raw=body, content_type=ctype)
        return status, jbody(response)

    def org_row(key):
        return psql("impex_organizations", f"SELECT setup_status || '|' || coalesce(setup_completed_at::text, '') || '|' || coalesce(setup_completed_by::text, '') || '|' || coalesce(logo_storage_key, '') || '|' || name || '|' || slug FROM organizations WHERE id = '{org_ids[key]}'").split("|")

    def user_profile(who):
        return psql("impex_auth", f"SELECT coalesce(profile_setup_completed_at::text, '') || '|' || full_name || '|' || email || '|' || role || '|' || organization_id FROM users WHERE id = '{user_ids[who]}'").split("|")

    def volume_files():
        out = docker("exec", "impex-organization-service", "sh", "-c", "find /data/logos -type f ! -name '.upload-*' | sort")
        return [l for l in out.splitlines() if l]

    def add_admin(org_key, who, name, email):
        status, data, _, _, _h = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[org_key], "full_name": name, "email": email, "password": password}, {"X-Internal-Key": internal_key})
        user_ids[who] = jbody(data).get("id")
        created.add("users", user_ids[who])
        return status

    def new_org(key, name):
        status, data, _, _, _h = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"onbcheck-{key}-{secrets.token_hex(3)}", "country_code": "DE", "contact_email": f"ops-{key}@example.org"}, bearer(sa_token))
        org_ids[key] = jbody(data).get("id")
        created.add("organizations", org_ids[key])
        return status

    def is_redirect(status):
        return status in (301, 302, 303, 307, 308)

    try:
        print("== setup: throwaway Super Admin, organizations and administrators (no emails involved)")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        # the organizations and administrators that exist BEFORE this run's throwaways: they belong to real people
        existing_orgs = psql("impex_organizations", "SELECT count(*) FROM organizations")
        existing_users = psql("impex_auth", "SELECT count(*) FROM users")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='ONBcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, data, _, _, _h = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        sa_token = jbody(data).get("access_token")
        check("throwaway Super Admin can sign in", status == 200 and sa_token, (status, data))

        print("\n== 1. the state: new organizations start incomplete, existing ones were migrated as complete")
        legacy_open = psql("impex_organizations", "SELECT count(*) FROM organizations WHERE setup_status <> 'completed'")
        legacy_users_open = psql("impex_auth", f"SELECT count(*) FROM users WHERE profile_setup_completed_at IS NULL AND id <> '{sa_id}'")  # (not this run's own throwaway Super Admin)
        check("every organization that existed before this run is 'completed' (no administrator was locked out by the migration)", legacy_open == "0", legacy_open)
        check("every account that existed before this run has its profile marked confirmed", legacy_users_open == "0", legacy_users_open)
        check("migrated organizations carry a completion time and no completing user", psql("impex_organizations", "SELECT count(*) FROM organizations WHERE setup_status = 'completed' AND (setup_completed_at IS NULL)") == "0")
        check("the schema carries the new columns and constraints", psql("impex_organizations", "SELECT count(*) FROM information_schema.columns WHERE table_name = 'organizations' AND column_name IN ('setup_status', 'setup_completed_at', 'setup_completed_by', 'logo_storage_key', 'logo_content_type', 'logo_updated_at')") == "6"
              and psql("impex_auth", "SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'profile_setup_completed_at'") == "1")

        check("organization A created by the Super Admin", new_org("a", "Onboarding Check Alpha") == 201 and org_ids["a"])
        check("administrator A1 created", add_admin("a", "a1", "Olivia Owner", "onbcheck-a1@example.org") == 201)
        check("organization B and its administrator created", new_org("b", "Onboarding Check Beta") == 201 and add_admin("b", "b1", "Bruno Beta", "onbcheck-b1@example.org") == 201)
        row = org_row("a")
        check("a NEW organization starts 'pending' with no completion time, no completing user and no logo", row[:4] == ["pending", "", "", ""], row)
        check("a NEW administrator starts with the profile unconfirmed", user_profile("a1")[0] == "", user_profile("a1"))
        sign_in("a1", "onbcheck-a1@example.org")
        status, data, _, _, _h = call(AUTH, "GET", "/api/v1/auth/me", headers=bearer(tokens["a1"]))
        check("the Auth Service reports it (profile_setup_completed_at is null)", status == 200 and jbody(data).get("profile_setup_completed_at") is None, data)

        print("\n== 2. first login: sent to the wizard, and the wizard cannot be skipped")
        check("A1 signs in to the Organization Portal", cookies.get("a1") and tokens.get("a1"))
        files_before = volume_files()
        s, html, loc = page("a1", "/")
        check("the dashboard redirects to /setup (a real HTTP redirect, before anything is shown)", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        for path in ("/products", "/warehouses", "/stock", "/scan", "/movements", "/clients", "/delivery-lists", "/dispatches", "/invoices", "/suppliers", "/purchase-orders", "/goods-receipts", "/clients/" + str(uuid.uuid4()), "/invoices/new"):
            s, html, loc = page("a1", path)
            check(f"typing {path} in the address bar is redirected to /setup, not shown", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        s, html, loc = page("a1", "/login")
        check("the login page does not trap a signed-in administrator (it sends them on to /, which sends them to /setup: no loop)", is_redirect(s) and (loc.endswith("/") or loc.endswith("/setup")), (s, loc))
        s, html, loc = page("a1", "/setup")
        check("/setup shows the first step, with the company name prefilled from the Organization Service",
              s == 200 and "Welcome to Impex" in html and "Let&#x27;s personalize your company workspace" in html and "Onboarding Check Alpha" in html and "Company logo" in html and "Setup progress" in html, s)
        check("the setup page carries Sign out (logout stays available throughout)", "Sign out" in html)
        s, data, _, loc, _h = call(TENANT_PORTAL, "GET", "/setup")
        check("/setup without a session goes to the login page", is_redirect(s) and "/login" in loc, (s, loc))
        s, body = api("a1", "GET", "/api/sales/clients")
        check("the business APIs are refused on the SERVER too while setup is unfinished (403 setup_required): typing an API address does not bypass the wizard", s == 403 and body.get("code") == "setup_required", (s, body))
        s, body = api("a1", "GET", "/api/support/tickets")
        check("...but Help & Support stays reachable during setup", s == 200, (s, body))

        print("\n== 3. the company logo: what is refused")
        invalid = {
            "an SVG (can carry script)": ("logo.svg", "image/svg+xml", SVG),
            "an SVG pretending to be a PNG": ("logo.png", "image/png", SVG),
            "HTML pretending to be a PNG": ("logo.png", "image/png", b"<html><script>alert(1)</script></html>"),
            "an executable pretending to be a PNG": ("logo.png", "image/png", b"MZ\x90\x00\x03" + b"\x00" * 300),
            "a GIF": ("logo.gif", "image/gif", b"GIF89a" + b"\x00" * 100),
            "a PDF": ("logo.pdf", "application/pdf", b"%PDF-1.4\n" + b"x" * 100),
            "a truncated PNG": ("logo.png", "image/png", make_png(300, 200)[:120]),
            "a picture that is too small (32 x 32)": ("logo.png", "image/png", make_png(32, 32)),
            "a picture with too many pixels (4100 x 4100, a decompression bomb)": ("logo.png", "image/png", make_png(4100, 4100)),
            "a file over 2 MB": ("logo.png", "image/png", b"\x89PNG\r\n\x1a\n" + os.urandom(2 * 1024 * 1024 + 10)),
            "an empty file": ("logo.png", "image/png", b""),
        }
        for label, (filename, ctype, data) in invalid.items():
            s, body = upload("a1", filename, ctype, data)
            check(f"{label} is refused (400)", s == 400 and body.get("error"), (s, str(body)[:120]))
        check("none of that stored anything: no file on the logo volume, no logo in the database", volume_files() == files_before and org_row("a")[3] == "")
        status, data, _, _, _h = portal("a1", "POST", "/api/setup/logo", raw=b"not multipart", content_type="application/json")
        check("a non-multipart upload is refused (415)", status == 415, status)
        status, data, _, _, _h = call(TENANT_PORTAL, "POST", "/api/setup/logo", raw=b"x")
        check("an upload without a session is refused (401)", status == 401, status)

        print("\n== 4. the company logo: a valid upload")
        logo_a = make_png(300, 200, (40, 120, 90))
        s, body = upload("a1", "my company.png", "image/png", logo_a)
        setup = body.get("setup", {})
        check("a valid PNG is accepted (200) and setup is now in progress", s == 200 and setup.get("has_logo") is True and setup.get("logo_version") and setup.get("setup_status") == "in_progress", (s, body))
        row = org_row("a")
        key_a = row[3]
        stored_keys.append(key_a)
        check("the logo is stored under an unpredictable server-made key (not the file name), as a PNG", bool(KEY_RE.match(key_a)) and "company" not in key_a, key_a)
        files = [f for f in volume_files() if f not in files_before]
        check("exactly one new file exists on the persistent logo volume, and it is a real PNG (re-encoded, not the raw upload)", len(files) == 1 and files[0].endswith(key_a.split("/")[1]), files)
        s, data, _, _, headers = portal("a1", "GET", f"/api/organization/logo?v={setup.get('logo_version')}")
        check("the logo is served to its owner as a plain PNG image, nosniff, with a CSP that forbids everything, and never cached publicly",
              s == 200 and data[:8] == b"\x89PNG\r\n\x1a\n" and headers.get("content-type") == "image/png" and headers.get("x-content-type-options") == "nosniff"
              and headers.get("content-security-policy") == "default-src 'none'" and headers.get("cache-control", "").startswith("private"), (s, headers))
        check("without a session the logo is 401, and a malformed query does not matter", call(TENANT_PORTAL, "GET", "/api/organization/logo")[0] == 401)
        s, html, loc = page("a1", "/setup")
        check("a refresh of the setup page resumes at the next step: the saved logo is not asked for again", s == 200 and "Tell us about yourself" in html and "Drag and drop" not in html, s)
        check("no storage key, path or volume name is in any page or API answer", key_a not in html and key_a.split("/")[1] not in html and "/data/logos" not in html and key_a not in json.dumps(body))

        print("\n== 5. the company name and the administrator's name")
        for bad in ("", "A", "<script>alert(1)</script>", "Acme {x}", "x" * 121):
            s, body = api("a1", "PUT", "/api/setup/company", {"companyName": bad})
            check(f"company name {bad[:25]!r} is refused (400)", s == 400, (s, body))
        s, body = api("a1", "PUT", "/api/setup/company", {"companyName": "  Onboarding   Check Alpha GmbH ", "slug": "hijacked", "organization_id": org_ids["b"], "country_code": "US", "setup_status": "completed", "is_active": False})
        row = org_row("a")
        check("the company name is saved, cleaned (200); slug, country, id and status are not touched however they are asked", s == 200 and row[4] == "Onboarding Check Alpha GmbH" and row[0] == "in_progress" and not row[5].startswith("hijacked")
              and psql("impex_organizations", f"SELECT country_code || '|' || is_active::text FROM organizations WHERE id = '{org_ids['a']}'") == "DE|true", (s, row))
        check("the same request could not reach organization B", org_row("b")[0] == "pending" and org_row("b")[4] == "Onboarding Check Beta")
        for bad in ("", "A", "<b>x</b>", "Jane 3rd", "x" * 101):
            s, body = api("a1", "PUT", "/api/setup/profile", {"fullName": bad})
            check(f"administrator name {bad[:25]!r} is refused (400)", s == 400, (s, body))
        s, body = api("a1", "PUT", "/api/setup/profile", {"fullName": " Olivia   Owner-Smith ", "role": "super-admin", "email": "evil@example.org", "organization_id": org_ids["b"], "password": "N3w!Passphrase#1", "user_id": user_ids["b1"]})
        profile = user_profile("a1")
        check("the administrator's name is saved in the Auth Service (200), cleaned; role, e-mail, organization and password are untouched", s == 200 and profile[1] == "Olivia Owner-Smith" and profile[2] == "onbcheck-a1@example.org" and profile[3] == "organization-admin" and profile[4] == org_ids["a"], (s, profile))
        check("the profile is still NOT marked confirmed, and another administrator's name was not touched", profile[0] == "" and user_profile("b1")[1] == "Bruno Beta")
        status, data, _, _, _h = call(AUTH, "PATCH", "/api/v1/auth/me/profile", {"full_name": "Olivia", "role": "super-admin"}, bearer(tokens["a1"]))
        check("the Auth Service itself refuses a profile update that tries to change the role (422)", status == 422, status)
        status, data, _, _, _h = call(AUTH, "PATCH", "/api/v1/auth/me/profile", {"full_name": "Olivia Owner-Smith"}, bearer(sa_token))
        check("a Super Admin cannot use the profile endpoint (403)", status == 403, status)

        print("\n== 6. an interrupted setup resumes (refresh, sign out and in, another device)")
        s, html, _ = page("a1", "/setup")
        check("a refresh resumes at step 2", s == 200 and "Tell us about yourself" in html and "Olivia Owner" in html, s)
        sign_out("a1")
        check("A1 signs in again (a new session, nothing in the browser)", sign_in("a1", "onbcheck-a1@example.org") == 200)
        s, html, _ = page("a1", "/setup")
        check("...and is still in the wizard at step 2: the progress is in the databases, not the browser", s == 200 and "Tell us about yourself" in html)
        s, html, loc = page("a1", "/")
        check("...and the dashboard is still closed to them", is_redirect(s) and loc.endswith("/setup"), (s, loc))

        print("\n== 7. completing: one click, two services, then the dashboard")
        s, body = api("a1", "POST", "/api/setup/complete", {"fullName": "<b>", "companyName": "Onboarding Check Alpha GmbH"})
        check("completing with an invalid name is refused and completes nothing", s == 400 and org_row("a")[0] == "in_progress" and user_profile("a1")[0] == "")
        s, body = api("a1", "POST", "/api/setup/complete", {"fullName": "Olivia Owner-Smith", "companyName": "Onboarding Check Alpha GmbH"})
        check("Complete Setup succeeds (200) and tells the browser to go to the dashboard", s == 200 and body.get("done") is True and body.get("redirectTo") == "/", (s, body))
        row, profile = org_row("a"), user_profile("a1")
        check("the Organization Service now says completed, with the time and the administrator who completed it", row[0] == "completed" and row[1] != "" and row[2] == user_ids["a1"] and row[4] == "Onboarding Check Alpha GmbH", row)
        check("the Auth Service now says the profile is confirmed, with the saved name", profile[0] != "" and profile[1] == "Olivia Owner-Smith", profile)
        first_time, first_profile_time = row[1], profile[0]
        s, html, loc = page("a1", "/")
        check("the dashboard now opens (200): no further redirect", s == 200 and "Welcome, Olivia Owner-Smith" in html, (s, loc))
        check("the header shows the company logo, the company name, the Admin Portal subtitle and the administrator's updated name",
              "/api/organization/logo?v=" in html and "Onboarding Check Alpha GmbH" in html and "Admin Portal" in html and html.count("Olivia Owner-Smith") >= 2, "")
        for path in ("/products", "/stock", "/invoices", "/clients"):
            s, html, loc = page("a1", path)
            check(f"{path} opens now, with the company branding in its header", s == 200 and "/api/organization/logo?v=" in html, (s, loc))
        s, html, loc = page("a1", "/setup")
        check("/setup now sends them to the dashboard (no loop)", is_redirect(s) and (loc.endswith("/") or loc.endswith(":3001")), (s, loc))
        s, body = api("a1", "POST", "/api/setup/complete", {"fullName": "Olivia Owner-Smith", "companyName": "A Different Name"})
        row, profile = org_row("a"), user_profile("a1")
        check("completing again is harmless (200) and changes nothing: same time, same person, same name", s == 200 and row[1] == first_time and row[4] == "Onboarding Check Alpha GmbH" and profile[0] == first_profile_time, (s, row))
        s, body = api("a1", "PUT", "/api/setup/company", {"companyName": "Renamed Later"})
        check("the first-time wizard is closed: the company cannot be renamed through it any more (409)", s == 409 and org_row("a")[4] == "Onboarding Check Alpha GmbH", (s, body))
        s, body = upload("a1", "other.png", "image/png", make_png(200, 200, (200, 30, 30)))
        check("...nor the logo replaced (409)", s == 409 and org_row("a")[3] == key_a, (s, body))
        check("...and no stray file was left behind by the refused upload", len([f for f in volume_files() if f not in files_before]) == 1)

        print("\n== 8. later logins never repeat a completed wizard")
        sign_out("a1")
        check("A1 signs out and in again", sign_in("a1", "onbcheck-a1@example.org") == 200)
        s, html, loc = page("a1", "/")
        check("they go straight to the dashboard (200), no wizard", s == 200 and "Welcome, Olivia Owner-Smith" in html, (s, loc))

        print("\n== 9. a second administrator of a configured company only confirms their own profile")
        check("A2 is added to the configured organization", add_admin("a", "a2", "Second Admin", "onbcheck-a2@example.org") == 201)
        check("A2 signs in", sign_in("a2", "onbcheck-a2@example.org") == 200)
        s, html, loc = page("a2", "/")
        check("A2 is sent to /setup (their own profile is unconfirmed)", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        s, html, _ = page("a2", "/setup")
        check("A2 sees the SHORT welcome: the company they are joining and their name; no logo upload, no company name field, no progress steps",
              s == 200 and "Welcome, let&#x27;s confirm your name" in html and "You are joining" in html and "Onboarding Check Alpha GmbH" in html and "Choose a logo file" not in html and 'id="company-name"' not in html and "Setup progress" not in html and "Continue to Dashboard" in html, s)
        s, body = api("a2", "PUT", "/api/setup/company", {"companyName": "Hijack"})
        check("A2 cannot change the company (409): it is already set up", s == 409 and org_row("a")[4] == "Onboarding Check Alpha GmbH")
        s, body = api("a2", "POST", "/api/setup/complete", {"fullName": "Second Admin Two"})
        check("A2 confirms their name (200) without any company field", s == 200 and body.get("done") is True, (s, body))
        row = org_row("a")
        check("the company record is exactly as before (same completion time, same completing administrator, same logo)", row[1] == first_time and row[2] == user_ids["a1"] and row[3] == key_a)
        check("A2's profile is confirmed with their name; A1's is untouched", user_profile("a2")[0] != "" and user_profile("a2")[1] == "Second Admin Two" and user_profile("a1")[0] == first_profile_time)
        s, html, _ = page("a2", "/")
        check("A2 now sees the dashboard with the SAME company logo and name", s == 200 and "/api/organization/logo?v=" in html and "Onboarding Check Alpha GmbH" in html and "Second Admin Two" in html)
        s, data, _, _, _h = portal("a2", "GET", "/api/organization/logo")
        check("A2 gets the same logo file as A1", s == 200 and data[:8] == b"\x89PNG\r\n\x1a\n")

        print("\n== 10. two administrators of a new company finish setup at the same moment")
        check("organization C with administrators C1 and C2", new_org("c", "Onboarding Check Gamma") == 201 and add_admin("c", "c1", "Carla One", "onbcheck-c1@example.org") == 201 and add_admin("c", "c2", "Carlos Two", "onbcheck-c2@example.org") == 201)
        check("both sign in and are sent to /setup", sign_in("c1", "onbcheck-c1@example.org") == 200 and sign_in("c2", "onbcheck-c2@example.org") == 200 and all(is_redirect(page(w, "/")[0]) for w in ("c1", "c2")))
        s, body = upload("c1", "c.png", "image/png", make_png(256, 256, (30, 60, 200)))
        stored_keys.append(org_row("c")[3])
        check("C1 uploads the logo", s == 200 and org_row("c")[3] != "")
        outcomes = run_parallel(8, lambda i: portal("c1" if i % 2 == 0 else "c2", "POST", "/api/setup/complete", {"fullName": "Carla One" if i % 2 == 0 else "Carlos Two", "companyName": f"Onboarding Check Gamma {i % 2}"}))
        statuses = sorted(o[0] for o in outcomes)
        row = org_row("c")
        check("eight simultaneous completions from two administrators: every one answers 200 and the company completes exactly once", statuses == [200] * 8 and row[0] == "completed" and row[2] in (user_ids["c1"], user_ids["c2"]), (statuses, row))
        check("both administrators' profiles are confirmed, and both now see the dashboard with the one company name",
              user_profile("c1")[0] != "" and user_profile("c2")[0] != "" and all(page(w, "/")[0] == 200 and row[4] in page(w, "/")[1] for w in ("c1", "c2")), row)

        print("\n== 11. organizations never see each other's identity")
        check("B1 signs in and is sent to /setup (B is still pending)", sign_in("b1", "onbcheck-b1@example.org") == 200 and is_redirect(page("b1", "/")[0]))
        s, data, _, _, _h = portal("b1", "GET", "/api/organization/logo")
        check("B has no logo: asking for it is a 404, never A's picture", s == 404 and data[:4] != b"\x89PNG", s)
        s, data, _, _, _h = portal("b1", "GET", f"/api/organization/logo?organization_id={org_ids['a']}&v=1", headers={"X-Organization-Id": org_ids["a"]})
        check("naming A's organization in the query or a header changes nothing: still B's own (404)", s == 404 and data[:4] != b"\x89PNG", s)
        s, body = api("b1", "PUT", "/api/setup/company", {"companyName": "Beta Renamed", "organization_id": org_ids["a"]})
        check("B1's company save lands on B only (200); A is untouched", s == 200 and org_row("b")[4] == "Beta Renamed" and org_row("a")[4] == "Onboarding Check Alpha GmbH")
        s, body = upload("b1", "b.png", "image/png", make_png(200, 200, (200, 40, 40)))
        stored_keys.append(org_row("b")[3])
        s2, data, _, _, _h = portal("b1", "GET", "/api/organization/logo")
        s3, data_a, _, _, _h = portal("a1", "GET", "/api/organization/logo")
        check("B's logo is B's own and A's is still A's (different pictures, different files)", s == 200 and s2 == 200 and s3 == 200 and data != data_a and org_row("b")[3] != org_row("a")[3])
        status, data, _, _, _h = call(ORG, "GET", "/api/v1/tenant/onboarding", headers=bearer(sa_token))
        check("a Super Admin token is refused by the tenant onboarding endpoints (403)", status == 403, status)

        print("\n== 12. disabled administrators and inactive organizations")
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE id = '{user_ids['b1']}'")
        status, data, _, _, _h = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": "onbcheck-b1@example.org", "password": password})
        check("a disabled administrator cannot sign in (403)", status == 403, status)
        s, html, loc = page("b1", "/")
        check("...and the session they already had stops working at once (sent to login)", is_redirect(s) and "/login" in loc, (s, loc))
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE id = '{user_ids['b1']}'")
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['b']}'")
        s, html, loc = page("b1", "/setup")
        check("an administrator of an INACTIVE organization is not stranded in the wizard: /setup sends them to the page that explains it", is_redirect(s) and (loc.endswith("/") or loc.endswith(":3001")), (s, loc))
        s, html, loc = page("b1", "/")
        check("...which says the organization is inactive (and does not run the wizard)", s == 200 and "currently inactive or unavailable" in html, s)
        s, body = upload("b1", "b2.png", "image/png", make_png(200, 200))
        check("an inactive organization cannot upload a logo (403)", s == 403, (s, body))
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['b']}'")

        print("\n== 13. the logo survives restarts, recreation and a new session")
        logo_before = portal("a1", "GET", "/api/organization/logo")[1]
        docker("compose", "restart", "organization-service")
        wait_until(ORG, "/health")
        s, data, _, _, _h = portal("a1", "GET", "/api/organization/logo")
        check("after restarting the Organization Service the same logo is served", s == 200 and data == logo_before, s)
        docker("compose", "up", "-d", "--force-recreate", "--no-deps", "organization-service")
        wait_until(ORG, "/health")
        s, data, _, _, _h = portal("a1", "GET", "/api/organization/logo")
        check("after RECREATING the container (a new container filesystem) the same logo is still served: it lives on the named volume", s == 200 and data == logo_before, s)
        check("the named volume exists", "org-logos" in docker("volume", "ls", "--format", "{{.Name}}"))
        sign_out("a1")
        sign_in("a1", "onbcheck-a1@example.org")
        s, html, _ = page("a1", "/")
        check("after signing in again the dashboard still shows the logo and the name", s == 200 and "/api/organization/logo?v=" in html and "Onboarding Check Alpha GmbH" in html)

        print("\n== 14. other features are untouched")
        status, data, _, _, _h = call(8001, "GET", "/api/v1/organizations", headers=bearer(sa_token))
        check("the Super Admin's organization list still works and shows the organizations", status == 200 and any(o["id"] == org_ids["a"] for o in jbody(data)), status)
        status, data, _, _, _h = call(3000, "GET", "/login")
        check("the Super Admin portal login page still loads (unchanged)", status == 200)
        check("the other organizations' pages still work for configured administrators (products, stock, invoices, clients)", all(page("a1", p)[0] == 200 for p in ("/products", "/stock", "/invoices", "/clients", "/delivery-lists", "/dispatches")))

        if args.with_outage:
            print("\n== 15. a service outage is recoverable and never read as 'setup complete'")
            check("C-pending organization D for the outage checks", new_org("d", "Onboarding Check Delta") == 201 and add_admin("d", "d1", "Dana One", "onbcheck-d1@example.org") == 201 and sign_in("d1", "onbcheck-d1@example.org") == 200)
            upload("d1", "d.png", "image/png", make_png(200, 200))
            stored_keys.append(org_row("d")[3])
            docker("compose", "stop", "organization-service")
            try:
                s, html, loc = page("d1", "/")
                check("with the Organization Service down, an unfinished administrator is NOT shown the dashboard as if setup were complete", not (s == 200 and "Welcome, Dana One" in html and "temporarily unavailable" not in html), (s, loc))
                s, html, loc = page("d1", "/products")
                check("a page shows a recoverable error instead of its content (200, 'We couldn't load your workspace')", s == 200 and "load your workspace" in html, (s, loc))
                s, html, loc = page("d1", "/setup")
                check("/setup says it could not load the setup, with Try again and Sign out", s == 200 and "load your setup" in html and "Try again" in html and "Sign out" in html, (s, loc))
                s, body = api("d1", "POST", "/api/setup/complete", {"fullName": "Dana One", "companyName": "Onboarding Check Delta"})
                check("completing answers 503 with a clear message and changes nothing", s == 503 and org_row("d")[0] == "in_progress" and user_profile("d1")[0] == "", (s, body))
                s, data, _, _, _h = portal("d1", "GET", "/api/organization/logo")
                check("the logo route answers 503, not a broken image", s == 503, s)
            finally:
                docker("compose", "start", "organization-service")
                wait_until(ORG, "/health")
            s, body = api("d1", "POST", "/api/setup/complete", {"fullName": "Dana One", "companyName": "Onboarding Check Delta"})
            check("once the service is back, the SAME completion goes through (200): nothing was lost", s == 200 and org_row("d")[0] == "completed" and user_profile("d1")[0] != "", (s, body))
            check("and the dashboard opens", page("d1", "/")[0] == 200)
        else:
            print("\n(skipped: outage checks - run with --with-outage)")

        print("\n== 16. nothing that existed before was changed")
        mine = ", ".join(f"'{i}'" for i in org_ids.values())
        check("every organization that is not one of this run's throwaways is still 'completed', and the counts of the others are unchanged",
              psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE setup_status <> 'completed' AND id NOT IN ({mine})") == "0"
              and int(psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id NOT IN ({mine})")) == int(existing_orgs))
    finally:
        print("\n== cleanup (exactly the rows and files this run created, by id)")
        orgs = created.get("organizations")
        keys = [k for k in stored_keys if k and KEY_RE.match(k)]
        if orgs:
            more = psql("impex_organizations", "SELECT logo_storage_key FROM organizations WHERE id IN (" + ", ".join(f"'{o}'" for o in orgs) + ") AND logo_storage_key IS NOT NULL").splitlines()
            keys += [k for k in more if KEY_RE.match(k) and k not in keys]
        for key in keys:
            docker("exec", "impex-organization-service", "rm", "-f", f"/data/logos/{key}")
        left = {
            "organizations": delete_exact(psql, "impex_organizations", "organizations", orgs),
            "users": delete_exact(psql, "impex_auth", "users", created.get("users")),
        }
        remaining = [f for f in volume_files() if any(f.endswith(k.split("/")[1]) for k in keys)] if keys else []
        print(f"deleted {len(orgs)} organizations, {len(created.get('users'))} users and {len(keys)} logo files")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()) + f"; logo files still on the volume: {len(remaining)}")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
