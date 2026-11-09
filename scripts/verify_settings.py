#!/usr/bin/env python3
"""End-to-end check of Organization Settings (Step 20) against the RUNNING stack.

    docker compose up -d                      # stack must be running; impex_organizations at 0006
    python scripts/verify_settings.py
    python scripts/verify_settings.py --skip-outage     # do not stop/recreate the Organization Service

It creates throwaway organizations ("Settings Check ..."), administrators and a few business records, and drives the Organization Portal as a
browser does: the Settings page, the company profile, the logo, the administrator's own name, the business preferences and the module list.
It proves: that settings are read from and saved to PostgreSQL (and survive a new session and a restart of the Organization Service), that the
restricted facts and the identity cannot be changed through Settings, that two administrators cannot overwrite each other, that preferences
are defaults and presentation only (an issued invoice, its payments, stock and stored times are byte-for-byte unchanged while the currency,
time zone and formats are changed, and a rename never touches the seller name already printed on an issued invoice), the change history,
tenant isolation, that first-time setup is neither restarted nor bypassed (including by calling the services directly), that Help & Support and
module requests never change anything, and that an outage loses nothing.

Everything it created is deleted afterwards, by exact id (and each logo file by its exact stored key). Organizations and records that existed
before are not touched.
"""
import argparse
import io
import json
import os
import re
import secrets
import struct
import sys
import threading
import time
import uuid
import zlib
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_modules as v  # noqa: E402  (module-level helpers only; its main() is not run)
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, INVENTORY, SALES, PURCHASING, SUPPORT, SA_PORTAL, TENANT_PORTAL = v.AUTH, v.ORG, v.INVENTORY, v.SALES, v.PURCHASING, v.SUPPORT, v.SA_PORTAL, v.TENANT_PORTAL
call, docker, psql, psql_with_errors, jbody, text_of, bearer, cookie_value, is_redirect, wait_until, wait_health = (
    v.call, v.docker, v.psql, v.psql_with_errors, v.jbody, v.text_of, v.bearer, v.cookie_value, v.is_redirect, v.wait_until, v.wait_health)
UUID_RE = v.UUID_RE
KEY_RE = re.compile(r"^[a-z0-9]{2}/[A-Za-z0-9_-]{32,64}\.png$")
results = []


def check(name: str, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


# ---- pictures without any imaging library ---------------------------------------------------------------------------------------
def make_png(width: int, height: int, rgb=(40, 120, 90)) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + bytes(rgb) * width
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b"")


def multipart(fields: dict, filename: str, content_type: str, data: bytes):
    boundary = "----settingscheck" + secrets.token_hex(8)
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script><rect width="200" height="200"/></svg>'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-outage", action="store_true", help="do not stop/recreate the Organization Service")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "setcheck-sa@example.org"
    org_ids, user_ids, tokens, cookies, emails = {}, {}, {}, {}, {}
    created = CreatedIds()
    stored_keys = []

    # ---- people and calls ------------------------------------------------------------------------------------------------------------
    def tenant(who, method, path, body=None, headers=None, **kw):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]} if who in cookies else None, **kw)

    def page(who, path):
        status, data, _, location = tenant(who, "GET", path)
        return status, text_of(data), location

    def api(who, method, path, body=None, headers=None):
        status, data, _, _ = tenant(who, method, path, body, headers)
        return status, jbody(data)

    def svc(who, port, method, path, body=None, headers=None):
        status, data, _, _ = call(port, method, path, body, {**bearer(tokens[who]), **(headers or {})})
        return status, jbody(data)

    def sign_in(who, address):
        status, _data, sc, _ = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": address, "password": password})
        cookies[who] = cookie_value(sc, "impex_tenant_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": address, "password": password})
        tokens[who] = jbody(data2).get("access_token")
        return status

    def sign_out(who):
        tenant(who, "POST", "/api/auth/logout")
        cookies.pop(who, None)

    def new_org(key, name):
        status, data, _, _ = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"setcheck-{key}-{secrets.token_hex(3)}", "country_code": "DE", "tax_identifier": f"DE{secrets.randbelow(10**9):09d}", "contact_email": f"ops-{key}@example.org"}, bearer(tokens["sa"]))
        org_ids[key] = jbody(data).get("id")
        created.add("organizations", org_ids[key])
        return status

    def add_admin(org_key, who, name):
        emails[who] = f"setcheck-{who}-{secrets.token_hex(2)}@example.org"
        status, data, _, _ = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[org_key], "full_name": name, "email": emails[who], "password": password}, {"X-Internal-Key": internal_key})
        user_ids[who] = jbody(data).get("id")
        created.add("users", user_ids[who])
        return status

    def org_row(key):
        return psql("impex_organizations", f"SELECT name || '|' || slug || '|' || country_code || '|' || coalesce(tax_identifier, '') || '|' || contact_email || '|' || is_active::text || '|' || setup_status || '|' || coalesce(setup_completed_at::text, '') || '|' || id FROM organizations WHERE id = '{org_ids[key]}'").split("|")

    def prefs_row(key):
        return psql("impex_organizations", f"SELECT default_currency || '|' || timezone || '|' || date_format || '|' || number_format || '|' || settings_version FROM organizations WHERE id = '{org_ids[key]}'").split("|")

    def version(key):
        return int(psql("impex_organizations", f"SELECT settings_version FROM organizations WHERE id = '{org_ids[key]}'"))

    def history_rows(key):
        return [r.split("|") for r in psql("impex_organizations", f"SELECT section || '|' || field || '|' || translate(coalesce(old_value, ''), chr(10), ' ') || '|' || translate(coalesce(new_value, ''), chr(10), ' ') || '|' || coalesce(changed_by_email, '') || '|' || version FROM organization_settings_history WHERE organization_id = '{org_ids[key]}' ORDER BY seq").splitlines() if r]

    def company_patch(who, key, body):
        return api(who, "PATCH", "/api/settings/company", {"expected_version": version(key), **body})

    def logo_files():
        out = docker("exec", "impex-organization-service", "sh", "-c", "find /data/logos -type f ! -name '.upload-*' | sort")
        return [l for l in out.splitlines() if l]

    def upload(who, key, name, ctype, data, expected=None):
        body, content_type = multipart({"expected_version": str(expected if expected is not None else version(key))}, name, ctype, data)
        status, response, _, _ = tenant(who, "PUT", "/api/settings/logo", raw=body, content_type=content_type)
        return status, jbody(response)

    # ---- business records, for the "nothing is rewritten" proof --------------------------------------------------------------------
    def make(who, path, body, field, table=None, idem=True):
        status, data, _, _ = tenant(who, "POST", path, body, {"Idempotency-Key": f"sc-{uuid.uuid4()}"} if idem else None)
        item = jbody(data).get(field, {})
        if table:
            created.add(table, item.get("id"))
        return item

    def sales_state(org):
        invoices = psql("impex_sales", f"SELECT coalesce(string_agg(coalesce(number, '-') || ':' || status || ':' || currency_code || ':' || subtotal::text || ':' || discount_total::text || ':' || tax_total::text || ':' || total::text || ':' || paid_total::text || ':' || coalesce(seller_name, '') || ':' || coalesce(client_name, '') || ':' || invoice_date::text || ':' || coalesce(issued_at::text, '') || ':' || created_at::text, '|' ORDER BY created_at), '') FROM invoices WHERE organization_id = '{org}'")
        payments = psql("impex_sales", f"SELECT coalesce(string_agg(kind || ':' || amount::text || ':' || currency_code || ':' || method || ':' || payment_date::text || ':' || created_at::text, '|' ORDER BY created_at), '') FROM invoice_payments WHERE organization_id = '{org}'")
        dispatches = psql("impex_sales", f"SELECT coalesce(string_agg(number || ':' || status || ':' || coalesce(confirmed_at::text, '') || ':' || created_at::text, '|' ORDER BY created_at), '') FROM dispatches WHERE organization_id = '{org}'")
        return invoices, payments, dispatches

    def inventory_state(org):
        balances = psql("impex_inventory", f"SELECT coalesce(string_agg(product_id || ':' || quantity::text, ',' ORDER BY product_id), '') FROM stock_balances WHERE organization_id = '{org}'")
        movements = psql("impex_inventory", f"SELECT count(*) || '/' || coalesce(string_agg(quantity::text || ':' || created_at::text, ',' ORDER BY created_at, id), '') FROM stock_movements WHERE organization_id = '{org}'")
        products = psql("impex_inventory", f"SELECT coalesce(string_agg(sku || ':' || unit || ':' || cost_price::text || ':' || selling_price::text || ':' || currency_code, ',' ORDER BY sku), '') FROM products WHERE organization_id = '{org}'")
        return balances, movements, products

    def purchasing_state(org):
        return psql("impex_purchasing", f"SELECT coalesce(string_agg(number || ':' || status || ':' || currency_code || ':' || created_at::text, '|' ORDER BY created_at), '') FROM purchase_orders WHERE organization_id = '{org}'")

    existing_before, existing_count, existing_history = "", "?", "?"
    counter_before = psql("impex_support", "SELECT coalesce((SELECT last_number FROM support_counters WHERE name = 'ticket'), 0)")
    try:
        print("== setup: a throwaway Super Admin, organizations A, B, C and their administrators")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        existing_before = psql("impex_organizations", "SELECT coalesce(string_agg(id || ':' || name || ':' || slug || ':' || contact_email || ':' || setup_status || ':' || settings_version::text || ':' || default_currency || ':' || timezone || ':' || date_format || ':' || number_format || ':' || coalesce(logo_storage_key, '') || ':' || coalesce(contact_phone, '') || ':' || coalesce(website, ''), ',' ORDER BY id), '') FROM organizations")
        existing_count = psql("impex_organizations", "SELECT count(*) FROM organizations")
        existing_history = psql("impex_organizations", "SELECT count(*) FROM organization_settings_history")
        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='SETcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        _s, data, sc, _ = call(SA_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        cookies["sa"] = cookie_value(sc, "impex_session")
        _s, data2, _, _ = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        tokens["sa"] = jbody(data2).get("access_token")
        check("throwaway Super Admin can sign in", cookies["sa"] and tokens["sa"])
        check("organizations A, B and C are created by the Super Admin", all(new_org(k, f"Settings Check {n}") == 201 for k, n in (("a", "Alpha"), ("b", "Beta"), ("c", "Gamma"))))
        check("administrators A1, A2 (same organization), B1 and C1 are created", add_admin("a", "a1", "Olivia Owner") == 201 and add_admin("a", "a2", "Alan Admin") == 201 and add_admin("b", "b1", "Bruno Beta") == 201 and add_admin("c", "c1", "Cora Newcomer") == 201)
        mark_setup_complete(psql, org_ids["a"])
        mark_setup_complete(psql, org_ids["b"])  # C keeps its first-time setup unfinished
        for who, address in emails.items():
            check(f"{who.upper()} signs in", sign_in(who, address) == 200 and cookies.get(who) and tokens.get(who))

        print("\n== 1. the Settings page and what is behind it")
        s, html, loc = page("a1", "/settings")
        check("/settings opens for a configured administrator, in the portal, with Settings in the menu and current", s == 200 and 'href="/settings"' in html and re.search(r'aria-current="page"[^>]*>.*?Settings</span></a>', html, re.S), (s, loc))
        check("it has the five sections", all(t in html for t in ("Company profile", "Company branding", "Administrator profile", "Business preferences", "Enabled modules")))
        row = org_row("a")
        check("the company section shows the organization's real name and contact e-mail from PostgreSQL", row[0] in html and row[4] in html and "Settings Check Alpha" in html and "ops-a@example.org" in html)
        check("the registered facts are shown read-only with Request change links", all(x in html for x in (row[1], row[3], org_ids["a"])) and 'href="/support/new?change=tax_id"' in html and 'href="/support/new?change=country"' in html)
        check("the administrator section shows their own account (name, e-mail, role, organization id, user id)", all(x in html for x in ("Olivia Owner", emails["a1"], "Organization administrator", org_ids["a"], user_ids["a1"])))
        s, body = svc("a1", ORG, "GET", "/api/v1/tenant/settings")
        check("the Organization Service answers the same (version 1, defaults USD / UTC / ISO date / 1,234.56)", s == 200 and body["version"] == 1 and body["preferences"] == {"default_currency": "USD", "timezone": "UTC", "date_format": "YYYY-MM-DD", "number_format": "comma_dot"}, body)
        check("Settings is not blocked by modules: it opens for an organization with every module off", (lambda r: r[0] == 200)((psql("impex_organizations", f"UPDATE organization_modules SET enabled = false WHERE organization_id = '{org_ids['b']}'"), page("b1", "/settings"))[1]))

        print("\n== 2. company profile: saved permanently, identity untouched, shown everywhere")
        before = org_row("a")
        s, body = company_patch("a1", "a", {"name": "  Settings   Check Alpha International ", "contact_phone": " +92  21 1234567 ", "address_street": "12 Harbour Road", "address_city": "Karachi", "address_state": "Sindh",
                                            "address_postal_code": "74000", "website": "WWW.alpha-check.example/about", "description": "We import machine parts.\n\n\n\nSince 1998.", "contact_email": " Office@Alpha-Check.EXAMPLE "})
        check("a company update through the portal is saved (200)", s == 200 and body["settings"]["version"] == 2, (s, body))
        after = org_row("a")
        check("the display name is cleaned and stored in PostgreSQL", after[0] == "Settings Check Alpha International", after)
        check("id, slug, country, tax number, status and setup state are exactly as before", [after[i] for i in (1, 2, 3, 5, 6, 7, 8)] == [before[i] for i in (1, 2, 3, 5, 6, 7, 8)], (before, after))
        stored = psql("impex_organizations", f"SELECT contact_email || '|' || contact_phone || '|' || address_street || '|' || address_city || '|' || address_state || '|' || address_postal_code || '|' || website FROM organizations WHERE id = '{org_ids['a']}'")
        check("every other field is normalized and stored", stored == "office@alpha-check.example|+92 21 1234567|12 Harbour Road|Karachi|Sindh|74000|https://www.alpha-check.example/about", stored)
        s, html, _ = page("a1", "/settings")
        check("a refresh of Settings shows the saved values", all(x in html for x in ("Settings Check Alpha International", "office@alpha-check.example", "+92 21 1234567", "Karachi", "https://www.alpha-check.example/about", "Since 1998.")))
        s, html, _ = page("a1", "/")
        check("the portal header shows the new company name (live branding)", "Settings Check Alpha International" in html)
        check("a second administrator of the same organization sees it too", "Settings Check Alpha International" in page("a2", "/settings")[1] and "Settings Check Alpha International" in page("a2", "/")[1])
        sign_out("a1")
        sign_in("a1", emails["a1"])
        check("after signing out and in again the new values are still there", "Settings Check Alpha International" in page("a1", "/settings")[1])
        hist = history_rows("a")
        check("each changed field is in the history with its old and new value and who changed it", {(r[0], r[1]) for r in hist} == {("company", f) for f in ("name", "contact_email", "contact_phone", "address_street", "address_city", "address_state", "address_postal_code", "website", "description")}
              and all(r[4] == emails["a1"] and r[5] == "2" for r in hist) and any(r[1] == "name" and r[2] == "Settings Check Alpha" and r[3] == "Settings Check Alpha International" for r in hist), hist)
        check("the module entitlements did not change", psql("impex_organizations", f"SELECT count(*) FROM organization_module_history WHERE organization_id = '{org_ids['a']}' AND action IN ('enabled', 'disabled')") == "0")

        print("\n== 3. invalid and malicious input, and fields that must never change through Settings")
        v_before = version("a")
        for label, body in (("a one-letter name", {"name": "A"}), ("a name with markup", {"name": "<script>alert(1)</script>"}), ("a bad e-mail", {"contact_email": "not-an-email"}), ("an e-mail with a header injection", {"contact_email": "x@y.example\r\nBcc: spy@evil.example"}),
                            ("a javascript: website", {"website": "javascript:alert(1)"}), ("a phone number of letters", {"contact_phone": "call me"}), ("an HTML description", {"description": "<img src=x onerror=alert(1)>"}),
                            ("a 1001-character description", {"description": "x" * 1001}), ("a name set to null", {"name": None})):
            s, body = company_patch("a1", "a", body)
            check(f"{label} is refused (400) and nothing changes", s == 400 and version("a") == v_before and org_row("a") == after, (s, body))
        for field, value in (("slug", "hijacked"), ("country_code", "US"), ("tax_identifier", "XX999"), ("is_active", False), ("setup_status", "pending"), ("organization_id", org_ids["b"]), ("id", org_ids["b"]), ("primary_admin_email", "evil@example.org"), ("modules", ["finance"])):
            s, body = company_patch("a1", "a", {"name": "Settings Check Alpha International", field: value})
            check(f"'{field}' sent through the portal is never forwarded: the organization is unchanged", org_row("a") == after and version("a") == v_before, (s, org_row("a")))
            s2, body2 = svc("a1", ORG, "PATCH", "/api/v1/tenant/settings/company", {"expected_version": v_before, "name": "Settings Check Alpha International", field: value})
            check(f"...and the Organization Service itself refuses '{field}' (422)", s2 == 422, (s2, body2))
        s, body = api("a1", "PATCH", "/api/settings/company", {"name": "No Version"})
        check("a save without the settings version is refused", s == 400)
        s, body = svc("a1", ORG, "PATCH", f"/api/v1/tenant/settings/company?organization_id={org_ids['b']}", {"expected_version": v_before, "address_city": "Lahore"}, {"X-Organization-Id": org_ids["b"]})
        check("a query/header naming organization B changes A's own record only", s == 200 and psql("impex_organizations", f"SELECT address_city FROM organizations WHERE id = '{org_ids['a']}'") == "Lahore" and org_row("b")[0] == "Settings Check Beta")

        print("\n== 4. two administrators saving at once cannot overwrite each other")
        base = version("a")
        outcomes = []
        barrier = threading.Barrier(2)

        def save(who, city):
            barrier.wait()
            s, body = api(who, "PATCH", "/api/settings/company", {"expected_version": base, "address_city": city})
            outcomes.append((s, body))

        threads = [threading.Thread(target=save, args=("a1", "Alpha City")), threading.Thread(target=save, args=("a2", "Beta City"))]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        statuses = sorted(o[0] for o in outcomes)
        check("two saves made from the same version: exactly one wins (200) and the other is told it is out of date (409)", statuses == [200, 409], statuses)
        loser = next(o[1] for o in outcomes if o[0] == 409)
        check("the loser is shown the CURRENT settings instead of overwriting them", loser.get("code") == "version_conflict" and loser["current"]["version"] == base + 1 and loser["current"]["company"]["address_city"] in ("Alpha City", "Beta City"), loser)
        check("the database holds the winner's value and one new version", psql("impex_organizations", f"SELECT address_city FROM organizations WHERE id = '{org_ids['a']}'") == loser["current"]["company"]["address_city"] and version("a") == base + 1)
        base = version("a")
        outcomes.clear()
        barrier2 = threading.Barrier(6)

        def save_pref(i):
            barrier2.wait()
            s, _b = api("a1" if i % 2 == 0 else "a2", "PATCH", "/api/settings/preferences", {"expected_version": base, "default_currency": ["EUR", "GBP", "AED", "PKR", "CAD", "CHF"][i]})
            outcomes.append(s)

        threads = [threading.Thread(target=save_pref, args=(i,)) for i in range(6)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        check("six simultaneous saves from one version: one wins, five are refused", sorted(outcomes) == [200, 409, 409, 409, 409, 409] and version("a") == base + 1, outcomes)
        s, body = api("a1", "PATCH", "/api/settings/company", {"expected_version": 1, "address_city": "Stale City"})
        check("a save from an old version is refused by name", s == 409 and body.get("code") == "version_conflict")
        psql("impex_organizations", f"UPDATE organizations SET default_currency = 'USD', settings_version = settings_version WHERE id = '{org_ids['a']}'")  # (back to the default for the next section)

        print("\n== 5. business preferences are defaults and presentation, never conversions")
        client_a = make("a1", "/api/sales/clients", {"name": "Acme Settings Ltd"}, "client", "clients", idem=False)
        bolt_a = make("a1", "/api/products", {"sku": "SET-BOLT", "name": "Settings bolt", "unit": "pcs", "costPrice": "5", "sellingPrice": "9.99", "currencyCode": "USD"}, "product", "products", idem=False)
        tenant("a1", "POST", "/api/stock/in", {"product_id": bolt_a["id"], "quantity": "100"}, {"Idempotency-Key": f"sc-{uuid.uuid4()}"})
        made = jbody(tenant("a1", "POST", "/api/sales/delivery-lists", {"clientId": client_a["id"]})[1]).get("list", {})
        tenant("a1", "POST", f"/api/sales/delivery-lists/{made['id']}/items", {"productId": bolt_a["id"], "quantity": "20"})
        tenant("a1", "POST", f"/api/sales/delivery-lists/{made['id']}/ready")
        dlist = jbody(tenant("a1", "GET", f"/api/sales/delivery-lists/{made['id']}")[1]).get("list", {})
        item = next(i for i in dlist["items"] if i["product_id"] == bolt_a["id"])
        dispatch = make("a1", "/api/sales/dispatches", {"deliveryListId": dlist["id"], "lines": [{"deliveryListItemId": item["id"], "quantity": "10"}]}, "dispatch", "dispatches")
        tenant("a1", "POST", f"/api/sales/dispatches/{dispatch['id']}/confirm")
        dispatch_doc = jbody(tenant("a1", "GET", f"/api/sales/dispatches/{dispatch['id']}")[1]).get("dispatch", {})
        line = next(l for l in dispatch_doc.get("lines", []) if l["product_id"] == bolt_a["id"])
        s, inv = api("a1", "POST", "/api/sales/invoices", {"clientId": client_a["id"], "currencyCode": "USD", "lines": [{"dispatchLineId": line["id"], "quantity": "5", "unitPrice": "12.50", "taxRate": "10", "taxLabel": "VAT"}]}, {"Idempotency-Key": f"sc-{uuid.uuid4()}"})
        invoice = inv.get("invoice", {})
        created.add("invoices", invoice.get("id"))
        s2, issued = api("a1", "POST", f"/api/sales/invoices/{invoice['id']}/issue")
        s3, paid = api("a1", "POST", f"/api/sales/invoices/{invoice['id']}/payments", {"amount": "25.00", "method": "bank_transfer"}, {"Idempotency-Key": f"pay-{uuid.uuid4()}"})
        supplier = make("a1", "/api/purchasing/suppliers", {"name": "Acme Supplies"}, "supplier", "suppliers", idem=False)
        _s, po = api("a1", "POST", "/api/purchasing/purchase-orders", {"supplierId": supplier["id"], "currencyCode": "USD"}, {"Idempotency-Key": f"sc-{uuid.uuid4()}"})
        order = po.get("order", {})
        api("a1", "POST", f"/api/purchasing/purchase-orders/{order['id']}/lines", {"productId": bolt_a["id"], "quantity": "10", "unitPrice": "2.00"})
        api("a1", "POST", f"/api/purchasing/purchase-orders/{order['id']}/order")
        check("an issued USD invoice with a partial payment, a placed USD purchase order and a confirmed dispatch exist", invoice.get("id") and s2 == 200 and s3 in (200, 201) and order.get("id") and dispatch_doc.get("status") == "confirmed", (s, s2, s3))
        snap = (sales_state(org_ids["a"]), inventory_state(org_ids["a"]), purchasing_state(org_ids["a"]))
        check("the snapshot has real content", snap[0][0] and "USD" in snap[0][0] and snap[0][1] and snap[1][0] and snap[2], snap)
        seller_before = psql("impex_sales", f"SELECT seller_name FROM invoices WHERE id = '{invoice['id']}'")
        base = version("a")
        s, body = api("a1", "PATCH", "/api/settings/preferences", {"expected_version": base, "default_currency": "pkr", "timezone": "Asia/Karachi", "date_format": "DD/MM/YYYY", "number_format": "indian"})
        check("the default currency, time zone, date format and number format are saved (200)", s == 200 and prefs_row("a")[:4] == ["PKR", "Asia/Karachi", "DD/MM/YYYY", "indian"], (s, body, prefs_row("a")))
        s, body = api("a1", "PATCH", "/api/settings/company", {"expected_version": version("a"), "name": "Settings Check Alpha Renamed"})
        check("...and the company is renamed after the invoice was issued", s == 200)
        check("NOTHING recorded was converted or rewritten: invoices, payments, dispatches, stock, products and purchase orders are exactly as before",
              (sales_state(org_ids["a"]), inventory_state(org_ids["a"]), purchasing_state(org_ids["a"])) == snap, "changed")
        check("the issued invoice is still in USD with the same totals, and its seller name snapshot is the name it was issued under (not the new one)",
              psql("impex_sales", f"SELECT currency_code || '|' || total::text || '|' || paid_total::text FROM invoices WHERE id = '{invoice['id']}'") == "USD|68.7500|25.0000" and psql("impex_sales", f"SELECT seller_name FROM invoices WHERE id = '{invoice['id']}'") == seller_before and "Renamed" not in seller_before, seller_before)
        check("the recorded payment keeps its own currency", psql("impex_sales", f"SELECT currency_code FROM invoice_payments WHERE invoice_id = '{invoice['id']}'") == "USD")
        s, html, _ = page("a1", "/settings")
        check("Settings shows the saved choices as selected", all(re.search(rf'<option value="{re.escape(o)}" selected', html) for o in ("PKR", "Asia/Karachi", "DD/MM/YYYY", "indian")))
        s, html, _ = page("a1", f"/invoices/new?client={client_a['id']}")
        check("a NEW invoice starts in the default currency (PKR)", s == 200 and re.search(r'value="PKR"', html), s)
        s, html, _ = page("a1", f"/invoices/{invoice['id']}")
        check("the ISSUED invoice still shows its own currency (USD), not the new default", s == 200 and "USD" in html and not re.search(r"68[.,]75 PKR", html))
        for label, body in (("an unknown currency", {"default_currency": "USS"}), ("a currency of the wrong length", {"default_currency": "DOLLAR"}), ("an unknown time zone", {"timezone": "Mars/Olympus"}), ("a path as a time zone", {"timezone": "../../etc/passwd"}),
                            ("an unknown date format", {"date_format": "DD-MM-YYYY"}), ("an unknown number format", {"number_format": "weird"})):
            before_prefs = prefs_row("a")
            s, body = api("a1", "PATCH", "/api/settings/preferences", {"expected_version": version("a"), **body})
            check(f"{label} is refused (400) and the preferences are unchanged", s == 400 and prefs_row("a") == before_prefs, (s, body))
        check("the database itself refuses nonsense preferences", "violates check constraint" in psql_with_errors("impex_organizations", f"UPDATE organizations SET date_format = 'weird' WHERE id = '{org_ids['a']}'"))
        check("preferences are in the history", {r[1] for r in history_rows("a") if r[0] == "preferences"} == {"default_currency", "timezone", "date_format", "number_format"})

        print("\n== 6. company branding: the existing logo storage, replaced and removed from Settings")
        logo1, logo2 = make_png(300, 200, (40, 120, 90)), make_png(260, 260, (200, 60, 60))
        files_before = logo_files()
        s, body = upload("a1", "a", "first.png", "image/png", logo1)
        key1 = psql("impex_organizations", f"SELECT coalesce(logo_storage_key, '') FROM organizations WHERE id = '{org_ids['a']}'")
        stored_keys.append(key1)
        check("a valid PNG is accepted (200) and stored under an unpredictable server-made key", s == 200 and body["settings"]["branding"]["has_logo"] and bool(KEY_RE.match(key1)) and "first" not in key1, (s, key1))
        check("exactly one new file exists on the persistent logo volume", len([f for f in logo_files() if f not in files_before]) == 1)
        s, data, _, _ = tenant("a1", "GET", "/api/organization/logo")
        check("the logo is served to its own organization as a plain PNG", s == 200 and data[:8] == b"\x89PNG\r\n\x1a\n")
        s, html, _ = page("a1", "/")
        version_a = body["settings"]["branding"]["logo_version"]
        check("the portal header shows the logo through the versioned route (no stale copy)", f"/api/organization/logo?v={version_a}" in html)
        s, body = upload("a1", "a", "second.png", "image/png", logo2)
        key2 = psql("impex_organizations", f"SELECT coalesce(logo_storage_key, '') FROM organizations WHERE id = '{org_ids['a']}'")
        stored_keys.append(key2)
        check("replacing swaps the file and the version, and deletes the old file", s == 200 and key2 != key1 and body["settings"]["branding"]["logo_version"] != version_a and len([f for f in logo_files() if f not in files_before]) == 1, (key1, key2))
        for label, name, ctype, data in (("an SVG (can carry script)", "l.svg", "image/svg+xml", SVG), ("HTML pretending to be a PNG", "l.png", "image/png", b"<html><script>alert(1)</script></html>"),
                                         ("a GIF", "l.gif", "image/gif", b"GIF89a" + b"\x00" * 100), ("a picture that is too small", "l.png", "image/png", make_png(32, 32)), ("a truncated PNG", "l.png", "image/png", logo1[:100]), ("an empty file", "l.png", "image/png", b"")):
            s, body = upload("a1", "a", name, ctype, data)
            check(f"{label} is refused and the current logo is untouched", s in (400, 413, 415, 422) and psql("impex_organizations", f"SELECT logo_storage_key FROM organizations WHERE id = '{org_ids['a']}'") == key2, (s, body))
        s, body = upload("a1", "a", "stale.png", "image/png", logo1, expected=1)
        check("a logo change from an old version is refused (409) and leaves no stray file", s == 409 and len([f for f in logo_files() if f not in files_before]) == 1, (s, body))
        s, data, _, _ = tenant("b1", "GET", "/api/organization/logo")
        check("organization B cannot be given A's logo", s == 404)
        s, data, _, _ = call(TENANT_PORTAL, "GET", "/api/organization/logo")
        check("without a session the logo is 401", s == 401)
        dump = repr(history_rows("a"))
        check("the history records only 'added'/'replaced', never a storage key", key2 not in dump and key1 not in dump and any(r[1] == "logo" and r[3] == "replaced" for r in history_rows("a")))
        if not args.skip_outage:
            docker("compose", "up", "-d", "--force-recreate", "--no-deps", "organization-service")
            wait_health(ORG)
            check("the logo survives the RECREATION of the Organization Service container (persistent volume)", wait_until(lambda: tenant("a1", "GET", "/api/organization/logo")[0] == 200, 40) and any(f.endswith(key2.split("/")[1]) for f in logo_files()))
        s, body = api("a1", "DELETE", f"/api/settings/logo?expected_version={version('a')}")
        check("removing the logo (200) clears it, deletes the file and falls back to the monogram", s == 200 and body["settings"]["branding"]["has_logo"] is False and key2 not in "".join(logo_files()) and tenant("a1", "GET", "/api/organization/logo")[0] == 404, (s, body))
        s, html, _ = page("a1", "/")
        check("the header then shows the monogram, not an image", "/api/organization/logo" not in html and "SC" in html)
        check("the old invoice is untouched by all of that", sales_state(org_ids["a"])[0] == snap[0][0])

        print("\n== 7. the administrator's own profile")
        a2_before = psql("impex_auth", f"SELECT full_name || '|' || email || '|' || role || '|' || organization_id || '|' || is_active::text FROM users WHERE id = '{user_ids['a2']}'")
        a1_before = psql("impex_auth", f"SELECT email || '|' || role || '|' || organization_id FROM users WHERE id = '{user_ids['a1']}'")
        s, body = api("a1", "PATCH", "/api/settings/profile", {"fullName": "  Olivia   Owner-Smith ", "role": "super-admin", "email": "evil@example.org", "organization_id": org_ids["b"], "user_id": user_ids["a2"], "password": "N3w!Passphrase#1"})
        check("A1 changes their own name (200)", s == 200 and body["user"]["full_name"] == "Olivia Owner-Smith", (s, body))
        check("only the name changed: role, e-mail, organization and password are untouched", psql("impex_auth", f"SELECT email || '|' || role || '|' || organization_id FROM users WHERE id = '{user_ids['a1']}'") == a1_before and call(AUTH, "POST", "/api/v1/auth/login", {"email": emails["a1"], "password": password})[0] == 200)
        check("another administrator (A2) was not touched, even though their id was sent", psql("impex_auth", f"SELECT full_name || '|' || email || '|' || role || '|' || organization_id || '|' || is_active::text FROM users WHERE id = '{user_ids['a2']}'") == a2_before)
        check("the header and the Settings page show the new name at once", "Olivia Owner-Smith" in page("a1", "/")[1] and "Olivia Owner-Smith" in page("a1", "/settings")[1])
        check("A2 still sees their own name", "Alan Admin" in page("a2", "/")[1])
        sign_out("a1")
        sign_in("a1", emails["a1"])
        check("the saved name is shown on the next login", "Olivia Owner-Smith" in page("a1", "/")[1])
        for bad in ("", "A", "<b>x</b>", "Jane 3rd", "x" * 101):
            s, body = api("a1", "PATCH", "/api/settings/profile", {"fullName": bad})
            check(f"the name {bad[:20]!r} is refused (400)", s == 400)
        s, body = svc("a1", AUTH, "PATCH", "/api/v1/auth/me/profile", {"full_name": "Olivia", "role": "super-admin"})
        check("the Auth Service itself refuses a profile update that names a role (422)", s == 422, (s, body))
        s, body = svc("sa", AUTH, "PATCH", "/api/v1/auth/me/profile", {"full_name": "Hijack"})
        check("a Super Admin cannot use the tenant profile route (403)", s == 403, (s, body))

        print("\n== 8. enabled modules, requests, and what a request can never do")
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = (module_key IN ('inventory', 'purchasing')) WHERE organization_id = '{org_ids['a']}'")
        s, html, _ = page("a1", "/settings")
        check("the module list shows Inventory and Purchasing enabled, Sales and Finance not enabled, with the dependencies explained",
              re.search(r'data-module="inventory" data-enabled="true"', html) and re.search(r'data-module="purchasing" data-enabled="true"', html) and re.search(r'data-module="sales" data-enabled="false"', html)
              and re.search(r'data-module="finance" data-enabled="false"', html) and "Planned: not available yet" not in html and "Purchasing and Sales both need Inventory" in html)
        check("Request access is offered for the modules that are not enabled (Sales, Finance), and not for the enabled ones", 'href="/support/new?module=sales"' in html and 'href="/support/new?module=inventory"' not in html and 'href="/support/new?module=finance"' in html)
        check("nothing on the page can enable a module", not re.search(r'<input[^>]*type="checkbox"', html) and "Enable</button>" not in html)
        mods_before = psql("impex_organizations", f"SELECT string_agg(module_key || ':' || enabled::text, ',' ORDER BY module_key) FROM organization_modules WHERE organization_id = '{org_ids['a']}'")
        s, html, _ = page("a1", "/support/new?module=sales")
        check("Request access opens a Change Request, pre-filled with fixed wording", s == 200 and "Request to activate the Sales module" in html and "change_request" in html)
        s, html, _ = page("a1", "/support/new?change=tax_id")
        check("Request change opens one for the registered fact", s == 200 and "Request to change our tax registration number" in html)
        s, body = api("a1", "POST", "/api/support/tickets", {"subject": "Request to activate the Sales module", "priority": "normal", "message": "Please enable the Sales module for our organization."}, {"Idempotency-Key": f"sc-{uuid.uuid4()}"})
        ticket = (body or {}).get("ticket", {})
        created.add("tickets", ticket.get("id"))
        check("submitting the request opens a ticket (201)", s == 201 and ticket.get("ticket_number"), (s, body))
        check("the ticket changed NOTHING: the modules are exactly as before, and no module history exists", psql("impex_organizations", f"SELECT string_agg(module_key || ':' || enabled::text, ',' ORDER BY module_key) FROM organization_modules WHERE organization_id = '{org_ids['a']}'") == mods_before
              and psql("impex_organizations", f"SELECT count(*) FROM organization_module_history WHERE organization_id = '{org_ids['a']}' AND action IN ('enabled', 'disabled')") == "0")
        check("an organization administrator cannot change modules through any route", all(call(ORG, m, "/api/v1/tenant/modules", {"modules": ["sales"]}, bearer(tokens["a1"]))[0] in (404, 405) for m in ("PUT", "POST", "PATCH", "DELETE")) and call(ORG, "PUT", f"/api/v1/organizations/{org_ids['a']}/modules", {"changes": {"sales": True}, "expected_revision": 0}, bearer(tokens["a1"]))[0] == 403)
        psql("impex_organizations", f"UPDATE organization_modules SET enabled = true WHERE organization_id = '{org_ids['a']}' AND module_key IN ('inventory', 'purchasing', 'sales')")

        print("\n== 9. organizations stay apart")
        check("B's company, version and preferences are untouched by everything done to A", org_row("b")[0] == "Settings Check Beta" and version("b") == 1 and prefs_row("b")[:4] == ["USD", "UTC", "YYYY-MM-DD", "comma_dot"])
        s, html, _ = page("b1", "/settings")
        check("B1's Settings shows B's own data only", "Settings Check Beta" in html and "Settings Check Alpha" not in html and "Olivia" not in html and "Harbour Road" not in html and "alpha-check.example" not in html)
        check("B's history is empty and A's is not shown to B", history_rows("b") == [] and svc("b1", ORG, "GET", "/api/v1/tenant/settings/history")[1] == {"items": [], "total": 0})
        s, body = svc("b1", ORG, "PATCH", "/api/v1/tenant/settings/company", {"expected_version": 1, "organization_id": org_ids["a"], "name": "Hijack"})
        check("B1 naming organization A in a body is refused (422)", s == 422 and org_row("a")[0] == "Settings Check Alpha Renamed")
        s, body = svc("sa", ORG, "GET", "/api/v1/tenant/settings")
        check("a Super Admin token is not a tenant: Settings is refused (403)", s == 403, (s, body))
        s, data, _, loc = call(TENANT_PORTAL, "GET", "/settings", cookies={"impex_tenant_session": tokens["sa"]})
        check("a Super Admin token in the tenant cookie does not open /settings (redirect to login)", is_redirect(s) and "/login" in loc, (s, loc))
        s, data, _, loc = call(TENANT_PORTAL, "GET", "/settings")
        check("without a session /settings redirects to login", is_redirect(s) and "/login" in loc)

        print("\n== 10. first-time setup: not restarted by Settings, not bypassed by calling the services directly")
        s, html, loc = page("c1", "/settings")
        check("an unfinished organization's /settings goes to /setup", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        s, body = svc("c1", ORG, "GET", "/api/v1/tenant/settings")
        check("the Settings API refuses it too (403 setup_required)", s == 403 and body["detail"]["code"] == "setup_required", (s, body))
        check("Help & Support and the setup itself stay open", page("c1", "/support")[0] == 200 and page("c1", "/setup")[0] == 200 and svc("c1", SUPPORT, "GET", "/api/v1/support/tickets")[0] == 200)
        for label, port, method, path, body in (("Inventory (list)", INVENTORY, "GET", "/api/v1/inventory/products", None), ("Inventory (record stock)", INVENTORY, "POST", "/api/v1/inventory/stock/in", {"product_id": "00000000-0000-4000-8000-000000000000", "quantity": "1"}),
                                                ("Sales (list)", SALES, "GET", "/api/v1/sales/clients", None), ("Sales (create a client)", SALES, "POST", "/api/v1/sales/clients", {"name": "Sneaky"}),
                                                ("Purchasing (list)", PURCHASING, "GET", "/api/v1/purchasing/suppliers", None), ("Purchasing (create a supplier)", PURCHASING, "POST", "/api/v1/purchasing/suppliers", {"name": "Sneaky"})):
            s, resp = svc("c1", port, method, path, body)
            check(f"{label}: called DIRECTLY by an administrator who has not finished setup: 403 setup_required", s == 403 and resp["detail"]["code"] == "setup_required", (s, resp))
        check("nothing was created by those attempts", psql("impex_sales", f"SELECT count(*) FROM clients WHERE organization_id = '{org_ids['c']}'") == "0" and psql("impex_purchasing", f"SELECT count(*) FROM suppliers WHERE organization_id = '{org_ids['c']}'") == "0" and psql("impex_inventory", f"SELECT count(*) FROM stock_movements WHERE organization_id = '{org_ids['c']}'") == "0")
        # a configured organization whose NEW administrator has not confirmed their profile
        psql("impex_auth", f"UPDATE users SET profile_setup_completed_at = NULL WHERE id = '{user_ids['a2']}'")
        s, resp = svc("a2", INVENTORY, "GET", "/api/v1/inventory/products")
        check("a configured organization's administrator whose own profile is unconfirmed is refused directly too (403 setup_required)", s == 403 and resp["detail"]["code"] == "setup_required", (s, resp))
        s, html, loc = page("a2", "/settings")
        check("...and /settings sends them to the short profile step", is_redirect(s) and loc.endswith("/setup"), (s, loc))
        psql("impex_auth", f"UPDATE users SET profile_setup_completed_at = now() WHERE id = '{user_ids['a2']}'")
        check("once confirmed they are served again", svc("a2", INVENTORY, "GET", "/api/v1/inventory/products")[0] == 200)
        # complete C's wizard through the real routes, then use Settings
        s, _ = api("c1", "PUT", "/api/setup/company", {"companyName": "Settings Check Gamma Ltd"})
        logo_body, logo_type = multipart({}, "g.png", "image/png", make_png(220, 220, (30, 30, 160)))
        s_logo = tenant("c1", "POST", "/api/setup/logo", raw=logo_body, content_type=logo_type)[0]
        stored_keys.append(psql("impex_organizations", f"SELECT coalesce(logo_storage_key, '') FROM organizations WHERE id = '{org_ids['c']}'"))
        s_prof, _ = api("c1", "PUT", "/api/setup/profile", {"fullName": "Cora Newcomer"})
        s_done, body_done = api("c1", "POST", "/api/setup/complete", {"fullName": "Cora Newcomer", "companyName": "Settings Check Gamma Ltd"})
        check("organization C completes the first-time wizard through the real routes", s == 200 and s_logo == 200 and s_prof == 200 and s_done == 200 and org_row("c")[6] == "completed", (s, s_logo, s_prof, s_done))
        completed_at = org_row("c")[7]
        s, html, loc = page("c1", "/settings")
        check("now /settings opens, and it shows the company name and logo saved during onboarding (reused, not duplicated)", s == 200 and "Settings Check Gamma Ltd" in html and "No logo: the monogram is shown" not in html and "/api/organization/logo?v=" in html, (s, loc))
        s, body = api("c1", "PATCH", "/api/settings/company", {"expected_version": version("c"), "name": "Settings Check Gamma Group", "address_city": "Leeds"})
        check("an update after onboarding works", s == 200)
        check("it never restarts the wizard or touches the completion: still completed, same completion time", org_row("c")[6] == "completed" and org_row("c")[7] == completed_at)
        s, html, loc = page("c1", "/")
        check("the dashboard still opens (no redirect to /setup) and shows the new name", s == 200 and "Settings Check Gamma Group" in html, (s, loc))
        check("the first-time wizard endpoints still refuse a completed organization (409)", svc("c1", ORG, "PUT", "/api/v1/tenant/onboarding/company", {"name": "Wizard Rename"})[0] == 409)

        if args.skip_outage:
            print("\n(skipped: outage checks - run without --skip-outage)")
        else:
            print("\n== 11. an outage loses nothing and is recoverable")
            keep = (org_row("a"), version("a"))
            docker("compose", "stop", "organization-service")
            try:
                s, html, _ = page("a1", "/settings")
                check("with the Organization Service down, Settings shows a recoverable message instead of data", s == 200 and ("temporarily unavailable" in html or "load your workspace" in html) and "Harbour Road" not in html, s)
                s, body = api("a1", "PATCH", "/api/settings/company", {"expected_version": keep[1], "address_city": "Outage City"})
                check("a save during the outage is refused with a clear message (503) and nothing is half-done", s in (503, 502) and "Nothing was changed" in json.dumps(body), (s, body))
                s, body = api("a1", "PATCH", "/api/settings/preferences", {"expected_version": keep[1], "default_currency": "EUR"})
                check("so is a preferences save (503)", s in (503, 502))
            finally:
                docker("compose", "start", "organization-service")
                wait_health(ORG)
            check("when it is back, nothing changed meanwhile", wait_until(lambda: version("a") == keep[1], 30) and org_row("a") == keep[0])
            s, body = api("a1", "PATCH", "/api/settings/company", {"expected_version": version("a"), "address_city": "After Outage"})
            check("the SAME save, retried, now succeeds", s == 200 and psql("impex_organizations", f"SELECT address_city FROM organizations WHERE id = '{org_ids['a']}'") == "After Outage", (s, body))

        print("\n== 12. the history is permanent")
        out = psql_with_errors("impex_organizations", f"UPDATE organization_settings_history SET new_value = 'x' WHERE organization_id = '{org_ids['a']}'")
        check("a history entry cannot be changed", "append-only" in out, out)
        out = psql_with_errors("impex_organizations", f"DELETE FROM organization_settings_history WHERE organization_id = '{org_ids['a']}'")
        check("a history entry cannot be deleted", "append-only" in out and len(history_rows("a")) > 5, out)
        check("each entry names the acting administrator", all(r[4] for r in history_rows("a")) and {r[4] for r in history_rows("a")} <= {emails["a1"], emails["a2"]})
        dump = json.dumps(svc("a1", ORG, "GET", "/api/v1/tenant/settings/history?limit=100")[1]).lower()
        check("no password, token or key appears in the history", not any(w in dump for w in ("password", "bearer", "token", "secret", key1.lower(), key2.lower())))

        print("\n== 13. nothing that existed before was touched")
        mine = ", ".join(f"'{o}'" for o in org_ids.values())
        now_state = psql("impex_organizations", f"SELECT coalesce(string_agg(id || ':' || name || ':' || slug || ':' || contact_email || ':' || setup_status || ':' || settings_version::text || ':' || default_currency || ':' || timezone || ':' || date_format || ':' || number_format || ':' || coalesce(logo_storage_key, '') || ':' || coalesce(contact_phone, '') || ':' || coalesce(website, ''), ',' ORDER BY id), '') FROM organizations WHERE id NOT IN ({mine})")
        check("every pre-existing organization is exactly as it was (name, slug, contact, setup state, preferences, logo, version)", now_state == existing_before, "differs")
        check("the number of pre-existing organizations is unchanged", psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id NOT IN ({mine})") == existing_count)
        check("the pre-existing organizations have the migration's defaults (they can open Settings at once)", psql("impex_organizations", f"SELECT count(*) FROM organizations WHERE id NOT IN ({mine}) AND (default_currency <> 'USD' OR timezone <> 'UTC' OR setup_status <> 'completed')") == "0")
        check("no history was written for them", psql("impex_organizations", f"SELECT count(*) FROM organization_settings_history WHERE organization_id NOT IN ({mine})") == existing_history)
    finally:
        print("\n== cleanup (exactly the rows and files this run created, by id)")
        orgs = created.get("organizations")
        users = created.get("users")
        left = {}
        keys = [k for k in stored_keys if k and KEY_RE.match(k)]
        if orgs:
            more = psql("impex_organizations", "SELECT logo_storage_key FROM organizations WHERE id IN (" + ", ".join(f"'{o}'" for o in orgs) + ") AND logo_storage_key IS NOT NULL").splitlines()
            keys += [k for k in more if KEY_RE.match(k) and k not in keys]
        for key_ in keys:
            docker("exec", "impex-organization-service", "rm", "-f", f"/data/logos/{key_}")
        if orgs:
            ticket_ids = [r for r in psql("impex_support", "SELECT id FROM support_tickets WHERE organization_id IN (" + ", ".join(f"'{o}'" for o in orgs) + ")").splitlines() if UUID_RE.match(r)]
            if ticket_ids:
                for table, column in (("support_ticket_events", "ticket_id"), ("support_email_outbox", "ticket_id"), ("support_requests", "ticket_id"), ("support_messages", "ticket_id"), ("support_tickets", "id")):
                    left[table] = delete_exact(psql, "impex_support", table, ticket_ids, column, ledger=True)
            left["support requests (by scope)"] = delete_exact(psql, "impex_support", "support_requests", orgs + users, "scope_id", ledger=True)
            if counter_before.isdigit() and psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE ticket_number > 'SUP-' || lpad('{int(counter_before)}', 6, '0')") == "0":
                psql("impex_support", f"UPDATE support_counters SET last_number = {int(counter_before)} WHERE name = 'ticket'")
        for table, column, ledger in (
            ("goods_receipt_lines", "organization_id", True), ("goods_receipt_requests", "organization_id", False), ("goods_receipts", "organization_id", True), ("goods_receipt_counters", "organization_id", False),
            ("purchase_order_lines", "organization_id", True), ("purchase_order_requests", "organization_id", False), ("purchase_orders", "organization_id", True), ("purchase_order_counters", "organization_id", False), ("suppliers", "organization_id", False),
        ):
            left[table] = delete_exact(psql, "impex_purchasing", table, orgs, column, ledger=ledger)
        for table, ledger in (("invoice_payments", True), ("invoice_allocations", True), ("invoice_lines", True), ("invoice_requests", False), ("invoices", True), ("invoice_counters", False), ("dispatch_lines", True), ("dispatch_requests", False), ("dispatches", True), ("dispatch_counters", False),
                              ("delivery_list_items", True), ("delivery_lists", False), ("delivery_list_counters", False), ("clients", False)):
            left[table] = delete_exact(psql, "impex_sales", table, orgs, "organization_id", ledger=ledger)
        for table, ledger in (("stock_movements", True), ("stock_balances", False), ("stock_operations", False), ("products", False)):
            left[table] = delete_exact(psql, "impex_inventory", table, orgs, "organization_id", ledger=ledger)
        left["organizations"] = delete_exact(psql, "impex_organizations", "organizations", orgs)
        left["users"] = delete_exact(psql, "impex_auth", "users", users)
        remaining_files = [f for f in logo_files() if any(f.endswith(k.split("/")[1]) for k in keys)] if keys else []
        print(f"deleted rows belonging to {len(orgs)} organizations, {len(users)} users and {len(keys)} logo files")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {x}" for k, x in left.items()) + f"; logo files still on the volume: {len(remaining_files)}")
        print(f"settings history rows now: {psql('impex_organizations', 'SELECT count(*) FROM organization_settings_history')} (before the run: {existing_history})")

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
