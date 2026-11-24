"""Password reset by the Super Admin, and the person's own change of password.

Covers: the temporary password is strong and unambiguous; only an active administrator of the NAMED organization can be reset (never a Super Admin, another organization, an unknown or a
disabled account); the old password stops working at once and so does every older sign-in; the new one works for 24 hours, marks the account "must change password" and is only ever stored
as a hash; a reset cannot be sent twice within a minute; an expired temporary password is refused with its own message; the person's own change needs the right current password, a strong
different new one, accepts nothing else, ends older sign-ins and returns a fresh one; and nothing about an account that was never reset changes.
"""
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import select

from app.main import ALGORITHM, SECRET_KEY, app
from app.models import User
from app.security import generate_temporary_password, hash_password, password_problems, verify_password

from conftest import INTERNAL_KEY

RESET = "/internal/organization-admins/reset-password"
LOGIN = "/api/v1/auth/login"
ME = "/api/v1/auth/me"
CHANGE = "/api/v1/auth/me/password"
KEY = {"X-Internal-Key": INTERNAL_KEY}
ORG = str(uuid.uuid4())
OLD = "Str0ng!Passphrase"
NEW = "An0ther!Passphrase9"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email="owner@acme.example", role="organization-admin", organization_id=ORG, active=True, password=OLD):
    with session_factory() as db:
        user = User(full_name="Olivia Owner", email=email, password_hash=hash_password(password), role=role,
                    organization_id=uuid.UUID(organization_id) if organization_id else None, is_active=active)
        db.add(user)
        db.commit()
        return str(user.id)


def user_row(session_factory, email="owner@acme.example"):
    with session_factory() as db:
        return db.scalar(select(User).where(User.email == email))


def login(client, email="owner@acme.example", password=OLD):
    return client.post(LOGIN, json={"email": email, "password": password})


def bearer(response):
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def reset(client, email="owner@acme.example", organization_id=ORG, headers=KEY):
    return client.post(RESET, json={"organization_id": organization_id, "email": email}, headers=headers)


def forget_the_cooldown(session_factory, email="owner@acme.example"):
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == email))
        user.password_reset_sent_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        db.commit()


# ---- the temporary password ---------------------------------------------------------------------------------------------------------
def test_a_temporary_password_is_strong_unambiguous_and_different_every_time():
    seen = set()
    for _ in range(200):
        password = generate_temporary_password("owner@acme.example")
        assert len(password) == 16 and password_problems(password, "owner@acme.example") == []
        assert not set(password) & set("0O1lI|`'\"\\ ")  # nothing that looks alike or breaks when pasted
        assert sum(c.isdigit() for c in password) >= 3 and sum(not c.isalnum() for c in password) >= 2
        seen.add(password)
    assert len(seen) == 200


def test_a_temporary_password_never_contains_part_of_the_email():
    for _ in range(200):
        password = generate_temporary_password("zainabc@acme.example")
        assert "zainabc" not in password.lower()


# ---- who can be reset ---------------------------------------------------------------------------------------------------------------
def test_the_service_key_is_required(client, session_factory):
    add_user(session_factory)
    assert reset(client, headers={}).status_code == 401
    assert reset(client, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert verify_password(OLD, user_row(session_factory).password_hash)  # nothing changed


def test_an_unknown_account_another_organization_and_a_super_admin_cannot_be_reset(client, session_factory):
    add_user(session_factory)
    add_user(session_factory, "root@impex.example", role="super-admin", organization_id=None)
    assert reset(client, "nobody@acme.example").status_code == 404
    assert reset(client, organization_id=str(uuid.uuid4())).status_code == 404  # right email, wrong organization
    assert reset(client, "root@impex.example", organization_id=ORG).status_code == 404
    assert reset(client, "root@impex.example", organization_id=str(uuid.uuid4())).status_code == 404
    assert verify_password(OLD, user_row(session_factory, "root@impex.example").password_hash)


def test_a_disabled_account_cannot_be_reset(client, session_factory):
    add_user(session_factory, active=False)
    response = reset(client)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "account_disabled"


# ---- the reset ----------------------------------------------------------------------------------------------------------------------
def test_the_reset_replaces_the_password_at_once_and_returns_the_new_one_only_to_the_trusted_caller(client, session_factory):
    add_user(session_factory)
    response = reset(client)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"email", "full_name", "password", "expires_at"} and body["email"] == "owner@acme.example"
    temporary = body["password"]
    assert password_problems(temporary, body["email"]) == []
    assert login(client, password=OLD).status_code == 401  # the old password is gone
    assert login(client, password=temporary).status_code == 200
    user = user_row(session_factory)
    assert user.password_hash != temporary and temporary not in str(vars(user))  # only a hash is kept
    assert user.must_change_password is True
    expires = datetime.fromisoformat(body["expires_at"])
    assert timedelta(hours=23, minutes=59) < expires - datetime.now(timezone.utc) <= timedelta(hours=24)


def test_a_sign_in_with_the_temporary_password_says_the_password_must_be_changed(client, session_factory):
    add_user(session_factory)
    temporary = reset(client).json()["password"]
    signed_in = login(client, password=temporary)
    assert signed_in.json()["must_change_password"] is True
    assert client.get(ME, headers=bearer(signed_in)).json()["must_change_password"] is True


def test_an_account_that_was_never_reset_is_not_asked_to_change_anything(client, session_factory):
    add_user(session_factory)
    signed_in = login(client)
    assert signed_in.json()["must_change_password"] is False
    assert client.get(ME, headers=bearer(signed_in)).json()["must_change_password"] is False


def test_a_reset_ends_every_older_sign_in(client, session_factory):
    add_user(session_factory)
    old_session = bearer(login(client))
    assert client.get(ME, headers=old_session).status_code == 200
    temporary = reset(client).json()["password"]
    assert client.get(ME, headers=old_session).status_code == 401  # a forgotten or stolen password cannot keep a session alive
    assert client.get(ME, headers=bearer(login(client, password=temporary))).status_code == 200


def test_a_reset_cannot_be_sent_twice_within_a_minute(client, session_factory):
    add_user(session_factory)
    first = reset(client).json()["password"]
    again = reset(client)
    assert again.status_code == 429 and again.json()["detail"]["code"] == "reset_too_soon" and again.json()["detail"]["retry_after"] <= 61
    assert login(client, password=first).status_code == 200  # the first temporary password was not replaced
    forget_the_cooldown(session_factory)
    second = reset(client)
    assert second.status_code == 200 and second.json()["password"] != first
    assert login(client, password=first).status_code == 401


def test_a_temporary_password_that_was_never_used_expires_after_24_hours(client, session_factory):
    add_user(session_factory)
    temporary = reset(client).json()["password"]
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@acme.example"))
        user.password_reset_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    expired = login(client, password=temporary)
    assert expired.status_code == 403 and expired.json()["detail"]["code"] == "temporary_password_expired"
    assert "new one" in expired.json()["detail"]["message"]
    forget_the_cooldown(session_factory)
    assert login(client, password=reset(client).json()["password"]).status_code == 200  # a fresh reset works again


# ---- the person's own change ----------------------------------------------------------------------------------------------------------
def test_choosing_a_new_password_clears_the_requirement_and_returns_a_fresh_sign_in(client, session_factory):
    add_user(session_factory)
    temporary = reset(client).json()["password"]
    session = bearer(login(client, password=temporary))
    changed = client.post(CHANGE, json={"current_password": temporary, "new_password": NEW}, headers=session)
    assert changed.status_code == 200 and changed.json()["must_change_password"] is False
    assert client.get(ME, headers=session).status_code == 401  # the session made with the temporary password ends
    fresh = bearer(changed)
    profile = client.get(ME, headers=fresh).json()
    assert profile["must_change_password"] is False
    assert login(client, password=temporary).status_code == 401
    assert login(client, password=NEW).json()["must_change_password"] is False
    user = user_row(session_factory)
    assert user.must_change_password is False and user.password_reset_expires_at is None and NEW not in str(vars(user))


def test_the_current_password_must_be_right(client, session_factory):
    add_user(session_factory)
    session = bearer(login(client))
    wrong = client.post(CHANGE, json={"current_password": "Wr0ng!Passphrase", "new_password": NEW}, headers=session)
    assert wrong.status_code == 403 and wrong.json()["detail"]["code"] == "wrong_password"
    assert login(client, password=OLD).status_code == 200  # nothing changed


@pytest.mark.parametrize("weak,expected", [("short", "at least 8 characters"), ("alllowercase123!", "an uppercase letter"), ("ALLUPPERCASE123!", "a lowercase letter"),
                                            ("NoDigitsHere!!!!", "a digit"), ("NoSymbols12345Aa", "a symbol"), ("Owner!Passphrase9", "no part of your email address")])
def test_a_weak_new_password_is_refused_with_the_missing_pieces_and_nothing_changes(client, session_factory, weak, expected):
    add_user(session_factory)
    response = client.post(CHANGE, json={"current_password": OLD, "new_password": weak}, headers=bearer(login(client)))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "weak_password"
    assert any(expected in p for p in response.json()["detail"]["problems"]), response.json()
    assert weak not in response.text  # a rejected password is never echoed back
    assert login(client, password=OLD).status_code == 200


def test_the_new_password_must_differ_from_the_current_one(client, session_factory):
    add_user(session_factory)
    response = client.post(CHANGE, json={"current_password": OLD, "new_password": OLD}, headers=bearer(login(client)))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "same_password"


def test_a_very_long_password_is_refused_without_hashing_it(client, session_factory):
    add_user(session_factory)
    session = bearer(login(client))
    assert client.post(CHANGE, json={"current_password": OLD, "new_password": "Aa1!" * 100}, headers=session).status_code == 422
    assert client.post(CHANGE, json={"current_password": "x" * 1000, "new_password": NEW}, headers=session).status_code == 403


def test_only_the_two_passwords_are_accepted_and_a_session_is_required(client, session_factory):
    add_user(session_factory)
    session = bearer(login(client))
    assert client.post(CHANGE, json={"current_password": OLD, "new_password": NEW, "email": "evil@x.y"}, headers=session).status_code == 422
    assert client.post(CHANGE, json={"current_password": OLD, "new_password": NEW, "role": "super-admin"}, headers=session).status_code == 422
    assert client.post(CHANGE, json={"current_password": OLD, "new_password": NEW}).status_code == 401
    assert client.post(CHANGE, json={"current_password": OLD, "new_password": NEW}, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_a_person_only_ever_changes_their_own_password(client, session_factory):
    add_user(session_factory)
    add_user(session_factory, "other@acme.example")
    client.post(CHANGE, json={"current_password": OLD, "new_password": NEW}, headers=bearer(login(client)))
    assert login(client, "other@acme.example", OLD).status_code == 200
    assert login(client, "owner@acme.example", NEW).status_code == 200


def test_a_session_issued_before_passwords_could_change_still_works_until_one_changes(client, session_factory):
    user_id = add_user(session_factory)
    legacy = jwt.encode({"sub": user_id, "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, SECRET_KEY, algorithm=ALGORITHM)  # no "iat": made before this feature
    assert client.get(ME, headers={"Authorization": "Bearer " + legacy}).status_code == 200
    reset(client)
    assert client.get(ME, headers={"Authorization": "Bearer " + legacy}).status_code == 401


def test_the_reset_endpoints_are_not_in_the_public_api_docs(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert RESET not in paths
    assert CHANGE in paths  # the person's own change is a normal, documented route
