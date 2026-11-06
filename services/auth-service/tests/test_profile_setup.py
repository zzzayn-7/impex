"""First-time onboarding, Auth Service side: an organization administrator confirms their own profile.

Covers: new administrators start incomplete; existing accounts are migrated as complete (nobody is locked out); the name is
validated and persisted; only the caller's own name can change (never role, e-mail, organization, password or another user);
completing is atomic, idempotent and safe under concurrency; Super Admins and plain users are refused.
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.database import get_database_url
from app.main import app
from app.models import User
from app.security import hash_password

from conftest import INTERNAL_KEY, alembic_config

PASSWORD = "Str0ng!Passphrase"
ORG, OTHER_ORG = str(uuid.uuid4()), str(uuid.uuid4())
PROFILE = "/api/v1/auth/me/profile"
COMPLETE = "/api/v1/auth/me/profile/complete"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email, role="organization-admin", organization_id=ORG, full_name="Olivia Owner", completed=False, active=True):
    with session_factory() as db:
        user = User(
            full_name=full_name, email=email, password_hash=hash_password(PASSWORD), role=role,
            organization_id=uuid.UUID(organization_id) if organization_id else None, is_active=active,
            profile_setup_completed_at=datetime.now(timezone.utc) if completed else None,
        )
        db.add(user)
        db.commit()
        return str(user.id)


def token(client, email):
    return {"Authorization": "Bearer " + client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()["access_token"]}


def stored(session_factory, user_id):
    with session_factory() as db:
        user = db.get(User, uuid.UUID(user_id))
        return (user.full_name, user.email, user.role, str(user.organization_id) if user.organization_id else None, user.is_active,
                user.profile_setup_completed_at, user.password_hash)


# --- the state ---------------------------------------------------------------
def test_a_newly_created_administrator_starts_with_profile_setup_incomplete(client):
    created = client.post("/internal/organization-admins", headers={"X-Internal-Key": INTERNAL_KEY},
                          json={"organization_id": ORG, "full_name": "New Admin", "email": "new@acme.example", "password": PASSWORD})
    assert created.status_code == 201
    me = client.get("/api/v1/auth/me", headers=token(client, "new@acme.example")).json()
    assert me["profile_setup_completed_at"] is None


def test_me_reports_when_the_profile_was_confirmed(client, session_factory):
    add_user(session_factory, "done@acme.example", completed=True)
    assert client.get("/api/v1/auth/me", headers=token(client, "done@acme.example")).json()["profile_setup_completed_at"]


# --- the migration never locks anybody out -------------------------------------
def test_migration_marks_every_existing_account_as_set_up_and_new_ones_as_not():
    name = "impex_auth_migration_test"
    admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {name}"))
    previous = os.environ.get("DB_NAME")
    os.environ["DB_NAME"] = name
    try:
        command.upgrade(alembic_config(), "0002")
        engine = create_engine(get_database_url().set(database=name))
        with engine.begin() as conn:
            for email, role, org in (("old-admin@acme.example", "organization-admin", ORG), ("root@example.org", "super-admin", None)):
                conn.execute(text("INSERT INTO users (full_name, email, password_hash, role, organization_id) VALUES ('Old', :e, 'x$y', :r, :o)"),
                             {"e": email, "r": role, "o": uuid.UUID(org) if org else None})
        command.upgrade(alembic_config(), "head")
        with engine.begin() as conn:
            assert conn.execute(text("SELECT count(*) FROM users WHERE profile_setup_completed_at IS NULL")).scalar() == 0
            conn.execute(text("INSERT INTO users (full_name, email, password_hash, role, organization_id) VALUES ('New', 'new@acme.example', 'x$y', 'organization-admin', :o)"), {"o": uuid.UUID(ORG)})
            assert conn.execute(text("SELECT profile_setup_completed_at IS NULL FROM users WHERE email = 'new@acme.example'")).scalar() is True
        command.downgrade(alembic_config(), "0002")  # and it reverses cleanly
        engine.dispose()
    finally:
        if previous is None:
            os.environ.pop("DB_NAME", None)
        else:
            os.environ["DB_NAME"] = previous
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        admin.dispose()


# --- changing the name -----------------------------------------------------------
@pytest.mark.parametrize("typed, saved", [
    ("  Ada   Lovelace ", "Ada Lovelace"), ("Zoë O’Brien-Smith", "Zoë O’Brien-Smith"), ("María-José de la Cruz", "María-José de la Cruz"),
    ("李 小龍", "李 小龍"), ("J. R. R. Tolkien", "J. R. R. Tolkien"),
])
def test_the_name_is_cleaned_and_persisted(client, session_factory, typed, saved):
    user_id = add_user(session_factory, "a@acme.example")
    response = client.patch(PROFILE, json={"full_name": typed}, headers=token(client, "a@acme.example"))
    assert response.status_code == 200 and response.json()["full_name"] == saved
    assert stored(session_factory, user_id)[0] == saved
    assert client.get("/api/v1/auth/me", headers=token(client, "a@acme.example")).json()["full_name"] == saved  # what every service reads


@pytest.mark.parametrize("bad", [
    "", "   ", "A", "x" * 101, "Robert'); DROP TABLE users;--", "<script>alert(1)</script>", "Jane 3rd", "...", "---", "Bob\u0000", "‮Bob",
    12345, None, ["Ada"],
])
def test_bad_names_are_refused_and_nothing_changes(client, session_factory, bad):
    user_id = add_user(session_factory, "a@acme.example")
    before = stored(session_factory, user_id)
    response = client.patch(PROFILE, json={"full_name": bad}, headers=token(client, "a@acme.example"))
    assert response.status_code == 422
    assert stored(session_factory, user_id) == before


# --- only the caller's name can change ----------------------------------------------
@pytest.mark.parametrize("field, value", [
    ("role", "super-admin"), ("email", "evil@example.org"), ("organization_id", OTHER_ORG), ("password", "N3w!Passphrase#1"), ("is_active", False),
    ("id", str(uuid.uuid4())), ("profile_setup_completed_at", "2020-01-01T00:00:00Z"), ("user_id", str(uuid.uuid4())),
])
def test_nothing_but_the_name_is_accepted(client, session_factory, field, value):
    user_id = add_user(session_factory, "a@acme.example")
    before = stored(session_factory, user_id)
    headers = token(client, "a@acme.example")
    assert client.patch(PROFILE, json={"full_name": "Ada Lovelace", field: value}, headers=headers).status_code == 422
    assert client.post(COMPLETE, json={"full_name": "Ada Lovelace", field: value}, headers=headers).status_code == 422
    assert stored(session_factory, user_id) == before


def test_one_administrator_cannot_touch_another(client, session_factory):
    mine = add_user(session_factory, "a@acme.example")
    theirs = add_user(session_factory, "b@other.example", organization_id=OTHER_ORG, full_name="Their Admin")
    before = stored(session_factory, theirs)
    assert client.patch(PROFILE, json={"full_name": "Mine Now"}, headers=token(client, "a@acme.example")).status_code == 200
    assert stored(session_factory, theirs) == before
    assert stored(session_factory, mine)[0] == "Mine Now"
    # the URL names nobody: there is no way to address another user
    assert client.patch(f"{PROFILE}/{theirs}", json={"full_name": "X Y"}, headers=token(client, "a@acme.example")).status_code in (404, 405)


def test_requires_a_valid_token_and_an_organization_administrator(client, session_factory):
    add_user(session_factory, "root@example.org", role="super-admin", organization_id=None, full_name="Root")
    add_user(session_factory, "u@example.org", role="user", organization_id=None, full_name="Plain User")
    add_user(session_factory, "off@acme.example", active=False)
    for call in (lambda h: client.patch(PROFILE, json={"full_name": "Ada Lovelace"}, headers=h), lambda h: client.post(COMPLETE, json={}, headers=h)):
        assert call({}).status_code == 401
        assert call({"Authorization": "Bearer nonsense"}).status_code == 401
        assert call(token(client, "root@example.org")).status_code == 403
        assert call(token(client, "u@example.org")).status_code == 403
    assert client.post("/api/v1/auth/login", json={"email": "off@acme.example", "password": PASSWORD}).status_code == 403  # a disabled administrator cannot even sign in


def test_a_token_stops_working_the_moment_the_account_is_disabled(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    headers = token(client, "a@acme.example")
    with session_factory() as db:
        db.get(User, uuid.UUID(user_id)).is_active = False
        db.commit()
    assert client.post(COMPLETE, json={}, headers=headers).status_code == 401
    assert stored(session_factory, user_id)[5] is None


# --- completing ------------------------------------------------------------------------
def test_completing_saves_the_name_and_the_time_together(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    response = client.post(COMPLETE, json={"full_name": "  Ada   Lovelace "}, headers=token(client, "a@acme.example"))
    assert response.status_code == 200
    body = response.json()
    assert body["full_name"] == "Ada Lovelace" and body["profile_setup_completed_at"]
    name, email, role, org, active, completed_at, _ = stored(session_factory, user_id)
    assert (name, email, role, org, active) == ("Ada Lovelace", "a@acme.example", "organization-admin", ORG, True) and completed_at is not None


def test_completing_without_a_name_keeps_the_current_one(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    assert client.post(COMPLETE, json={}, headers=token(client, "a@acme.example")).status_code == 200
    assert stored(session_factory, user_id)[0] == "Olivia Owner" and stored(session_factory, user_id)[5] is not None


def test_a_bad_name_completes_nothing(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    assert client.post(COMPLETE, json={"full_name": "<b>"}, headers=token(client, "a@acme.example")).status_code == 422
    assert stored(session_factory, user_id)[5] is None and stored(session_factory, user_id)[0] == "Olivia Owner"


def test_completing_twice_keeps_the_first_time(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    headers = token(client, "a@acme.example")
    first = client.post(COMPLETE, json={}, headers=headers).json()["profile_setup_completed_at"]
    second = client.post(COMPLETE, json={"full_name": "Olivia Owner-Smith"}, headers=headers)
    assert second.status_code == 200 and second.json()["profile_setup_completed_at"] == first
    assert stored(session_factory, user_id)[0] == "Olivia Owner-Smith"


def test_simultaneous_completions_are_harmless(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    headers = token(client, "a@acme.example")
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: client.post(COMPLETE, json={"full_name": "Ada Lovelace"}, headers=headers).status_code, range(8)))
    assert results == [200] * 8
    assert stored(session_factory, user_id)[0] == "Ada Lovelace" and stored(session_factory, user_id)[5] is not None


def test_completing_does_not_change_credentials(client, session_factory):
    user_id = add_user(session_factory, "a@acme.example")
    before = stored(session_factory, user_id)
    client.post(COMPLETE, json={"full_name": "Ada Lovelace"}, headers=token(client, "a@acme.example"))
    after = stored(session_factory, user_id)
    assert (after[1], after[2], after[3], after[4], after[6]) == (before[1], before[2], before[3], before[4], before[6])
    assert client.post("/api/v1/auth/login", json={"email": "a@acme.example", "password": PASSWORD}).status_code == 200


def test_the_endpoints_are_documented_and_take_no_identity(client):
    spec = client.get("/openapi.json").json()
    for path in (PROFILE, COMPLETE):
        assert path in spec["paths"]
    schema = str(spec["components"]["schemas"]["ProfileUpdate"])
    assert "full_name" in schema and "organization_id" not in schema
