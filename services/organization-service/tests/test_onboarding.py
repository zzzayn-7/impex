"""First-time company setup, Organization Service side: status, company name, logo, completion.

Two organizations with several administrators each. The Auth Service is a stand-in keyed by bearer token (as in the other tenant
tests); logos go to a temporary directory through the same storage interface production uses.
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
from sqlalchemy import create_engine, select, text

from app.auth import get_auth_client
from app.database import get_database_url
from app.main import app
from app.models import Organization
from app.storage import KEY_PATTERN, LocalLogoStorage, StorageError, get_logo_storage

from conftest import alembic_config, fake_auth_client

ONBOARDING = "/api/v1/tenant/onboarding"
COMPANY = f"{ONBOARDING}/company"
LOGO = f"{ONBOARDING}/logo"
COMPLETE = f"{ONBOARDING}/complete"
LOGO_URL = "/api/v1/tenant/organization/logo"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def account(role, organization_id, **overrides):
    return {
        "id": str(uuid.uuid4()), "email": f"{role}@example.org", "full_name": f"Test {role}", "role": role,
        "organization_id": organization_id, "is_active": True, "created_at": "2026-11-04T00:00:00+00:00", **overrides,
    }


# --- pictures -------------------------------------------------------------------------------------------------------
def picture(fmt="PNG", size=(300, 200), color=(40, 120, 90), mode="RGB", **save):
    out = io.BytesIO()
    Image.new(mode, size, color).save(out, format=fmt, **save)
    return out.getvalue()


PNG, JPEG, WEBP = picture("PNG"), picture("JPEG"), picture("WEBP")
FILES = {"png": ("logo.png", PNG, "image/png"), "jpeg": ("logo.jpg", JPEG, "image/jpeg"), "webp": ("logo.webp", WEBP, "image/webp")}


def upload(client, who, name, data, content_type):
    return client.put(LOGO, files={"file": (name, data, content_type)}, headers=bearer(who))


# --- the world ------------------------------------------------------------------------------------------------------------
@pytest.fixture
def tenants(session_factory):
    with session_factory() as db:
        alpha = Organization(name="Alpha Trading", slug="alpha-trading", country_code="DE", tax_identifier="DE111111111", contact_email="ops@alpha.example", primary_admin_email="admin@alpha.example")
        beta = Organization(name="Beta Logistics", slug="beta-logistics", country_code="FR", contact_email="ops@beta.example")
        legacy = Organization(name="Legacy Ltd", slug="legacy-ltd", country_code="GB", contact_email="ops@legacy.example", setup_status="completed",
                              setup_completed_at=datetime.now(timezone.utc))
        dormant = Organization(name="Dormant Co", slug="dormant-co", country_code="NL", contact_email="ops@dormant.example", is_active=False)
        db.add_all([alpha, beta, legacy, dormant])
        db.commit()
        return {"alpha": alpha, "beta": beta, "legacy": legacy, "dormant": dormant}


@pytest.fixture
def tokens(tenants):
    a, b, l, d = (str(tenants[k].id) for k in ("alpha", "beta", "legacy", "dormant"))
    return {
        "alpha-1": (200, account("organization-admin", a, email="admin@alpha.example", full_name="Alice One")),
        "alpha-2": (200, account("organization-admin", a, email="second@alpha.example", full_name="Bob Two")),
        "beta-1": (200, account("organization-admin", b, email="admin@beta.example")),
        "legacy-1": (200, account("organization-admin", l, email="admin@legacy.example")),
        "dormant-1": (200, account("organization-admin", d, email="admin@dormant.example")),
        "super": (200, account("super-admin", None)),
        "super-with-org": (200, account("super-admin", a)),
        "regular": (200, account("user", a)),
        "disabled": (200, account("organization-admin", a, is_active=False)),
        "no-org": (200, account("organization-admin", None)),
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


def org(session_factory, tenants, name):
    with session_factory() as db:
        return db.get(Organization, tenants[name].id)


def stored_files(storage):
    return sorted(p for p in Path(storage.root).rglob("*") if p.is_file())


def user_id(tokens, who):
    return tokens[who][1]["id"]


# =====================================================================================================
# the state
# =====================================================================================================
def test_a_newly_created_organization_requires_setup(client, session_factory, tenants):
    row = org(session_factory, tenants, "beta")
    assert (row.setup_status, row.setup_completed_at, row.setup_completed_by, row.logo_storage_key) == ("pending", None, None, None)
    body = client.get(ONBOARDING, headers=bearer("beta-1")).json()
    assert body == {"setup_status": "pending", "setup_completed_at": None, "company_name": "Beta Logistics", "has_logo": False, "logo_version": None, "default_currency": "USD", "can_edit": True}


def test_the_tenant_organization_view_carries_the_status_too(client):
    body = client.get("/api/v1/tenant/organization", headers=bearer("alpha-1")).json()
    assert (body["setup_status"], body["has_logo"], body["logo_version"]) == ("pending", False, None)


def test_the_organization_created_by_a_super_admin_starts_pending(session_factory):
    with session_factory() as db:
        created = Organization(name="Fresh Org", slug="fresh-org", country_code="DE", contact_email="x@fresh.example")
        db.add(created)
        db.commit()
        assert db.get(Organization, created.id).setup_status == "pending"


def test_an_existing_organization_is_completed_and_cannot_be_reopened(client, session_factory, tenants):
    body = client.get(ONBOARDING, headers=bearer("legacy-1")).json()
    assert body["setup_status"] == "completed" and body["can_edit"] is False and body["has_logo"] is False
    assert client.put(COMPANY, json={"name": "Renamed"}, headers=bearer("legacy-1")).status_code == 409
    assert upload(client, "legacy-1", *FILES["png"]).status_code == 409
    assert org(session_factory, tenants, "legacy").name == "Legacy Ltd"


def test_the_migration_marks_existing_organizations_completed_and_new_ones_pending():
    name = "impex_org_migration_test"
    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {name}"))
    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = name
    try:
        command.upgrade(alembic_config(), "0003")
        engine = create_engine(get_database_url().set(database=name))
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO organizations (name, slug, country_code, contact_email) VALUES ('Old Co', 'old-co', 'DE', 'o@old.example')"))
        command.upgrade(alembic_config(), "head")
        with engine.begin() as conn:
            row = conn.execute(text("SELECT setup_status, setup_completed_at IS NOT NULL, setup_completed_by IS NULL, logo_storage_key IS NULL FROM organizations WHERE slug = 'old-co'")).one()
            assert tuple(row) == ("completed", True, True, True)
            conn.execute(text("INSERT INTO organizations (name, slug, country_code, contact_email) VALUES ('New Co', 'new-co', 'DE', 'n@new.example')"))
            assert conn.execute(text("SELECT setup_status FROM organizations WHERE slug = 'new-co'")).scalar() == "pending"
        command.downgrade(alembic_config(), "0003")  # reverses cleanly
        engine.dispose()
    finally:
        if previous is None:
            os.environ.pop("DB_NAME", None)
        else:
            os.environ["DB_NAME"] = previous
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        admin.dispose()


def test_the_database_refuses_inconsistent_setup_states(session_factory, tenants):
    from sqlalchemy.exc import IntegrityError

    for statement in (
        "UPDATE organizations SET setup_status = 'finished'",
        "UPDATE organizations SET setup_status = 'completed', setup_completed_at = NULL WHERE slug = 'beta-logistics'",
        "UPDATE organizations SET logo_storage_key = 'x' WHERE slug = 'beta-logistics'",
    ):
        with session_factory() as db, pytest.raises(IntegrityError):
            db.execute(text(statement))
            db.commit()


# =====================================================================================================
# the company name
# =====================================================================================================
@pytest.mark.parametrize("typed, saved", [("  Alpha   Trading  GmbH ", "Alpha Trading GmbH"), ("A & B Traders (Pvt.) Ltd.", "A & B Traders (Pvt.) Ltd."), ("L’Oréal Paris", "L’Oréal Paris"), ("株式会社 インペックス", "株式会社 インペックス"), ("Müller+Söhne, Inc.", "Müller+Söhne, Inc.")])
def test_the_company_name_is_cleaned_and_saved_and_setup_begins(client, session_factory, tenants, typed, saved):
    body = client.put(COMPANY, json={"name": typed}, headers=bearer("alpha-1")).json()
    assert body["company_name"] == saved and body["setup_status"] == "in_progress" and body["can_edit"] is True
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.slug, row.country_code, row.tax_identifier, row.contact_email, row.primary_admin_email, row.is_active) == (
        saved, "alpha-trading", "DE", "DE111111111", "ops@alpha.example", "admin@alpha.example", True)
    assert client.get(ONBOARDING, headers=bearer("alpha-2")).json()["company_name"] == saved  # the other administrator sees it


@pytest.mark.parametrize("bad", ["", "   ", "A", "x" * 121, "<script>alert(1)</script>", "Acme\u0000", "Acme‮Ltd", "Robert'); DROP TABLE organizations;--"[0:0] + "Acme {x}", "$$$", "...", 123, None, ["Acme"]])
def test_bad_company_names_are_refused_and_nothing_changes(client, session_factory, tenants, bad):
    assert client.put(COMPANY, json={"name": bad}, headers=bearer("alpha-1")).status_code == 422
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.setup_status) == ("Alpha Trading", "pending")


@pytest.mark.parametrize("field, value", [
    ("slug", "hijacked"), ("id", str(uuid.uuid4())), ("organization_id", str(uuid.uuid4())), ("country_code", "US"), ("tax_identifier", "X"),
    ("contact_email", "evil@example.org"), ("primary_admin_email", "evil@example.org"), ("is_active", False), ("setup_status", "completed"), ("setup_completed_by", str(uuid.uuid4())),
])
def test_only_the_name_can_be_changed(client, session_factory, tenants, field, value):
    assert client.put(COMPANY, json={"name": "New Name", field: value}, headers=bearer("alpha-1")).status_code == 422
    assert client.post(COMPLETE, json={"company_name": "New Name", field: value}, headers=bearer("alpha-1")).status_code == 422
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.slug, row.setup_status, row.is_active, row.country_code) == ("Alpha Trading", "alpha-trading", "pending", True, "DE")


# =====================================================================================================
# the logo
# =====================================================================================================
@pytest.mark.parametrize("kind", ["png", "jpeg", "webp"])
def test_png_jpeg_and_webp_are_accepted_and_stored_as_a_clean_png(client, storage, session_factory, tenants, kind):
    response = upload(client, "alpha-1", *FILES[kind])
    assert response.status_code == 200
    body = response.json()
    assert body["has_logo"] is True and body["logo_version"] and body["setup_status"] == "in_progress"
    row = org(session_factory, tenants, "alpha")
    assert row.logo_content_type == "image/png" and KEY_PATTERN.match(row.logo_storage_key)
    served = client.get(LOGO_URL, headers=bearer("alpha-1"))
    assert served.status_code == 200 and served.headers["content-type"] == "image/png"
    image = Image.open(io.BytesIO(served.content))
    assert image.format == "PNG" and image.size == (300, 200)
    assert len(stored_files(storage)) == 1


def test_the_logo_is_served_safely_and_cached_by_version(client):
    upload(client, "alpha-1", *FILES["png"])
    served = client.get(LOGO_URL, headers=bearer("alpha-1"))
    assert served.headers["x-content-type-options"] == "nosniff" and served.headers["content-security-policy"] == "default-src 'none'"
    assert served.headers["cache-control"].startswith("private") and served.headers["etag"]
    assert client.get(LOGO_URL, headers={**bearer("alpha-1"), "If-None-Match": served.headers["etag"]}).status_code == 304
    assert client.get(LOGO_URL, headers={**bearer("alpha-1"), "If-None-Match": '"stale"'}).status_code == 200


def test_replacing_the_logo_swaps_the_file_and_the_version_and_leaves_no_orphan(client, storage, session_factory, tenants):
    first = upload(client, "alpha-1", *FILES["png"]).json()
    first_file = stored_files(storage)[0]
    replacement = picture("PNG", (200, 200), (200, 30, 30))
    second = upload(client, "alpha-1", "new.png", replacement, "image/png").json()
    assert second["logo_version"] != first["logo_version"]
    files = stored_files(storage)
    assert len(files) == 1 and files[0] != first_file and not first_file.exists()
    assert Image.open(io.BytesIO(client.get(LOGO_URL, headers=bearer("alpha-1")).content)).getpixel((5, 5)) == (200, 30, 30)


def test_a_logo_can_be_removed_before_completion(client, storage):
    upload(client, "alpha-1", *FILES["png"])
    body = client.delete(LOGO, headers=bearer("alpha-1")).json()
    assert body["has_logo"] is False and body["logo_version"] is None
    assert stored_files(storage) == [] and client.get(LOGO_URL, headers=bearer("alpha-1")).status_code == 404


def test_the_logo_survives_a_restart_and_a_new_session(client, storage, tokens):
    upload(client, "alpha-1", *FILES["png"])
    before = client.get(LOGO_URL, headers=bearer("alpha-1")).content
    # a brand-new storage object over the same directory and a different administrator's session: the same file
    app.dependency_overrides[get_logo_storage] = lambda: LocalLogoStorage(str(storage.root))
    assert client.get(LOGO_URL, headers=bearer("alpha-2")).content == before


def png_with(*, appended=b"", extra_chunk=None):
    return picture("PNG") + appended


def noisy(size=(1100, 1100)):
    out = io.BytesIO()
    Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3)).save(out, format="PNG")
    return out.getvalue()


SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script><rect width="200" height="200"/></svg>'
BAD_UPLOADS = {
    "svg declared as svg": ("logo.svg", SVG, "image/svg+xml", 415, "unsupported_type"),
    "svg disguised as png": ("logo.png", SVG, "image/png", 422, "invalid_image"),
    "gif": ("logo.gif", picture("GIF"), "image/gif", 415, "unsupported_type"),
    "gif disguised as png": ("logo.png", picture("GIF"), "image/png", 415, "unsupported_type"),
    "bmp disguised as png": ("logo.png", picture("BMP"), "image/png", 415, "unsupported_type"),
    "pdf disguised as png": ("logo.png", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n", "image/png", 422, "invalid_image"),
    "an executable": ("logo.png", b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 200, "image/png", 422, "invalid_image"),
    "html": ("logo.png", b"<html><script>alert(1)</script></html>", "image/png", 422, "invalid_image"),
    "text": ("logo.txt", b"hello", "text/plain", 415, "unsupported_type"),
    "an empty file": ("logo.png", b"", "image/png", 422, "empty_file"),
    "a truncated png": ("logo.png", PNG[: len(PNG) // 2], "image/png", 422, "invalid_image"),
    "a corrupt jpeg": ("logo.jpg", JPEG[:200] + b"\x00" * 50, "image/jpeg", 422, "invalid_image"),
    "too small": ("logo.png", picture("PNG", (32, 32)), "image/png", 422, "too_small"),
    "too thin": ("logo.png", picture("PNG", (500, 20)), "image/png", 422, "too_small"),
    "too many pixels (a decompression bomb)": ("logo.png", picture("PNG", (6000, 6000)), "image/png", 422, "too_large_dimensions"),
    "too big in bytes": ("logo.png", noisy(), "image/png", 413, "file_too_large"),
    "no content type": ("logo.png", PNG, "", 415, "unsupported_type"),
}


@pytest.mark.parametrize("name", sorted(BAD_UPLOADS))
def test_invalid_uploads_are_refused_and_nothing_is_stored(client, storage, session_factory, tenants, name):
    filename, data, content_type, expected_status, code = BAD_UPLOADS[name]
    response = upload(client, "alpha-1", filename, data, content_type)
    assert response.status_code == expected_status, response.text
    assert response.json()["detail"]["code"] == code
    assert stored_files(storage) == []
    row = org(session_factory, tenants, "alpha")
    assert (row.logo_storage_key, row.setup_status) == (None, "pending")


def test_a_missing_file_field_is_refused(client):
    assert client.put(LOGO, headers=bearer("alpha-1")).status_code == 422
    assert client.put(LOGO, files={"other": ("logo.png", PNG, "image/png")}, headers=bearer("alpha-1")).status_code == 422


def test_metadata_and_appended_payloads_do_not_survive(client, storage):
    marker = b"<?php system($_GET['c']); ?>"
    out = io.BytesIO()
    exif = Image.Exif()
    exif[0x010E] = "GPS SECRET DESCRIPTION"
    Image.new("RGB", (300, 300), (10, 20, 30)).save(out, format="JPEG", exif=exif.tobytes())
    assert upload(client, "alpha-1", "a.jpg", out.getvalue() + marker, "image/jpeg").status_code == 200
    stored = stored_files(storage)[0].read_bytes()
    assert marker not in stored and b"GPS SECRET" not in stored and b"Exif" not in stored
    with_png = picture("PNG") + marker
    assert upload(client, "alpha-1", "b.png", with_png, "image/png").status_code == 200
    assert marker not in stored_files(storage)[0].read_bytes()


def test_a_big_picture_is_shrunk_and_transparency_is_kept(client):
    big = picture("PNG", (3000, 2000), (0, 0, 0, 0), mode="RGBA")
    assert upload(client, "alpha-1", "big.png", big, "image/png").status_code == 200
    image = Image.open(io.BytesIO(client.get(LOGO_URL, headers=bearer("alpha-1")).content))
    assert max(image.size) == 1024 and image.mode == "RGBA" and image.getpixel((1, 1))[3] == 0


def test_a_storage_failure_is_a_recoverable_503_and_changes_nothing(client, session_factory, tenants, monkeypatch, storage):
    def broken(self, key, data):
        raise StorageError("disk full")

    monkeypatch.setattr(LocalLogoStorage, "write", broken)
    response = upload(client, "alpha-1", *FILES["png"])
    assert response.status_code == 503 and response.json()["detail"]["code"] == "storage_unavailable"
    assert org(session_factory, tenants, "alpha").logo_storage_key is None


def test_a_file_written_for_a_refused_upload_is_removed(client, storage, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading"}, headers=bearer("alpha-1"))
    client.put(LOGO, files={"file": FILES["png"]}, headers=bearer("alpha-1"))
    assert client.post(COMPLETE, json={"company_name": "Alpha Trading"}, headers=bearer("alpha-1")).status_code == 200
    kept = stored_files(storage)
    assert upload(client, "alpha-1", "late.png", picture("PNG", (200, 200), (1, 2, 3)), "image/png").status_code == 409
    assert stored_files(storage) == kept  # the new file did not stay behind


# =====================================================================================================
# completing
# =====================================================================================================
def complete(client, who="alpha-1", name="Alpha Trading GmbH"):
    return client.post(COMPLETE, json={"company_name": name}, headers=bearer(who))


def test_completion_needs_a_logo(client, session_factory, tenants):
    response = complete(client)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "logo_required"
    row = org(session_factory, tenants, "alpha")
    assert (row.setup_status, row.name, row.setup_completed_at) == ("pending", "Alpha Trading", None)


def test_completion_saves_the_name_the_time_and_the_person_together(client, session_factory, tenants, tokens):
    upload(client, "alpha-1", *FILES["png"])
    body = complete(client, name="  Alpha   Trading GmbH ").json()
    assert body["setup_status"] == "completed" and body["company_name"] == "Alpha Trading GmbH" and body["setup_completed_at"] and body["can_edit"] is False
    row = org(session_factory, tenants, "alpha")
    assert (row.setup_status, row.name, str(row.setup_completed_by)) == ("completed", "Alpha Trading GmbH", user_id(tokens, "alpha-1"))
    assert row.setup_completed_at is not None and (row.slug, row.country_code, row.primary_admin_email) == ("alpha-trading", "DE", "admin@alpha.example")


def test_a_bad_name_completes_nothing(client, session_factory, tenants):
    upload(client, "alpha-1", *FILES["png"])
    assert complete(client, name="<b>").status_code == 422
    assert org(session_factory, tenants, "alpha").setup_status == "in_progress"


def test_completing_twice_changes_nothing_the_first_completion_stands(client, session_factory, tenants, tokens):
    upload(client, "alpha-1", *FILES["png"])
    first = complete(client, "alpha-1", "Alpha Trading GmbH").json()
    again = complete(client, "alpha-2", "Something Else Entirely")
    assert again.status_code == 200 and again.json() == first
    row = org(session_factory, tenants, "alpha")
    assert (row.name, str(row.setup_completed_by)) == ("Alpha Trading GmbH", user_id(tokens, "alpha-1"))


def test_completion_verifies_the_logo_file_really_exists(client, storage, session_factory, tenants):
    upload(client, "alpha-1", *FILES["png"])
    stored_files(storage)[0].unlink()  # e.g. the volume was not mounted
    response = complete(client)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "logo_required"
    assert org(session_factory, tenants, "alpha").setup_status == "in_progress"


def test_completion_is_a_recoverable_503_when_storage_cannot_be_checked(client, session_factory, tenants, monkeypatch):
    upload(client, "alpha-1", *FILES["png"])

    def broken(self, key):
        raise StorageError("unreachable")

    monkeypatch.setattr(LocalLogoStorage, "exists", broken)
    assert complete(client).status_code == 503
    assert org(session_factory, tenants, "alpha").setup_status == "in_progress"
    monkeypatch.undo()
    assert complete(client).status_code == 200  # and a retry simply works


def test_once_completed_the_wizard_is_closed_but_the_logo_still_shows(client):
    upload(client, "alpha-1", *FILES["png"])
    complete(client)
    assert client.put(COMPANY, json={"name": "Renamed"}, headers=bearer("alpha-1")).status_code == 409
    assert upload(client, "alpha-2", *FILES["jpeg"]).status_code == 409
    assert client.delete(LOGO, headers=bearer("alpha-1")).status_code == 409
    assert client.get(LOGO_URL, headers=bearer("alpha-2")).status_code == 200
    assert client.get(ONBOARDING, headers=bearer("alpha-2")).json()["setup_status"] == "completed"


def test_an_interrupted_setup_resumes_where_it_stopped(client):
    client.put(COMPANY, json={"name": "Alpha Trading AG"}, headers=bearer("alpha-1"))
    upload(client, "alpha-1", *FILES["png"])
    # "refresh the browser" / come back tomorrow / use another device: everything saved is still there
    body = client.get(ONBOARDING, headers=bearer("alpha-1")).json()
    assert (body["setup_status"], body["company_name"], body["has_logo"]) == ("in_progress", "Alpha Trading AG", True)
    assert complete(client, name=body["company_name"]).json()["setup_status"] == "completed"


# =====================================================================================================
# several administrators, simultaneous first logins
# =====================================================================================================
def test_simultaneous_completions_produce_one_completion(client, session_factory, tenants, tokens):
    upload(client, "alpha-1", *FILES["png"])
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda i: complete(client, "alpha-1" if i % 2 == 0 else "alpha-2", f"Alpha Trading {i}").status_code, range(8)))
    assert results == [200] * 8
    row = org(session_factory, tenants, "alpha")
    assert row.setup_status == "completed" and str(row.setup_completed_by) in (user_id(tokens, "alpha-1"), user_id(tokens, "alpha-2"))
    names = {client.get(ONBOARDING, headers=bearer(w)).json()["company_name"] for w in ("alpha-1", "alpha-2")}
    assert names == {row.name}  # whoever won, both administrators see the same company


def test_simultaneous_logo_uploads_leave_exactly_one_file(client, storage, session_factory, tenants):
    colors = [(i * 20, 50, 90) for i in range(8)]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda c: upload(client, "alpha-1", "l.png", picture("PNG", (200, 200), c), "image/png").status_code, colors))
    assert results == [200] * 8
    assert len(stored_files(storage)) == 1
    row = org(session_factory, tenants, "alpha")
    assert stored_files(storage)[0].name == row.logo_storage_key.split("/")[1]


def test_a_second_administrator_of_a_configured_company_does_not_repeat_the_company_setup(client):
    upload(client, "alpha-1", *FILES["png"])
    complete(client)
    body = client.get(ONBOARDING, headers=bearer("alpha-2")).json()
    assert body["setup_status"] == "completed" and body["can_edit"] is False and body["has_logo"] is True


# =====================================================================================================
# tenants never see each other's
# =====================================================================================================
def test_each_organization_has_its_own_logo_and_status(client):
    upload(client, "alpha-1", "a.png", picture("PNG", (200, 200), (255, 0, 0)), "image/png")
    assert client.get(LOGO_URL, headers=bearer("beta-1")).status_code == 404  # beta has none: never alpha's
    upload(client, "beta-1", "b.png", picture("PNG", (200, 200), (0, 0, 255)), "image/png")
    assert Image.open(io.BytesIO(client.get(LOGO_URL, headers=bearer("alpha-1")).content)).getpixel((3, 3)) == (255, 0, 0)
    assert Image.open(io.BytesIO(client.get(LOGO_URL, headers=bearer("beta-1")).content)).getpixel((3, 3)) == (0, 0, 255)
    complete(client, "alpha-1")
    assert client.get(ONBOARDING, headers=bearer("beta-1")).json()["setup_status"] == "in_progress"


def test_no_request_can_name_another_organization(client, session_factory, tenants):
    beta = str(tenants["beta"].id)
    upload(client, "beta-1", *FILES["png"])
    for call in (
        lambda: client.get(f"{ONBOARDING}?organization_id={beta}", headers=bearer("alpha-1")),
        lambda: client.get(LOGO_URL, params={"organization_id": beta}, headers={**bearer("alpha-1"), "X-Organization-Id": beta}),
        lambda: client.put(COMPANY, params={"organization_id": beta}, json={"name": "Hijack"}, headers={**bearer("alpha-1"), "X-Organization-Id": beta}),
        lambda: client.get(f"/api/v1/tenant/organization/{beta}/logo", headers=bearer("alpha-1")),
        lambda: client.get(f"{ONBOARDING}/{beta}", headers=bearer("alpha-1")),
    ):
        response = call()
        assert response.status_code in (200, 404, 405) and beta not in response.text
    assert org(session_factory, tenants, "beta").name == "Beta Logistics"
    assert client.get(LOGO_URL, params={"organization_id": beta}, headers=bearer("alpha-1")).status_code == 404  # alpha has no logo; beta's is unreachable


def test_internal_storage_details_never_leave_the_service(client, storage, session_factory, tenants):
    body = upload(client, "alpha-1", *FILES["png"]).text + client.get(ONBOARDING, headers=bearer("alpha-1")).text + client.get("/api/v1/tenant/organization", headers=bearer("alpha-1")).text
    key = org(session_factory, tenants, "alpha").logo_storage_key
    assert key not in body and key.split("/")[1] not in body and str(storage.root) not in body and "logo_storage_key" not in body


def test_the_endpoints_declare_no_organization_input(client):
    spec = client.get("/openapi.json").json()
    for path in (ONBOARDING, COMPANY, LOGO, COMPLETE, LOGO_URL):
        for operation in spec["paths"][path].values():
            names = {p["name"] for p in operation.get("parameters", [])}
            assert not names & {"organization_id", "org_id", "user_id", "id"}, (path, names)
    for schema in ("CompanyUpdate", "CompleteSetup"):
        assert "organization_id" not in str(spec["components"]["schemas"][schema])


# =====================================================================================================
# who may use it
# =====================================================================================================
ROUTES = [("get", ONBOARDING, {}), ("put", COMPANY, {"json": {"name": "Acme"}}), ("put", LOGO, {"files": {"file": ("l.png", PNG, "image/png")}}),
          ("delete", LOGO, {}), ("post", COMPLETE, {"json": {"company_name": "Acme"}}), ("get", LOGO_URL, {})]


@pytest.mark.parametrize("method, url, kwargs", ROUTES)
def test_only_an_active_organization_administrator_gets_in(client, storage, session_factory, tenants, method, url, kwargs):
    send = lambda who: getattr(client, method)(url, headers=bearer(who) if who else {}, **kwargs)
    assert send(None).status_code == 401
    assert send("expired").status_code == 401
    assert send("nonsense").status_code == 401
    for forbidden in ("super", "super-with-org", "regular", "disabled", "no-org", "dormant-1"):
        assert send(forbidden).status_code == 403, forbidden
    assert send("auth-broken").status_code == 503
    assert stored_files(storage) == []
    assert (org(session_factory, tenants, "alpha").setup_status, org(session_factory, tenants, "dormant")) [0] == "pending"


def test_an_inactive_organization_cannot_set_up(client, storage, session_factory, tenants):
    assert upload(client, "dormant-1", *FILES["png"]).status_code == 403
    assert client.put(COMPANY, json={"name": "Revived"}, headers=bearer("dormant-1")).status_code == 403
    assert org(session_factory, tenants, "dormant").name == "Dormant Co" and stored_files(storage) == []


# =====================================================================================================
# compatibility with the existing flows
# =====================================================================================================
def test_demo_mode_and_the_invitation_flow_are_unaffected(client, monkeypatch, tenants):
    monkeypatch.setenv("DEMO_MODE", "true")
    assert client.get(ONBOARDING, headers=bearer("alpha-1")).status_code == 200
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/organizations", headers=bearer("super")).status_code == 200  # Super Admin APIs unchanged
    assert client.get("/api/v1/organizations", headers=bearer("alpha-1")).status_code == 403  # and still closed to tenants


def test_the_storage_module_only_ever_touches_its_own_directory(tmp_path):
    store = LocalLogoStorage(str(tmp_path / "logos"))
    key = store.new_key()
    assert KEY_PATTERN.match(key) and key != store.new_key()
    for bad in ("../evil.png", "/etc/passwd", "aa/../../evil.png", "aa/x.png", "aa/" + "A" * 40 + ".svg", "..\\evil.png", "", "aa/" + "A" * 40 + ".png/../../x"):
        with pytest.raises(StorageError):
            store.read(bad)
        with pytest.raises(StorageError):
            store.write(bad, b"x")
    store.write(key, b"hello")
    assert store.read(key) == b"hello" and store.exists(key)
    assert not [p for p in Path(store.root).rglob(".upload-*")]  # the atomic write leaves no temp file
    store.delete(key)
    store.delete(key)  # idempotent
    assert store.read(key) is None and not store.exists(key)


# =====================================================================================================
# the default currency chosen in the wizard
# =====================================================================================================
def test_the_status_carries_the_current_default_currency(client):
    assert client.get(ONBOARDING, headers=bearer("alpha-1")).json()["default_currency"] == "USD"  # the database default until somebody chooses


@pytest.mark.parametrize("code", ["USD", "EUR", "PKR", "JPY", "XOF", "ZWL", "AED", "KWD"])
def test_the_company_step_saves_the_chosen_currency(client, session_factory, tenants, code):
    body = client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": code}, headers=bearer("alpha-1")).json()
    assert body["default_currency"] == code and body["setup_status"] == "in_progress"
    assert org(session_factory, tenants, "alpha").default_currency == code
    assert client.get(ONBOARDING, headers=bearer("alpha-2")).json()["default_currency"] == code  # the other administrator sees it


def test_a_lower_case_code_is_accepted_and_stored_in_capitals(client, session_factory, tenants):
    assert client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "usd"}, headers=bearer("alpha-1")).status_code == 200
    assert org(session_factory, tenants, "alpha").default_currency == "USD"


def test_not_sending_a_currency_leaves_the_current_default_alone(client, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "EUR"}, headers=bearer("alpha-1"))
    assert client.put(COMPANY, json={"name": "Alpha Trading GmbH"}, headers=bearer("alpha-1")).status_code == 200
    assert org(session_factory, tenants, "alpha").default_currency == "EUR"


@pytest.mark.parametrize("bad", ["", "US", "USDX", "ABC", "XXX", "usd ", " USD", "$", "<script>", "US$", "🇺🇸", 1, True, ["USD"], {"code": "USD"}])
def test_anything_that_is_not_a_real_iso_code_is_refused_and_nothing_changes(client, session_factory, tenants, bad):
    response = client.put(COMPANY, json={"name": "New Name", "default_currency": bad}, headers=bearer("alpha-1"))
    assert response.status_code == 422, response.text
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.default_currency, row.setup_status) == ("Alpha Trading", "USD", "pending")
    upload(client, "alpha-1", *FILES["png"])
    assert client.post(COMPLETE, json={"company_name": "New Name", "default_currency": bad}, headers=bearer("alpha-1")).status_code == 422
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.default_currency, row.setup_status) == ("Alpha Trading", "USD", "in_progress")


def test_completion_saves_the_confirmed_currency_with_the_name_and_the_status_together(client, session_factory, tenants):
    upload(client, "alpha-1", *FILES["png"])
    body = client.post(COMPLETE, json={"company_name": "Alpha Trading", "default_currency": "GBP"}, headers=bearer("alpha-1")).json()
    assert body["setup_status"] == "completed" and body["default_currency"] == "GBP"
    assert org(session_factory, tenants, "alpha").default_currency == "GBP"


def test_a_completion_without_a_currency_keeps_what_the_company_step_saved(client, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "CAD"}, headers=bearer("alpha-1"))
    upload(client, "alpha-1", *FILES["png"])
    assert complete(client).status_code == 200
    assert org(session_factory, tenants, "alpha").default_currency == "CAD"


def test_once_completed_the_currency_cannot_be_changed_through_the_wizard(client, session_factory, tenants):
    upload(client, "alpha-1", *FILES["png"])
    client.post(COMPLETE, json={"company_name": "Alpha Trading", "default_currency": "USD"}, headers=bearer("alpha-1"))
    assert client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "EUR"}, headers=bearer("alpha-1")).status_code == 409
    again = client.post(COMPLETE, json={"company_name": "Alpha Trading", "default_currency": "EUR"}, headers=bearer("alpha-2"))
    assert again.status_code == 200 and again.json()["default_currency"] == "USD"  # the first completion stands
    assert org(session_factory, tenants, "alpha").default_currency == "USD"


def test_choosing_a_currency_here_is_not_a_settings_change(client, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "JPY"}, headers=bearer("alpha-1"))
    with session_factory() as db:
        assert db.scalar(text("SELECT count(*) FROM organization_settings_history")) == 0
        assert db.scalar(text("SELECT settings_version FROM organizations WHERE slug = 'alpha-trading'")) == 1


def test_a_second_organization_is_untouched(client, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading", "default_currency": "CHF"}, headers=bearer("alpha-1"))
    assert org(session_factory, tenants, "beta").default_currency == "USD"


# --- the location (time zone) chosen at setup: every time on screen is shown in it -----------------------------------------------------------------------
@pytest.mark.parametrize("zone", ["Asia/Karachi", "America/New_York", "Europe/Berlin", "UTC", "Pacific/Auckland"])
def test_the_company_step_saves_the_chosen_location(client, session_factory, tenants, zone):
    assert client.put(COMPANY, json={"name": "Alpha Trading", "timezone": zone}, headers=bearer("alpha-1")).status_code == 200
    assert org(session_factory, tenants, "alpha").timezone == zone


def test_completing_setup_saves_the_confirmed_location_in_the_same_transaction(client, session_factory, tenants):
    upload(client, "alpha-1", *FILES["png"])
    assert client.post(COMPLETE, json={"company_name": "Alpha Trading", "timezone": "Asia/Karachi"}, headers=bearer("alpha-1")).status_code == 200
    row = org(session_factory, tenants, "alpha")
    assert (row.timezone, row.setup_status) == ("Asia/Karachi", "completed")


def test_not_sending_a_location_leaves_it_alone(client, session_factory, tenants):
    client.put(COMPANY, json={"name": "Alpha Trading", "timezone": "Asia/Karachi"}, headers=bearer("alpha-1"))
    assert client.put(COMPANY, json={"name": "Alpha Trading GmbH"}, headers=bearer("alpha-1")).status_code == 200
    assert org(session_factory, tenants, "alpha").timezone == "Asia/Karachi"


@pytest.mark.parametrize("bad", ["", "Mars/Olympus", "asia/karachi ", " Asia/Karachi", "../../etc/passwd", "<script>", 5, True, ["UTC"], "x" * 80])
def test_anything_that_is_not_a_real_zone_is_refused_and_nothing_changes(client, session_factory, tenants, bad):
    response = client.put(COMPANY, json={"name": "New Name", "timezone": bad}, headers=bearer("alpha-1"))
    assert response.status_code == 422, response.text
    row = org(session_factory, tenants, "alpha")
    assert (row.name, row.timezone, row.setup_status) == ("Alpha Trading", "UTC", "pending")
