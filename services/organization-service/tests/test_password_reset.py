"""Super Admin > administrator > Reset password: a strong temporary password is set by the Auth Service and emailed to the address the administrator registered with.

Covers: only a Super Admin can do it; only an administrator who has activated their account of THIS organization; the temporary password is in the email (to the registered address, with the
sign-in link, the 24-hour limit and the instruction to choose a new one) and nowhere else (not in the answer, not in the logs); the Auth Service's refusals (too soon, not found, disabled,
down) are told in words; an email that cannot be sent is reported honestly; and the message is safe to build from any name.
"""
import logging
from datetime import datetime, timedelta, timezone

import pytest

from app.mailer import build_password_reset_message, load_smtp_settings

from test_administrators import ADMIN, ORGS, TOKENS, add, client, fake_auth, make_org, resend, rows  # noqa: F401  (fixtures are used by name)


def reset(client, org_id, admin_id, headers=ADMIN):
    return client.post(f"{ORGS}/{org_id}/administrators/{admin_id}/reset-password", headers=headers)


@pytest.fixture
def demo(monkeypatch):
    """Demo mode creates the account at once, so there is an active administrator to reset."""
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.delenv("DEMO_ADMIN_PASSWORD", raising=False)


def active_admin(client, smtp, **extra):
    org = make_org(client)
    admin = add(client, org["id"], **extra).json()
    assert admin["status"] == "active"
    smtp.messages.clear()  # forget the credentials email of the demo account
    return org, admin


# ---- who can ----------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("headers,expected", [
    ({}, 401), ({"Authorization": "Bearer expired-token"}, 401), ({"Authorization": "Bearer user-token"}, 403), ({"Authorization": "Bearer disabled-admin-token"}, 403),
])
def test_only_a_super_admin_can_reset_a_password(client, smtp, fake_auth, demo, headers, expected):
    org, admin = active_admin(client, smtp)
    assert reset(client, org["id"], admin["id"], headers=headers).status_code == expected
    assert smtp.messages == [] and fake_auth.resets == []


def test_an_administrator_who_has_not_activated_has_no_password_to_reset(client, smtp, fake_auth):
    org = make_org(client)
    admin = add(client, org["id"]).json()  # normal mode: a pending invitation
    smtp.messages.clear()
    response = reset(client, org["id"], admin["id"])
    assert response.status_code == 409 and "not activated" in response.json()["detail"] and "Resend" in response.json()["detail"]
    assert smtp.messages == [] and fake_auth.resets == []


def test_an_administrator_of_another_organization_or_an_unknown_one_cannot_be_reached(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    other = make_org(client, slug="globex", name="Globex")
    assert reset(client, other["id"], admin["id"]).status_code == 404  # right administrator, wrong organization
    assert reset(client, org["id"], "00000000-0000-4000-8000-000000000000").status_code == 404
    assert reset(client, org["id"], "not-an-id").status_code == 404
    assert reset(client, "00000000-0000-4000-8000-000000000000", admin["id"]).status_code == 404
    assert smtp.messages == [] and fake_auth.resets == []


# ---- what happens ------------------------------------------------------------------------------------------------------------------
def test_the_temporary_password_is_emailed_to_the_registered_address_and_only_there(client, smtp, fake_auth, demo, caplog):
    org, admin = active_admin(client, smtp, email="ada@example.org")
    caplog.set_level(logging.DEBUG)
    response = reset(client, org["id"], admin["id"])
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"sent_to", "expires_at"} and body["sent_to"] == "ada@example.org"
    assert timedelta(hours=23, minutes=59) < datetime.fromisoformat(body["expires_at"]) - datetime.now(timezone.utc) <= timedelta(hours=24)
    assert fake_auth.resets == [{"organization_id": org["id"], "email": "ada@example.org"}]

    (message,) = smtp.messages
    password = fake_auth.users["ada@example.org"]["password"]
    assert message["To"] == "ada@example.org" and "reset" in message["Subject"].lower() and "Acme Imports" in message["Subject"]
    text = message.get_body(("plain",)).get_content()
    html = message.get_body(("html",)).get_content()
    for part in (text, html):
        assert password in part  # that is what a reset sends
        assert "ada@example.org" in part and "Acme Imports" in part and "http://portal.test" in part  # who, where, and the sign-in link
    assert "24 hours" in text and "choose a new password" in text
    assert password not in response.text  # never in the answer to the Super Admin
    assert password not in caplog.text and "ada@example.org" not in "".join(r.getMessage() for r in caplog.records if r.name == "impex.administrators")  # nor in the logs


def test_each_reset_sends_a_new_password(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    reset(client, org["id"], admin["id"])
    first = fake_auth.users["ada@example.org"]["password"]
    reset(client, org["id"], admin["id"])
    assert fake_auth.users["ada@example.org"]["password"] != first
    assert len(smtp.messages) == 2 and len(fake_auth.resets) == 2


# ---- when something goes wrong -------------------------------------------------------------------------------------------------------
def test_a_reset_sent_a_moment_ago_is_refused_in_words(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    fake_auth.reset_override = (429, {"detail": {"code": "reset_too_soon", "message": "A new password was sent a moment ago. Wait 42 seconds before sending another.", "retry_after": 42}})
    response = reset(client, org["id"], admin["id"])
    assert response.status_code == 429 and "42 seconds" in response.json()["detail"]
    assert smtp.messages == []


def test_a_disabled_account_and_a_missing_account_are_told_plainly(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    fake_auth.reset_override = (409, {"detail": {"code": "account_disabled", "message": "x"}})
    disabled = reset(client, org["id"], admin["id"])
    assert disabled.status_code == 409 and "disabled" in disabled.json()["detail"]
    fake_auth.reset_override = (404, {"detail": {"code": "not_found", "message": "x"}})
    assert reset(client, org["id"], admin["id"]).status_code == 404
    assert smtp.messages == []


def test_the_account_service_being_down_is_reported_and_nothing_is_sent(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    fake_auth.mode = "down"
    assert reset(client, org["id"], admin["id"]).status_code == 503
    fake_auth.mode = "500"
    assert reset(client, org["id"], admin["id"]).status_code == 503
    assert smtp.messages == []


def test_an_email_that_cannot_be_sent_is_reported_honestly_without_the_password(client, smtp, fake_auth, demo):
    org, admin = active_admin(client, smtp)
    smtp.fail_on_send = OSError("connection refused")
    response = reset(client, org["id"], admin["id"])
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "could not be sent" in detail and "press Reset password again" in detail
    assert fake_auth.users["ada@example.org"]["password"] not in response.text
    assert smtp.messages == []


# ---- the message itself ---------------------------------------------------------------------------------------------------------------
def test_the_message_is_safe_for_any_name_and_any_password(smtp):
    settings = load_smtp_settings()
    message = build_password_reset_message(settings, "ada@example.org", "Acme\r\nBcc: evil@x.y <b>Imports</b>", "http://portal.test/login", "P<a>ss&w\"rd!9", datetime.now(timezone.utc), "<script>alert(1)</script>")
    assert "\n" not in message["Subject"] and "\r" not in message["Subject"] and message["Bcc"] is None  # no header injection
    html = message.get_body(("html",)).get_content()
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "P&lt;a&gt;ss&amp;w&quot;rd!9" in html  # the password is shown exactly, escaped
    assert "P<a>ss&w\"rd!9" in message.get_body(("plain",)).get_content()
