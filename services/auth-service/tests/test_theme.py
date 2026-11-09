"""Each person's own colour theme: identifiers of the approved palettes only, saved against the authenticated user.

Covers: nothing chosen reads as null (the default theme); every approved background x accent pairing (6 x 8) saves and reads back; anything that is not an
approved identifier (a hex value, CSS, a script, a wrong type, an unknown id) is refused with 422 and nothing changes; no other field is accepted (no user id,
role, organization); a token is required; each person has their own preference, and an organization administrator can never change a Super Admin's (or another
administrator's); Super Admins can set their own; the migration only adds nullable columns, so every existing account is unchanged.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.models import User
from app.security import hash_password
from app.theme import ACCENT_IDS, BACKGROUND_IDS, DEFAULT_ACCENT, DEFAULT_BACKGROUND

PASSWORD = "Str0ng!Passphrase"
ORG, OTHER_ORG = str(uuid.uuid4()), str(uuid.uuid4())
THEME = "/api/v1/auth/me/theme"
ME = "/api/v1/auth/me"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email, role="organization-admin", organization_id=ORG, active=True):
    with session_factory() as db:
        user = User(full_name="Olivia Owner", email=email, password_hash=hash_password(PASSWORD), role=role,
                    organization_id=uuid.UUID(organization_id) if organization_id else None, is_active=active)
        db.add(user)
        db.commit()
        return str(user.id)


def token(client, email):
    return {"Authorization": "Bearer " + client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()["access_token"]}


def stored(session_factory, user_id):
    with session_factory() as db:
        user = db.get(User, uuid.UUID(user_id))
        return user.theme_background, user.theme_accent


def test_the_lists_match_what_the_portals_offer_and_include_the_original_theme():
    assert BACKGROUND_IDS == ("original", "burgundy", "ice", "graphite", "deep-purple", "deep-steel-blue")
    assert ACCENT_IDS == ("pale-butter", "champagne-gold", "muted-copper", "frost-blue", "lavender-mist", "sage-silver", "dusty-rose", "silver-pearl")
    assert (DEFAULT_BACKGROUND, DEFAULT_ACCENT) == ("original", "pale-butter")


def test_nothing_chosen_reads_as_null_so_the_portal_shows_the_default(client, session_factory):
    add_user(session_factory, "a@example.org")
    me = client.get(ME, headers=token(client, "a@example.org")).json()
    assert (me["theme_background"], me["theme_accent"]) == (None, None)


@pytest.mark.parametrize("background", BACKGROUND_IDS)
@pytest.mark.parametrize("accent", ACCENT_IDS)
def test_every_pairing_saves_and_reads_back(client, session_factory, background, accent):
    user_id = add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    response = client.put(THEME, json={"background": background, "accent": accent}, headers=headers)
    assert response.status_code == 200, response.text
    assert (response.json()["theme_background"], response.json()["theme_accent"]) == (background, accent)
    assert stored(session_factory, user_id) == (background, accent)
    me = client.get(ME, headers=headers).json()
    assert (me["theme_background"], me["theme_accent"]) == (background, accent)  # what a refresh or a later sign-in sees


def test_saving_again_replaces_it_and_repeating_changes_nothing(client, session_factory):
    user_id = add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    for _ in range(2):
        assert client.put(THEME, json={"background": "ice", "accent": "muted-copper"}, headers=headers).status_code == 200
    assert stored(session_factory, user_id) == ("ice", "muted-copper")
    assert client.put(THEME, json={"background": "original", "accent": "pale-butter"}, headers=headers).status_code == 200  # "Reset to Default"
    assert stored(session_factory, user_id) == ("original", "pale-butter")


@pytest.mark.parametrize("background,accent", [
    ("#35232E", "pale-butter"),  # a colour value is not an identifier
    ("burgundy", "#E8D8A4"),
    ("burgundy; background:url(//evil.example)", "pale-butter"),  # CSS
    ("<script>alert(1)</script>", "pale-butter"),
    ("burgundy", '"><img src=x onerror=alert(1)>'),
    ("Burgundy", "pale-butter"),  # exact identifiers only: no case games
    ("burgundy ", "pale-butter"),
    ("", "pale-butter"),
    ("burgundy", ""),
    ("midnight", "pale-butter"),
    ("burgundy", "neon-green"),
    ("../../etc/passwd", "pale-butter"),
])
def test_anything_that_is_not_an_approved_identifier_is_refused_and_nothing_changes(client, session_factory, background, accent):
    user_id = add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    assert client.put(THEME, json={"background": "graphite", "accent": "frost-blue"}, headers=headers).status_code == 200
    response = client.put(THEME, json={"background": background, "accent": accent}, headers=headers)
    assert response.status_code == 422, response.text
    assert stored(session_factory, user_id) == ("graphite", "frost-blue")


@pytest.mark.parametrize("body", [
    {"background": 1, "accent": "pale-butter"},
    {"background": ["ice"], "accent": "pale-butter"},
    {"background": None, "accent": "pale-butter"},
    {"background": "ice"},
    {"accent": "pale-butter"},
    {},
])
def test_wrong_types_and_missing_fields_are_refused(client, session_factory, body):
    add_user(session_factory, "a@example.org")
    assert client.put(THEME, json=body, headers=token(client, "a@example.org")).status_code == 422


@pytest.mark.parametrize("extra", [{"user_id": str(uuid.uuid4())}, {"role": "super-admin"}, {"organization_id": OTHER_ORG}, {"css": "body{display:none}"}, {"email": "x@example.org"}])
def test_no_other_field_is_accepted(client, session_factory, extra):
    user_id = add_user(session_factory, "a@example.org")
    response = client.put(THEME, json={"background": "ice", "accent": "frost-blue", **extra}, headers=token(client, "a@example.org"))
    assert response.status_code == 422
    assert stored(session_factory, user_id) == (None, None)


def test_a_token_is_required(client):
    body = {"background": "ice", "accent": "frost-blue"}
    assert client.put(THEME, json=body).status_code == 401
    assert client.put(THEME, json=body, headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_a_disabled_account_cannot_save(client, session_factory):
    add_user(session_factory, "off@example.org")
    headers = token(client, "off@example.org")
    with session_factory() as db:
        db.execute(text("UPDATE users SET is_active = false WHERE email = 'off@example.org'"))
        db.commit()
    assert client.put(THEME, json={"background": "ice", "accent": "frost-blue"}, headers=headers).status_code == 401


def test_everybody_has_their_own_theme_and_nobody_can_change_another_persons(client, session_factory):
    a = add_user(session_factory, "a@example.org")
    b = add_user(session_factory, "b@example.org", organization_id=OTHER_ORG)
    sa = add_user(session_factory, "root@example.org", role="super-admin", organization_id=None)
    assert client.put(THEME, json={"background": "burgundy", "accent": "lavender-mist"}, headers=token(client, "a@example.org")).status_code == 200
    assert stored(session_factory, a) == ("burgundy", "lavender-mist")
    assert stored(session_factory, b) == (None, None)  # another administrator (another organization): untouched
    assert stored(session_factory, sa) == (None, None)  # the Super Admin: untouched
    assert client.put(THEME, json={"background": "ice", "accent": "sage-silver"}, headers=token(client, "root@example.org")).status_code == 200
    assert stored(session_factory, sa) == ("ice", "sage-silver")  # a Super Admin sets their own
    assert stored(session_factory, a) == ("burgundy", "lavender-mist")  # and that did not touch the administrator's
    assert client.put(THEME, json={"background": "graphite", "accent": "dusty-rose"}, headers=token(client, "b@example.org")).status_code == 200
    assert stored(session_factory, a) == ("burgundy", "lavender-mist")
    assert stored(session_factory, sa) == ("ice", "sage-silver")


def test_an_unapproved_value_that_somehow_reached_the_database_is_never_passed_on(client, session_factory):
    user_id = add_user(session_factory, "a@example.org")
    with session_factory() as db:
        db.execute(text("UPDATE users SET theme_background = 'red; x', theme_accent = 'pale-butter' WHERE id = :id"), {"id": user_id})
        db.commit()
    me = client.get(ME, headers=token(client, "a@example.org")).json()
    assert me["theme_background"] is None  # reads as "not chosen"
    assert me["theme_accent"] == "pale-butter"


def test_the_migration_only_adds_two_nullable_columns(engine):
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT column_name, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE 'theme_%' ORDER BY column_name")).all()
    assert [tuple(r) for r in rows] == [("theme_accent", "YES", 32), ("theme_background", "YES", 32)]


def test_the_profile_response_keeps_every_field_it_had(client, session_factory):
    add_user(session_factory, "a@example.org")
    me = client.get(ME, headers=token(client, "a@example.org")).json()
    assert {"id", "email", "full_name", "role", "organization_id", "is_active", "created_at", "profile_setup_completed_at"} <= set(me)
    assert "password_hash" not in me
