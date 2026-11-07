"""Organization Settings (Step 20): company profile, branding and business preferences.

Two configured organizations (Alpha, Beta), one still in first-time setup (Gamma) and one inactive. The Auth Service is a stand-in keyed by
bearer token; logos go to a temporary directory through the same storage interface production uses. Everything else is real: the database is
built from the migrations, and the history trigger, the row lock and the version check are the production ones.
"""
import io
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from app.auth import get_auth_client
from app.database import get_database_url
from app.main import app
from app.models import Organization
from app.storage import LocalLogoStorage, get_logo_storage

from conftest import alembic_config, fake_auth_client

SETTINGS = "/api/v1/tenant/settings"
COMPANY, PREFS, LOGO, HISTORY = f"{SETTINGS}/company", f"{SETTINGS}/preferences", f"{SETTINGS}/logo", f"{SETTINGS}/history"
TENANT_ORG = "/api/v1/tenant/organization"
LOGO_URL = "/api/v1/tenant/organization/logo"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def account(role, organization_id, **overrides):
    return {
        "id": str(uuid.uuid4()), "email": f"{role}@example.org", "full_name": f"Test {role}", "role": role,
        "organization_id": organization_id, "is_active": True, "created_at": "2026-11-04T00:00:00+00:00", **overrides,
    }


def picture(fmt="PNG", size=(300, 200), color=(40, 120, 90)):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format=fmt)
    return out.getvalue()


PNG, JPEG, WEBP = picture("PNG"), picture("JPEG"), picture("WEBP")


@pytest.fixture
def tenants(session_factory):
    done = datetime.now(timezone.utc)
    with session_factory() as db:
        alpha = Organization(name="Alpha Trading", slug="alpha-trading", country_code="DE", tax_identifier="DE111111111", contact_email="ops@alpha.example",
                             primary_admin_email="owner@alpha.example", setup_status="completed", setup_completed_at=done)
        beta = Organization(name="Beta Logistics", slug="beta-logistics", country_code="FR", contact_email="ops@beta.example", setup_status="completed", setup_completed_at=done)
        gamma = Organization(name="Gamma Ltd", slug="gamma-ltd", country_code="GB", contact_email="ops@gamma.example")  # first-time setup still to do
        dormant = Organization(name="Dormant Co", slug="dormant-co", country_code="NL", contact_email="ops@dormant.example", setup_status="completed", setup_completed_at=done, is_active=False)
        db.add_all([alpha, beta, gamma, dormant])
        db.commit()
        return {k: v for k, v in (("alpha", alpha), ("beta", beta), ("gamma", gamma), ("dormant", dormant))}


@pytest.fixture
def tokens(tenants):
    a, b, g, d = (str(tenants[k].id) for k in ("alpha", "beta", "gamma", "dormant"))
    return {
        "alpha-1": (200, account("organization-admin", a, email="admin@alpha.example", full_name="Alice One")),
        "alpha-2": (200, account("organization-admin", a, email="second@alpha.example", full_name="Bob Two")),
        "beta-1": (200, account("organization-admin", b, email="admin@beta.example", full_name="Bea One")),
        "gamma-1": (200, account("organization-admin", g)),
        "dormant-1": (200, account("organization-admin", d)),
        "super": (200, account("super-admin", None)),
        "super-with-org": (200, account("super-admin", a)),
        "regular": (200, account("user", a)),
        "disabled": (200, account("organization-admin", a, is_active=False)),
        "expired": (401, {"detail": "Invalid or expired token"}),
        "auth-broken": (500, {"detail": "boom"}),
    }


@pytest.fixture
def storage(tmp_path):
    store = LocalLogoStorage(str(tmp_path / "logos"))
    app.dependency_overrides[get_logo_storage] = lambda: store
    yield store
    app.dependency_overrides.pop(get_logo_storage, None)


@pytest.fixture
def client(tokens, storage):
    auth = fake_auth_client(tokens)
    app.dependency_overrides[get_auth_client] = lambda: auth
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)


def row(session_factory, tenants, name):
    with session_factory() as db:
        return db.get(Organization, tenants[name].id)


def read(client, who="alpha-1"):
    response = client.get(SETTINGS, headers=bearer(who))
    assert response.status_code == 200, response.text
    return response.json()


def patch(client, url, body, who="alpha-1", version=None):
    return client.patch(url, json={"expected_version": version if version is not None else read(client, who)["version"], **body}, headers=bearer(who))


def history(session_factory, tenants, name="alpha"):
    with session_factory() as db:
        return db.execute(text("SELECT section, field, old_value, new_value, changed_by_name, changed_by_email, source, version FROM organization_settings_history WHERE organization_id = :o ORDER BY seq"), {"o": str(tenants[name].id)}).all()


def files(storage):
    return sorted(p for p in Path(storage.root).rglob("*") if p.is_file())


# ============================================================================================================== reading
class TestReading:
    def test_the_settings_come_from_the_organizations_own_record(self, client, tenants):
        body = read(client)
        assert body["version"] == 1 and body["setup_status"] == "completed"
        assert body["company"]["name"] == "Alpha Trading" and body["company"]["contact_email"] == "ops@alpha.example"
        assert body["company"]["contact_phone"] is None and body["company"]["website"] is None
        assert body["restricted"] == {"id": str(tenants["alpha"].id), "slug": "alpha-trading", "country_code": "DE", "tax_identifier": "DE111111111", "owner_email": "owner@alpha.example", "status": "Active", "created_at": body["restricted"]["created_at"]}
        assert body["branding"] == {"has_logo": False, "logo_version": None}
        assert body["preferences"] == {"default_currency": "USD", "timezone": "UTC", "date_format": "YYYY-MM-DD", "number_format": "comma_dot"}

    def test_it_shows_only_the_callers_own_organization(self, client, tenants):
        assert read(client, "beta-1")["company"]["name"] == "Beta Logistics"
        assert read(client, "alpha-2")["company"]["name"] == "Alpha Trading"  # a second administrator of the same organization
        for url in (f"{SETTINGS}?organization_id={tenants['beta'].id}", f"{SETTINGS}?slug=beta-logistics"):
            body = client.get(url, headers={**bearer("alpha-1"), "X-Organization-Id": str(tenants["beta"].id)}).json()
            assert body["company"]["name"] == "Alpha Trading" and body["restricted"]["id"] == str(tenants["alpha"].id)

    def test_the_organization_view_carries_the_preferences_the_portal_formats_with(self, client):
        body = client.get(TENANT_ORG, headers=bearer("alpha-1")).json()
        assert (body["default_currency"], body["timezone"], body["date_format"], body["number_format"], body["settings_version"]) == ("USD", "UTC", "YYYY-MM-DD", "comma_dot", 1)


# ============================================================================================================== company profile
class TestCompanyProfile:
    def test_updating_the_display_name_keeps_the_identity(self, client, session_factory, tenants):
        before = row(session_factory, tenants, "alpha")
        response = patch(client, COMPANY, {"name": "  Alpha   Trading  International  "})
        assert response.status_code == 200, response.text
        assert response.json()["company"]["name"] == "Alpha Trading International" and response.json()["version"] == 2
        after = row(session_factory, tenants, "alpha")
        assert (after.id, after.slug, after.country_code, after.tax_identifier, after.is_active, after.setup_status, after.setup_completed_at) == (before.id, before.slug, before.country_code, before.tax_identifier, before.is_active, before.setup_status, before.setup_completed_at)
        # live branding: the portal reads the name from this very answer
        assert client.get(TENANT_ORG, headers=bearer("alpha-1")).json()["name"] == "Alpha Trading International"
        assert client.get(TENANT_ORG, headers=bearer("alpha-2")).json()["name"] == "Alpha Trading International"

    def test_contact_details_are_validated_normalized_and_saved(self, client, session_factory, tenants):
        response = patch(client, COMPANY, {
            "contact_email": "  Office@Alpha-Trading.EXAMPLE ", "contact_phone": " +92  21 1234567 ", "address_street": " 12  Harbour Road ", "address_city": "Karachi",
            "address_state": "Sindh", "address_postal_code": "74000", "website": "WWW.Alpha-Trading.example/about", "description": "  We import   machine parts.\n\n\n\nSince 1998.  ",
        })
        assert response.status_code == 200, response.text
        company = response.json()["company"]
        assert company == {
            "name": "Alpha Trading", "contact_email": "office@alpha-trading.example", "contact_phone": "+92 21 1234567", "address_street": "12 Harbour Road", "address_city": "Karachi",
            "address_state": "Sindh", "address_postal_code": "74000", "website": "https://www.alpha-trading.example/about", "description": "We import machine parts.\n\nSince 1998.",
        }
        stored = row(session_factory, tenants, "alpha")  # permanently in PostgreSQL: a new request reads it back
        assert (stored.contact_email, stored.address_city, stored.website) == ("office@alpha-trading.example", "Karachi", "https://www.alpha-trading.example/about")
        assert read(client)["company"] == company

    def test_a_partial_update_changes_only_what_is_sent(self, client):
        patch(client, COMPANY, {"contact_phone": "+49 30 1234567", "address_city": "Berlin"})
        patch(client, COMPANY, {"address_city": "Hamburg"})
        company = read(client)["company"]
        assert company["address_city"] == "Hamburg" and company["contact_phone"] == "+49 30 1234567" and company["name"] == "Alpha Trading"

    def test_optional_fields_can_be_cleared_but_required_ones_cannot(self, client):
        patch(client, COMPANY, {"contact_phone": "+49 30 1234567", "website": "https://alpha.example", "description": "x"})
        response = patch(client, COMPANY, {"contact_phone": "", "website": None, "description": "   "})
        assert response.status_code == 200
        assert response.json()["company"]["contact_phone"] is None and response.json()["company"]["website"] is None and response.json()["company"]["description"] is None
        for field in ("name", "contact_email"):
            assert patch(client, COMPANY, {field: None}).status_code == 422
            assert patch(client, COMPANY, {field: "  "}).status_code == 422

    @pytest.mark.parametrize("field,value", [
        ("name", "A"), ("name", "<script>alert(1)</script>"), ("name", "x" * 121), ("name", 5), ("contact_email", "not-an-email"), ("contact_email", "a@b"), ("contact_email", "a b@c.example"),
        ("contact_email", "x@y.example\r\nBcc: spy@evil.example"), ("contact_email", "a@b.example," + "c@d.example"), ("contact_phone", "abc"), ("contact_phone", "12"), ("contact_phone", "+1 555 <b>"),
        ("address_street", "x" * 256), ("address_city", "<b>Karachi</b>"), ("address_state", "x" * 121), ("address_postal_code", "x" * 31), ("website", "javascript:alert(1)"),
        ("website", "ftp://files.example"), ("website", "https://user:pw@evil.example"), ("website", "https://nodot"), ("website", "https://exa mple.com"), ("website", "https://" + "a" * 250 + ".com"),
        ("description", "x" * 1001), ("description", "<img src=x onerror=alert(1)>"), ("description", "bell\x07"), ("address_street", "line\x00break"),
    ])
    def test_invalid_and_malicious_values_are_refused_and_nothing_changes(self, client, session_factory, tenants, field, value):
        before = read(client)
        response = patch(client, COMPANY, {field: value}, version=before["version"])
        assert response.status_code == 422, response.text
        assert read(client) == before  # not even the version moved
        assert history(session_factory, tenants) == []

    def test_a_refused_field_does_not_let_the_valid_ones_through(self, client):
        before = read(client)
        assert patch(client, COMPANY, {"name": "Fine New Name", "contact_email": "broken"}).status_code == 422
        assert read(client) == before

    @pytest.mark.parametrize("field,value", [
        ("id", str(uuid.uuid4())), ("organization_id", str(uuid.uuid4())), ("slug", "hijacked"), ("country_code", "US"), ("tax_identifier", "XX999"), ("is_active", False),
        ("primary_admin_email", "evil@example.org"), ("setup_status", "pending"), ("setup_completed_at", None), ("logo_storage_key", "aa/x.png"), ("settings_version", 99),
        ("default_currency", "EUR"), ("created_at", "2000-01-01T00:00:00+00:00"), ("modules", ["finance"]),
    ])
    def test_restricted_fields_cannot_be_sent_through_the_company_endpoint(self, client, session_factory, tenants, field, value):
        before_row = row(session_factory, tenants, "alpha")
        response = patch(client, COMPANY, {"name": "Alpha Renamed", field: value})
        assert response.status_code == 422, response.text
        after = row(session_factory, tenants, "alpha")
        assert (after.name, after.slug, after.country_code, after.tax_identifier, after.is_active, after.setup_status, after.default_currency) == (before_row.name, before_row.slug, before_row.country_code, before_row.tax_identifier, True, "completed", "USD")

    def test_an_empty_request_is_refused(self, client):
        assert patch(client, COMPANY, {}).status_code == 422

    def test_saving_the_same_values_changes_nothing(self, client, session_factory, tenants):
        response = patch(client, COMPANY, {"name": "Alpha Trading", "contact_email": "ops@alpha.example"})
        assert response.status_code == 200 and response.json()["version"] == 1
        assert history(session_factory, tenants) == []


# ============================================================================================================== preferences
class TestPreferences:
    def test_saving_the_default_currency_timezone_and_display_formats(self, client, session_factory, tenants):
        response = patch(client, PREFS, {"default_currency": "pkr", "timezone": "Asia/Karachi", "date_format": "DD/MM/YYYY", "number_format": "indian"})
        assert response.status_code == 200, response.text
        assert response.json()["preferences"] == {"default_currency": "PKR", "timezone": "Asia/Karachi", "date_format": "DD/MM/YYYY", "number_format": "indian"}
        stored = row(session_factory, tenants, "alpha")
        assert (stored.default_currency, stored.timezone, stored.date_format, stored.number_format) == ("PKR", "Asia/Karachi", "DD/MM/YYYY", "indian")
        assert client.get(TENANT_ORG, headers=bearer("alpha-2")).json()["default_currency"] == "PKR"  # every administrator of the organization sees it

    @pytest.mark.parametrize("currency", ["PKR", "USD", "EUR", "GBP", "AED"])
    def test_the_named_currencies_are_accepted(self, client, currency):
        assert patch(client, PREFS, {"default_currency": currency}).status_code == 200

    @pytest.mark.parametrize("zone", ["Asia/Karachi", "America/New_York", "Europe/London", "UTC"])
    def test_the_named_time_zones_are_accepted(self, client, zone):
        assert patch(client, PREFS, {"timezone": zone}).status_code == 200

    @pytest.mark.parametrize("field,value", [
        ("default_currency", "USS"), ("default_currency", "US"), ("default_currency", "DOLLAR"), ("default_currency", ""), ("default_currency", None), ("default_currency", 5),
        ("timezone", "Mars/Olympus"), ("timezone", "../../etc/passwd"), ("timezone", ""), ("timezone", None), ("timezone", "EST5EDTX"),
        ("date_format", "DD-MM-YYYY"), ("date_format", "yyyy-mm-dd"), ("date_format", None), ("number_format", "1,234.56"), ("number_format", "weird"), ("number_format", None),
    ])
    def test_invalid_preferences_are_refused(self, client, field, value):
        before = read(client)
        assert patch(client, PREFS, {field: value}, version=before["version"]).status_code == 422
        assert read(client) == before

    def test_only_the_preference_fields_are_accepted_there(self, client):
        for field, value in (("name", "Sneaky"), ("slug", "x"), ("contact_email", "a@b.example"), ("organization_id", str(uuid.uuid4()))):
            assert patch(client, PREFS, {"timezone": "UTC", field: value}).status_code == 422

    def test_changing_preferences_never_touches_the_company_data_or_the_setup_state(self, client, session_factory, tenants):
        before = row(session_factory, tenants, "alpha")
        patch(client, PREFS, {"default_currency": "EUR"})
        after = row(session_factory, tenants, "alpha")
        assert (after.name, after.contact_email, after.slug, after.setup_status, after.logo_storage_key) == (before.name, before.contact_email, before.slug, before.setup_status, before.logo_storage_key)

    def test_the_organization_service_holds_no_commercial_record_that_could_be_converted(self, session_factory):
        """Preferences are defaults and presentation. This service has no invoice, order, payment, stock or movement table to rewrite."""
        with session_factory() as db:
            tables = {r[0] for r in db.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"))}
        assert not any(word in name for name in tables for word in ("invoice", "order", "payment", "stock", "movement", "dispatch", "receipt"))


# ============================================================================================================== history
class TestHistory:
    def test_every_changed_field_is_recorded_with_who_and_what(self, client, session_factory, tenants, tokens):
        patch(client, COMPANY, {"name": "Alpha International", "contact_phone": "+49 30 1234567"})
        patch(client, PREFS, {"timezone": "Asia/Karachi"}, who="alpha-2")
        rows = history(session_factory, tenants)
        assert [(r[0], r[1], r[2], r[3]) for r in rows] == [("company", "name", "Alpha Trading", "Alpha International"), ("company", "contact_phone", None, "+49 30 1234567"), ("preferences", "timezone", "UTC", "Asia/Karachi")]
        assert rows[0][4:] == ("Alice One", "admin@alpha.example", "settings", 2) and rows[2][4:] == ("Bob Two", "second@alpha.example", "settings", 3)
        api = client.get(HISTORY, headers=bearer("alpha-1")).json()
        assert api["total"] == 3 and [i["field"] for i in api["items"]] == ["timezone", "contact_phone", "name"]  # newest first
        assert all(i["changed_by_name"] and i["created_at"] and i["source"] == "settings" for i in api["items"])

    def test_fields_saved_together_share_a_batch(self, client):
        patch(client, COMPANY, {"name": "Alpha Two", "address_city": "Berlin"})
        patch(client, COMPANY, {"address_city": "Bonn"})
        items = client.get(HISTORY, headers=bearer("alpha-1")).json()["items"]
        assert len({i["batch_id"] for i in items}) == 2 and len(items) == 3

    def test_no_secret_or_storage_key_is_ever_recorded(self, client, session_factory, tenants, storage):
        client.put(LOGO, files={"file": ("l.png", PNG, "image/png")}, data={"expected_version": "1"}, headers=bearer("alpha-1"))
        stored_key = row(session_factory, tenants, "alpha").logo_storage_key
        dump = repr(history(session_factory, tenants)) + str(client.get(HISTORY, headers=bearer("alpha-1")).json())
        assert stored_key and stored_key not in dump and "Bearer" not in dump and "token" not in dump.lower() and "password" not in dump.lower()

    def test_the_history_is_append_only(self, client, session_factory, tenants):
        patch(client, COMPANY, {"name": "Alpha Two"})
        with session_factory() as db:
            for sql in ("UPDATE organization_settings_history SET new_value = 'x'", "DELETE FROM organization_settings_history"):
                with pytest.raises(DBAPIError) as caught:
                    db.execute(text(sql))
                assert "append-only" in str(caught.value)
                db.rollback()
        assert len(history(session_factory, tenants)) == 1

    def test_the_maintenance_switch_lets_a_throwaway_organization_be_removed(self, client, session_factory, tenants):
        patch(client, COMPANY, {"name": "Alpha Two"})
        with session_factory() as db:
            db.execute(text("BEGIN"))
            db.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
            db.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": str(tenants["alpha"].id)})
            db.commit()
        assert history(session_factory, tenants) == []

    def test_each_organization_sees_only_its_own_history(self, client):
        patch(client, COMPANY, {"name": "Alpha Two"})
        assert client.get(HISTORY, headers=bearer("beta-1")).json() == {"items": [], "total": 0}

    def test_the_history_pages(self, client):
        for i in range(4):
            patch(client, COMPANY, {"address_city": f"City {i}"})
        page = client.get(f"{HISTORY}?limit=2&offset=1", headers=bearer("alpha-1")).json()
        assert page["total"] == 4 and [i["new_value"] for i in page["items"]] == ["City 2", "City 1"]


# ============================================================================================================== concurrency
class TestSimultaneousUpdates:
    def test_a_stale_version_is_refused_with_the_current_settings(self, client, session_factory, tenants):
        stale = read(client)["version"]
        assert patch(client, COMPANY, {"name": "Alpha First"}, who="alpha-2", version=stale).status_code == 200
        response = patch(client, COMPANY, {"name": "Alpha Second"}, who="alpha-1", version=stale)
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "version_conflict" and detail["current"]["company"]["name"] == "Alpha First" and detail["current"]["version"] == 2
        assert row(session_factory, tenants, "alpha").name == "Alpha First"  # the first change was not silently overwritten

    def test_a_version_can_never_be_skipped_ahead(self, client):
        assert patch(client, COMPANY, {"name": "Alpha Two"}, version=7).status_code == 409
        assert patch(client, COMPANY, {"name": "Alpha Two"}, version=0).status_code == 422

    def test_the_version_is_required_everywhere(self, client):
        assert client.patch(COMPANY, json={"name": "No Version"}, headers=bearer("alpha-1")).status_code == 422
        assert client.patch(PREFS, json={"timezone": "UTC"}, headers=bearer("alpha-1")).status_code == 422
        assert client.put(LOGO, files={"file": ("l.png", PNG, "image/png")}, headers=bearer("alpha-1")).status_code == 422
        assert client.delete(LOGO, headers=bearer("alpha-1")).status_code == 422

    def test_two_administrators_saving_from_the_same_version_at_once_only_one_wins(self, tokens, storage, session_factory, tenants):
        app.dependency_overrides[get_auth_client] = lambda: fake_auth_client(tokens)
        try:
            with TestClient(app) as test_client:
                version = read(test_client)["version"]
                barrier = threading.Barrier(2)

                def save(who_and_name):
                    who, name = who_and_name
                    barrier.wait()
                    return patch(test_client, COMPANY, {"name": name}, who=who, version=version).status_code

                with ThreadPoolExecutor(max_workers=2) as pool:
                    outcomes = list(pool.map(save, [("alpha-1", "Alpha One"), ("alpha-2", "Alpha Two")]))
                assert sorted(outcomes) == [200, 409]
                assert row(session_factory, tenants, "alpha").name in ("Alpha One", "Alpha Two")
                assert len(history(session_factory, tenants)) == 1 and read(test_client)["version"] == 2
        finally:
            app.dependency_overrides.pop(get_auth_client, None)

    def test_many_saves_at_once_each_name_the_version_they_saw(self, tokens, storage, session_factory, tenants):
        app.dependency_overrides[get_auth_client] = lambda: fake_auth_client(tokens)
        try:
            with TestClient(app) as test_client:
                version = read(test_client)["version"]
                barrier = threading.Barrier(6)

                def save(i):
                    barrier.wait()
                    return patch(test_client, PREFS, {"default_currency": ["EUR", "GBP", "AED", "PKR", "CAD", "CHF"][i]}, version=version).status_code

                with ThreadPoolExecutor(max_workers=6) as pool:
                    outcomes = list(pool.map(save, range(6)))
                assert outcomes.count(200) == 1 and outcomes.count(409) == 5
                assert read(test_client)["version"] == 2
        finally:
            app.dependency_overrides.pop(get_auth_client, None)

    def test_a_logo_change_and_a_text_change_cannot_overwrite_each_other_either(self, client, storage):
        version = read(client)["version"]
        assert client.put(LOGO, files={"file": ("l.png", PNG, "image/png")}, data={"expected_version": str(version)}, headers=bearer("alpha-1")).status_code == 200
        assert patch(client, COMPANY, {"name": "Late Editor"}, version=version).status_code == 409
        assert len(files(storage)) == 1


# ============================================================================================================== branding
class TestBranding:
    def put(self, client, who, name, data, content_type, version=None):
        return client.put(LOGO, files={"file": (name, data, content_type)}, data={"expected_version": str(version if version is not None else read(client, who)["version"])}, headers=bearer(who))

    @pytest.mark.parametrize("kind,args", [("png", ("l.png", PNG, "image/png")), ("jpeg", ("l.jpg", JPEG, "image/jpeg")), ("webp", ("l.webp", WEBP, "image/webp"))])
    def test_png_jpeg_and_webp_are_accepted_and_stored_as_a_clean_png(self, client, storage, session_factory, tenants, kind, args):
        response = self.put(client, "alpha-1", *args)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["branding"]["has_logo"] is True and body["branding"]["logo_version"] and body["version"] == 2
        key = row(session_factory, tenants, "alpha").logo_storage_key
        assert key and len(files(storage)) == 1 and storage.read(key)[:8] == b"\x89PNG\r\n\x1a\n"
        served = client.get(LOGO_URL, headers=bearer("alpha-2"))
        assert served.status_code == 200 and served.headers["content-type"] == "image/png" and served.headers["x-content-type-options"] == "nosniff"

    def test_replacing_swaps_the_file_the_version_and_leaves_no_orphan(self, client, storage, session_factory, tenants):
        self.put(client, "alpha-1", "a.png", PNG, "image/png")
        first_key, first_version = row(session_factory, tenants, "alpha").logo_storage_key, read(client)["branding"]["logo_version"]
        self.put(client, "alpha-1", "b.jpg", JPEG, "image/jpeg")
        second_key = row(session_factory, tenants, "alpha").logo_storage_key
        assert second_key != first_key and read(client)["branding"]["logo_version"] != first_version  # cached URLs are invalidated
        assert len(files(storage)) == 1 and storage.read(first_key) is None
        assert [(r[1], r[2], r[3]) for r in history(session_factory, tenants)] == [("logo", "none", "added"), ("logo", "present", "replaced")]

    def test_removing_the_logo_falls_back_to_the_monogram(self, client, storage, session_factory, tenants):
        self.put(client, "alpha-1", "a.png", PNG, "image/png")
        response = client.delete(f"{LOGO}?expected_version={read(client)['version']}", headers=bearer("alpha-1"))
        assert response.status_code == 200 and response.json()["branding"] == {"has_logo": False, "logo_version": None}
        assert files(storage) == [] and client.get(LOGO_URL, headers=bearer("alpha-1")).status_code == 404
        stored = row(session_factory, tenants, "alpha")
        assert (stored.logo_storage_key, stored.logo_content_type, stored.logo_updated_at) == (None, None, None)
        assert client.get(TENANT_ORG, headers=bearer("alpha-1")).json()["has_logo"] is False
        # removing again is a harmless no-op
        again = client.delete(f"{LOGO}?expected_version={read(client)['version']}", headers=bearer("alpha-1"))
        assert again.status_code == 200

    def test_the_logo_survives_a_restart_and_a_new_session(self, client, storage, tokens):
        self.put(client, "alpha-1", "a.png", PNG, "image/png")
        key = client.get(LOGO_URL, headers=bearer("alpha-1")).content
        # a "restart": the storage object is rebuilt from the same directory, the app client is new, the administrator is a different session
        fresh = LocalLogoStorage(str(storage.root))
        app.dependency_overrides[get_logo_storage] = lambda: fresh
        with TestClient(app) as restarted:
            assert restarted.get(LOGO_URL, headers=bearer("alpha-2")).content == key
            assert read(restarted, "alpha-2")["branding"]["has_logo"] is True

    @pytest.mark.parametrize("name,data,content_type", [
        ("l.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"),
        ("l.png", b"<html><script>alert(1)</script></html>", "image/png"),
        ("l.png", b"MZ\x90\x00" + b"\x00" * 300, "image/png"),
        ("l.gif", b"GIF89a" + b"\x00" * 100, "image/gif"),
        ("l.pdf", b"%PDF-1.4\n" + b"x" * 100, "application/pdf"),
        ("l.png", PNG[:100], "image/png"),
        ("l.png", picture(size=(32, 32)), "image/png"),
        ("l.png", b"", "image/png"),
        ("l.png", b"\x89PNG\r\n\x1a\n" + os.urandom(2 * 1024 * 1024 + 10), "image/png"),
    ])
    def test_invalid_uploads_are_refused_and_change_nothing(self, client, storage, name, data, content_type):
        before = read(client)
        response = self.put(client, "alpha-1", name, data, content_type, version=before["version"])
        assert response.status_code in (400, 413, 415, 422), response.text
        assert read(client) == before and files(storage) == []

    def test_a_storage_failure_is_a_recoverable_503_and_changes_nothing(self, client, storage, monkeypatch):
        from app.storage import StorageError

        def broken(*_a, **_k):
            raise StorageError("disk full")

        monkeypatch.setattr(LocalLogoStorage, "write", broken)
        before = read(client)
        assert self.put(client, "alpha-1", "a.png", PNG, "image/png", version=before["version"]).status_code == 503
        assert read(client) == before

    def test_a_file_written_for_a_conflicting_upload_is_removed(self, client, storage):
        stale = read(client)["version"]
        patch(client, COMPANY, {"name": "Alpha Two"})
        assert self.put(client, "alpha-1", "a.png", PNG, "image/png", version=stale).status_code == 409
        assert files(storage) == []

    def test_a_logo_is_only_ever_served_to_its_own_organization(self, client, storage):
        self.put(client, "alpha-1", "a.png", PNG, "image/png")
        assert client.get(LOGO_URL, headers=bearer("beta-1")).status_code == 404  # beta has none: it can never be handed alpha's
        assert client.get(LOGO_URL).status_code == 401 and client.get(LOGO_URL, headers=bearer("super")).status_code == 403
        assert self.put(client, "beta-1", "b.png", picture(color=(200, 30, 30)), "image/png").status_code == 200
        assert client.get(LOGO_URL, headers=bearer("alpha-1")).content != client.get(LOGO_URL, headers=bearer("beta-1")).content
        assert len(files(storage)) == 2

    def test_the_first_time_setup_endpoints_still_refuse_a_completed_organization(self, client):
        """Settings did not reopen the wizard: the onboarding endpoints keep their 409, and the state stays completed."""
        assert client.put("/api/v1/tenant/onboarding/company", json={"name": "Wizard Rename"}, headers=bearer("alpha-1")).status_code == 409
        assert client.put("/api/v1/tenant/onboarding/logo", files={"file": ("a.png", PNG, "image/png")}, headers=bearer("alpha-1")).status_code == 409
        assert read(client)["setup_status"] == "completed"


# ============================================================================================================== access
class TestAccess:
    def test_only_a_configured_organizations_administrators_may_use_settings(self, client):
        for url in (SETTINGS, HISTORY):
            assert client.get(url, headers=bearer("gamma-1")).status_code == 403
        response = client.get(SETTINGS, headers=bearer("gamma-1"))
        assert response.json()["detail"]["code"] == "setup_required"
        assert patch(client, COMPANY, {"name": "Gamma Two"}, who="gamma-1", version=1).status_code == 403
        assert patch(client, PREFS, {"timezone": "UTC"}, who="gamma-1", version=1).status_code == 403
        assert client.put(LOGO, files={"file": ("a.png", PNG, "image/png")}, data={"expected_version": "1"}, headers=bearer("gamma-1")).status_code == 403

    def test_a_setup_in_progress_is_never_completed_or_changed_by_settings(self, client, session_factory, tenants):
        client.patch(COMPANY, json={"name": "Gamma Two", "expected_version": 1}, headers=bearer("gamma-1"))
        stored = row(session_factory, tenants, "gamma")
        assert (stored.name, stored.setup_status, stored.setup_completed_at) == ("Gamma Ltd", "pending", None)

    def test_an_inactive_organization_is_refused(self, client):
        assert client.get(SETTINGS, headers=bearer("dormant-1")).status_code == 403
        assert patch(client, COMPANY, {"name": "Dormant Two"}, who="dormant-1", version=1).status_code == 403

    @pytest.mark.parametrize("who,expected", [("super", 403), ("super-with-org", 403), ("regular", 403), ("disabled", 403), ("expired", 401), ("auth-broken", 503), ("nobody", 401)])
    def test_other_people_are_refused_everywhere(self, client, who, expected):
        assert client.get(SETTINGS, headers=bearer(who)).status_code == expected
        assert client.get(HISTORY, headers=bearer(who)).status_code == expected
        assert client.patch(COMPANY, json={"expected_version": 1, "name": "Nope"}, headers=bearer(who)).status_code == expected
        assert client.patch(PREFS, json={"expected_version": 1, "timezone": "UTC"}, headers=bearer(who)).status_code == expected
        assert client.put(LOGO, files={"file": ("a.png", PNG, "image/png")}, data={"expected_version": "1"}, headers=bearer(who)).status_code == expected
        assert client.delete(f"{LOGO}?expected_version=1", headers=bearer(who)).status_code == expected

    def test_no_token_is_refused(self, client):
        assert client.get(SETTINGS).status_code == 401
        assert client.patch(COMPANY, json={"expected_version": 1, "name": "Nope"}).status_code == 401

    def test_settings_do_not_depend_on_the_business_modules(self, client, session_factory, tenants):
        """Help & Support style: settings stay open when Inventory, Purchasing and Sales are all disabled."""
        with session_factory() as db:
            db.execute(text("INSERT INTO organization_modules (organization_id, module_key, enabled) VALUES (:o, 'inventory', false) ON CONFLICT (organization_id, module_key) DO UPDATE SET enabled = false"), {"o": str(tenants["alpha"].id)})
            db.commit()
        assert client.get(TENANT_ORG, headers=bearer("alpha-1")).json()["modules"] == []
        assert read(client)["company"]["name"] == "Alpha Trading"
        assert patch(client, COMPANY, {"address_city": "Berlin"}).status_code == 200

    def test_changing_settings_does_not_change_the_modules(self, client, session_factory, tenants):
        before = client.get(TENANT_ORG, headers=bearer("alpha-1")).json()["modules"]
        patch(client, COMPANY, {"name": "Alpha Two", "website": "https://alpha.example"})
        patch(client, PREFS, {"default_currency": "EUR"})
        assert client.get(TENANT_ORG, headers=bearer("alpha-1")).json()["modules"] == before
        with session_factory() as db:
            assert db.execute(text("SELECT count(*) FROM organization_module_history WHERE organization_id = :o AND action IN ('enabled', 'disabled')"), {"o": str(tenants["alpha"].id)}).scalar() == 0


# ============================================================================================================== tenant isolation
class TestIsolation:
    def test_one_organizations_changes_never_reach_the_other(self, client, session_factory, tenants):
        patch(client, COMPANY, {"name": "Alpha New", "contact_email": "new@alpha.example", "website": "https://alpha.example"})
        patch(client, PREFS, {"default_currency": "PKR", "timezone": "Asia/Karachi", "date_format": "DD/MM/YYYY"})
        beta = read(client, "beta-1")
        assert beta["company"]["name"] == "Beta Logistics" and beta["company"]["website"] is None and beta["version"] == 1
        assert beta["preferences"] == {"default_currency": "USD", "timezone": "UTC", "date_format": "YYYY-MM-DD", "number_format": "comma_dot"}
        assert history(session_factory, tenants, "beta") == []

    def test_a_body_naming_another_organization_is_refused(self, client, session_factory, tenants):
        beta_id = str(tenants["beta"].id)
        assert patch(client, COMPANY, {"name": "Hijack", "organization_id": beta_id}).status_code == 422
        response = client.patch(f"{COMPANY}?organization_id={beta_id}", json={"expected_version": 1, "name": "Alpha Query"}, headers={**bearer("alpha-1"), "X-Organization-Id": beta_id})
        assert response.status_code == 200 and response.json()["restricted"]["id"] == str(tenants["alpha"].id)
        assert row(session_factory, tenants, "beta").name == "Beta Logistics" and row(session_factory, tenants, "alpha").name == "Alpha Query"

    def test_each_organization_has_its_own_version(self, client):
        for _ in range(3):
            patch(client, PREFS, {"default_currency": "EUR"}, version=read(client)["version"])
            patch(client, PREFS, {"default_currency": "USD"}, version=read(client)["version"])
        assert read(client)["version"] == 7 and read(client, "beta-1")["version"] == 1


# ============================================================================================================== migration
class TestMigration:
    NAME = "impex_organizations_settings_migration_test"

    def test_existing_organizations_keep_everything_and_get_the_current_defaults(self):
        admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {self.NAME} WITH (FORCE)"))
            conn.execute(text(f"CREATE DATABASE {self.NAME}"))
        previous = os.environ.get("DB_NAME")
        os.environ["DB_NAME"] = self.NAME
        try:
            command.upgrade(alembic_config(), "0005")  # the schema as it was before this release
            engine = create_engine(get_database_url().set(database=self.NAME))
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO organizations (name, slug, country_code, tax_identifier, contact_email, setup_status, setup_completed_at, logo_storage_key, logo_content_type, logo_updated_at) "
                                  "VALUES ('Old One', 'old-one', 'DE', 'DE1', 'one@old.example', 'completed', now(), 'aa/' || repeat('k', 43) || '.png', 'image/png', now())"))
                conn.execute(text("INSERT INTO organizations (name, slug, country_code, contact_email) VALUES ('Old Two', 'old-two', 'FR', 'two@old.example')"))
            before = None
            with engine.connect() as conn:
                before = conn.execute(text("SELECT id, name, slug, country_code, tax_identifier, contact_email, setup_status, setup_completed_at, logo_storage_key, is_active, created_at FROM organizations ORDER BY slug")).all()
            command.upgrade(alembic_config(), "head")
            with engine.connect() as conn:
                after = conn.execute(text("SELECT id, name, slug, country_code, tax_identifier, contact_email, setup_status, setup_completed_at, logo_storage_key, is_active, created_at FROM organizations ORDER BY slug")).all()
                assert after == before  # not one existing value changed
                extra = conn.execute(text("SELECT default_currency, timezone, date_format, number_format, settings_version, contact_phone, website, description, settings_updated_by FROM organizations ORDER BY slug")).all()
                assert extra == [("USD", "UTC", "YYYY-MM-DD", "comma_dot", 1, None, None, None, None)] * 2
                assert conn.execute(text("SELECT count(*) FROM organization_settings_history")).scalar() == 0
                # the migrated organization can use Settings at once: it is already 'completed'
                assert conn.execute(text("SELECT setup_status FROM organizations WHERE slug = 'old-one'")).scalar() == "completed"
            engine.dispose()
            command.downgrade(alembic_config(), "0005")  # reversible
            engine = create_engine(get_database_url().set(database=self.NAME))
            with engine.connect() as conn:
                assert conn.execute(text("SELECT count(*) FROM organizations")).scalar() == 2
                assert conn.execute(text("SELECT to_regclass('organization_settings_history')")).scalar() is None
                assert conn.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'default_currency'")).scalar() == 0
            engine.dispose()
        finally:
            if previous is None:
                os.environ.pop("DB_NAME", None)
            else:
                os.environ["DB_NAME"] = previous
            with admin.connect() as conn:
                conn.execute(text(f"DROP DATABASE IF EXISTS {self.NAME} WITH (FORCE)"))
            admin.dispose()

    def test_the_database_itself_refuses_nonsense_preferences(self, session_factory, tenants):
        with session_factory() as db:
            for sql in ("UPDATE organizations SET default_currency = 'usd'", "UPDATE organizations SET default_currency = 'US'", "UPDATE organizations SET date_format = 'DD-MM-YYYY'",
                        "UPDATE organizations SET number_format = 'weird'", "UPDATE organizations SET settings_version = 0"):
                with pytest.raises(DBAPIError):
                    db.execute(text(sql))
                db.rollback()
