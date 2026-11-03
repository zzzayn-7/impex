"""Invitation API tests: authorization, token handling, expiry, duplicates/resend, email delivery.

SMTP is replaced by a fake (see conftest.py); test_mailpit_delivery.py covers the real Mailpit.
"""
import logging
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth import get_auth_client
from app.invitations import hash_token
from app.main import app
from app.models import OrganizationInvitation

from conftest import fake_auth_client, token_from_message

SUPER_ADMIN = {"id": "1", "email": "root@example.org", "full_name": "Root", "role": "super-admin", "is_active": True}
TOKENS = {
    "admin-token": (200, SUPER_ADMIN),
    "user-token": (200, {**SUPER_ADMIN, "role": "user"}),
    "disabled-admin-token": (200, {**SUPER_ADMIN, "is_active": False}),
    "expired-token": (401, {"detail": "Invalid or expired token"}),
}
ADMIN = {"Authorization": "Bearer admin-token"}
ORGS = "/api/v1/organizations"
ADMIN_EMAIL = "owner@acme.example"


@pytest.fixture
def client(smtp):
    auth = fake_auth_client(TOKENS)
    app.dependency_overrides[get_auth_client] = lambda: auth
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)


def create_org(client, slug="acme", primary_admin_email=ADMIN_EMAIL):
    payload = {"name": "Acme Imports", "slug": slug, "country_code": "DE", "contact_email": "ops@acme.example"}
    if primary_admin_email:
        payload["primary_admin_email"] = primary_admin_email
    response = client.post(ORGS, json=payload, headers=ADMIN)
    assert response.status_code == 201
    return response.json()


def invitations(session_factory):
    with session_factory() as db:
        return db.scalars(select(OrganizationInvitation).order_by(OrganizationInvitation.created_at)).all()


def invite(client, org_id, headers=ADMIN):
    return client.post(f"{ORGS}/{org_id}/invitations", headers=headers)


def resend(client, org_id, headers=ADMIN):
    return client.post(f"{ORGS}/{org_id}/invitations/resend", headers=headers)


# --- authorization ----------------------------------------------------------
@pytest.mark.parametrize("action", [invite, resend], ids=["invite", "resend"])
class TestAuthorization:
    def test_missing_token_returns_401(self, client, session_factory, smtp, action):
        org = create_org(client)
        assert action(client, org["id"], headers={}).status_code == 401
        assert smtp.messages == [] and invitations(session_factory) == []

    def test_invalid_or_expired_token_returns_401(self, client, session_factory, smtp, action):
        org = create_org(client)
        for token in ("expired-token", "made-up"):
            assert action(client, org["id"], headers={"Authorization": f"Bearer {token}"}).status_code == 401
        assert smtp.messages == [] and invitations(session_factory) == []

    def test_regular_user_returns_403(self, client, session_factory, smtp, action):
        org = create_org(client)
        assert action(client, org["id"], headers={"Authorization": "Bearer user-token"}).status_code == 403
        assert smtp.messages == [] and invitations(session_factory) == []

    def test_inactive_super_admin_returns_403(self, client, session_factory, smtp, action):
        org = create_org(client)
        assert action(client, org["id"], headers={"Authorization": "Bearer disabled-admin-token"}).status_code == 403
        assert smtp.messages == [] and invitations(session_factory) == []

    def test_spoofed_role_header_is_ignored(self, client, smtp, action):
        org = create_org(client)
        headers = {"Authorization": "Bearer user-token", "X-User-Role": "super-admin"}
        assert action(client, org["id"], headers=headers).status_code == 403

    def test_unknown_organization_returns_404(self, client, smtp, action):
        assert action(client, "00000000-0000-4000-8000-000000000000").status_code == 404
        assert action(client, "no-such-slug").status_code == 404
        assert smtp.messages == []


# --- creating an invitation -------------------------------------------------
def test_invite_stores_only_the_hash_and_emails_the_token(client, session_factory, smtp):
    org = create_org(client)
    before = datetime.now(timezone.utc)
    response = invite(client, org["id"])
    assert response.status_code == 201
    body = response.json()

    assert set(body) == {"id", "organization_id", "email", "status", "expires_at", "accepted_at", "created_at"}
    assert (body["organization_id"], body["email"], body["status"], body["accepted_at"]) == (
        org["id"], ADMIN_EMAIL, "pending", None,
    )

    # exactly one email, to the primary admin, with a one-time activation link
    assert len(smtp.messages) == 1
    message = smtp.messages[0]
    assert message["To"] == ADMIN_EMAIL
    assert message["From"] == "Impex <no-reply@impex.local>"
    assert "Acme Imports" in message["Subject"]
    token = token_from_message(message)
    assert f"http://app.test/activate#token={token}" in message.get_body(("plain",)).get_content()
    assert f"http://app.test/activate#token={token}" in message.get_body(("html",)).get_content()

    # database: the hash, not the token, and nothing that contains the token
    (row,) = invitations(session_factory)
    assert row.token_hash == hash_token(token) != token
    assert len(row.token_hash) == 64
    assert all(token not in str(value) for value in vars(row).values())
    assert row.accepted_at is None and row.revoked_at is None

    # expires 24 hours after creation
    assert row.expires_at - row.created_at == timedelta(hours=24)
    assert before <= row.created_at <= datetime.now(timezone.utc)

    # API response: no token, no link, no hash
    assert token not in response.text
    assert "activate" not in response.text and row.token_hash not in response.text


def test_invite_works_by_slug(client, smtp):
    create_org(client, slug="acme-slug")
    assert invite(client, "acme-slug").status_code == 201


def test_invite_requires_a_primary_admin_email(client, session_factory, smtp):
    org = create_org(client, primary_admin_email=None)
    response = invite(client, org["id"])
    assert response.status_code == 409
    assert "primary administrator" in response.json()["detail"]
    assert smtp.messages == [] and invitations(session_factory) == []


def test_token_never_appears_in_logs(client, smtp, caplog):
    caplog.set_level(logging.DEBUG)
    org = create_org(client)
    invite(client, org["id"])
    resend(client, org["id"])
    tokens = [token_from_message(m) for m in smtp.messages]
    assert len(tokens) == 2
    assert caplog.text.count("issued for organization") == 2  # control: logging is really being captured
    for token in tokens:
        assert token not in caplog.text
        assert hash_token(token) not in caplog.text
    assert "/activate" not in caplog.text


# --- duplicates, resend, expiry ---------------------------------------------
def test_second_invite_while_active_is_rejected(client, session_factory, smtp):
    org = create_org(client)
    assert invite(client, org["id"]).status_code == 201
    duplicate = invite(client, org["id"])
    assert duplicate.status_code == 409
    assert "resend" in duplicate.json()["detail"].lower()
    assert len(smtp.messages) == 1  # no second email
    assert len(invitations(session_factory)) == 1


def test_resend_invalidates_the_previous_token(client, session_factory, smtp):
    org = create_org(client)
    first = invite(client, org["id"]).json()
    second = resend(client, org["id"])
    assert second.status_code == 201
    assert second.json()["id"] != first["id"]

    old_token, new_token = (token_from_message(m) for m in smtp.messages)
    assert old_token != new_token

    old_row, new_row = invitations(session_factory)
    assert old_row.token_hash == hash_token(old_token) and old_row.revoked_at is not None
    assert new_row.token_hash == hash_token(new_token) and new_row.revoked_at is None
    assert new_row.expires_at > old_row.expires_at
    assert [r for r in (old_row, new_row) if r.revoked_at is None and r.accepted_at is None] == [new_row]

    # the old invitation cannot be revived by inviting again either
    assert invite(client, org["id"]).status_code == 409


def test_resend_without_an_invitation_returns_404(client, session_factory, smtp):
    org = create_org(client)
    response = resend(client, org["id"])
    assert response.status_code == 404
    assert smtp.messages == [] and invitations(session_factory) == []


def test_expired_invitation_does_not_block_a_new_one(client, session_factory, smtp):
    org = create_org(client)
    invite(client, org["id"])
    with session_factory() as db:  # simulate 24h+ passing
        row = db.scalars(select(OrganizationInvitation)).one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()

    renewed = invite(client, org["id"])
    assert renewed.status_code == 201

    old_row, new_row = invitations(session_factory)
    assert old_row.revoked_at is not None  # the expired token is explicitly dead
    assert new_row.revoked_at is None and new_row.expires_at > datetime.now(timezone.utc)
    assert token_from_message(smtp.messages[0]) != token_from_message(smtp.messages[1])


def test_resend_also_replaces_an_expired_invitation(client, session_factory, smtp):
    org = create_org(client)
    invite(client, org["id"])
    with session_factory() as db:
        db.scalars(select(OrganizationInvitation)).one().expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.commit()
    assert resend(client, org["id"]).status_code == 201
    assert len(smtp.messages) == 2


@pytest.mark.parametrize("action", [invite, resend], ids=["invite", "resend"])
def test_accepted_invitation_blocks_further_invitations(client, session_factory, smtp, action):
    org = create_org(client)
    invite(client, org["id"])
    with session_factory() as db:
        db.scalars(select(OrganizationInvitation)).one().accepted_at = datetime.now(timezone.utc)
        db.commit()
    response = action(client, org["id"])
    assert response.status_code == 409
    assert "accepted" in response.json()["detail"]
    assert len(smtp.messages) == 1


def test_database_allows_only_one_pending_invitation_per_organization(client, session_factory, smtp):
    org = create_org(client)
    invite(client, org["id"])
    with session_factory() as db:
        db.add(OrganizationInvitation(
            organization_id=db.scalars(select(OrganizationInvitation.organization_id)).one(),
            email=ADMIN_EMAIL,
            token_hash="f" * 64,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        ))
        with pytest.raises(IntegrityError):
            db.commit()


# --- email delivery failures leave no trace ---------------------------------
def test_email_failure_on_invite_returns_502_and_stores_nothing(client, session_factory, smtp, caplog):
    caplog.set_level(logging.DEBUG)
    smtp.fail_on_connect = ConnectionRefusedError("mail server down")
    org = create_org(client)
    response = invite(client, org["id"])
    assert response.status_code == 502
    assert "could not be sent" in response.json()["detail"]
    assert invitations(session_factory) == []
    assert "SMTP delivery failed" in caplog.text  # control: the failure was logged...
    assert ADMIN_EMAIL not in caplog.text  # ...but the recipient is not

    smtp.fail_on_connect = None  # server comes back: inviting works, nothing was left blocking it
    assert invite(client, org["id"]).status_code == 201


def test_email_failure_on_resend_keeps_the_previous_invitation_valid(client, session_factory, smtp):
    org = create_org(client)
    invite(client, org["id"])
    (before,) = invitations(session_factory)

    smtp.fail_on_send = OSError("connection reset")
    assert resend(client, org["id"]).status_code == 502

    (after,) = invitations(session_factory)  # still exactly one row, still pending, same token
    assert (after.id, after.token_hash, after.revoked_at) == (before.id, before.token_hash, None)
    assert len(smtp.messages) == 1
