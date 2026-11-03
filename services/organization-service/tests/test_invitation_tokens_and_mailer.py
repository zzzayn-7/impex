"""Unit tests: token generation/hashing, invitation state, and the SMTP mailer."""
import hashlib
import logging
import re
import smtplib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app import mailer
from app.invitations import (
    INVITATION_TTL,
    build_activation_link,
    generate_token,
    hash_token,
    invitation_status,
    is_active,
)

NOW = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)


# --- token generation -------------------------------------------------------
def test_tokens_are_long_url_safe_and_unique():
    tokens = {generate_token() for _ in range(2000)}
    assert len(tokens) == 2000  # no collisions
    for token in list(tokens)[:50]:
        assert re.fullmatch(r"[A-Za-z0-9_-]{43,}", token)  # 256 bits of randomness, URL safe


def test_hash_is_sha256_hex_and_not_reversible_to_the_token():
    assert hash_token("abc") == hashlib.sha256(b"abc").hexdigest()
    token = generate_token()
    digest = hash_token(token)
    assert re.fullmatch(r"[0-9a-f]{64}", digest) and token not in digest
    assert hash_token(token) == digest and hash_token(token + "x") != digest


def test_activation_link_keeps_the_token_in_the_fragment(monkeypatch):
    monkeypatch.setenv("APP_BASE_URL", "https://admin.example.com/")
    assert build_activation_link("tok") == "https://admin.example.com/activate#token=tok"
    monkeypatch.delenv("APP_BASE_URL")
    assert build_activation_link("tok") == "http://localhost/activate#token=tok"


# --- expiry ----------------------------------------------------------------
def invitation(**fields):
    return SimpleNamespace(accepted_at=None, revoked_at=None, expires_at=NOW + INVITATION_TTL, **fields)


def test_invitations_live_for_exactly_24_hours():
    assert INVITATION_TTL == timedelta(hours=24)
    inv = invitation()
    assert invitation_status(inv, NOW) == "pending" and is_active(inv, NOW)
    assert invitation_status(inv, NOW + timedelta(hours=23, minutes=59)) == "pending"
    assert invitation_status(inv, NOW + timedelta(hours=24)) == "expired"  # the boundary is expired
    assert not is_active(inv, NOW + timedelta(hours=25))


def test_revoked_and_accepted_invitations_are_never_active():
    assert invitation_status(invitation(), NOW) == "pending"
    revoked = invitation()
    revoked.revoked_at = NOW
    accepted = invitation()
    accepted.accepted_at = NOW
    assert invitation_status(revoked, NOW) == "revoked" and not is_active(revoked, NOW)
    assert invitation_status(accepted, NOW) == "accepted" and not is_active(accepted, NOW)


# --- mailer: message content ------------------------------------------------
def settings(**overrides):
    base = dict(host="mailpit", port=1025, username=None, password=None, starttls=False, use_ssl=False,
                from_address="no-reply@impex.local", from_name="Impex", timeout=10.0)
    return mailer.SmtpSettings(**{**base, **overrides})


def test_message_has_text_and_html_parts_with_the_link():
    link = "http://localhost/activate#token=abc_DEF-123"
    message = mailer.build_invitation_message(settings(), "owner@acme.example", "Acme", link, NOW + INVITATION_TTL)
    assert message["To"] == "owner@acme.example"
    assert message["From"] == "Impex <no-reply@impex.local>"
    assert message["Subject"] == "You're invited to administer Acme on Impex"
    text = message.get_body(("plain",)).get_content()
    html_part = message.get_body(("html",)).get_content()
    assert link in text and f'href="{link}"' in html_part
    assert "2026-11-04 12:00 UTC" in text  # expiry shown to the recipient


def test_organization_name_cannot_inject_headers_or_html():
    nasty = "Evil\r\nBcc: attacker@example.com <script>alert(1)</script>"
    message = mailer.build_invitation_message(settings(), "o@x.org", nasty, "http://l/activate#token=t", NOW)
    assert "\n" not in message["Subject"] and "\r" not in message["Subject"]
    assert message["Bcc"] is None
    html_part = message.get_body(("html",)).get_content()
    assert "<script>" not in html_part and "&lt;script&gt;" in html_part


# --- mailer: SMTP behaviour -------------------------------------------------
def send():
    mailer.send_invitation_email("owner@acme.example", "Acme", "http://l/activate#token=secret-token", NOW)


def test_defaults_target_the_mailpit_container(smtp):
    send()
    assert smtp.connections == [
        {"host": "mailpit", "port": 1025, "ssl": False, "starttls": False, "login": None}
    ]
    assert len(smtp.messages) == 1


def test_starttls_and_credentials_are_used_when_configured(smtp, monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.provider.example")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_STARTTLS", "true")
    monkeypatch.setenv("SMTP_USERNAME", "api-user")
    monkeypatch.setenv("SMTP_PASSWORD", "api-secret")
    monkeypatch.setenv("SMTP_FROM_ADDRESS", "invites@impex.example")
    monkeypatch.setenv("SMTP_FROM_NAME", "Impex Team")
    send()
    assert smtp.connections == [
        {"host": "smtp.provider.example", "port": 587, "ssl": False, "starttls": True, "login": ("api-user", "api-secret")}
    ]
    assert smtp.messages[0]["From"] == "Impex Team <invites@impex.example>"


def test_implicit_ssl_is_supported(smtp, monkeypatch):
    monkeypatch.setenv("SMTP_SSL", "1")
    monkeypatch.setenv("SMTP_PORT", "465")
    send()
    assert smtp.connections[0]["ssl"] is True and smtp.connections[0]["port"] == 465


@pytest.mark.parametrize("failure", [
    ConnectionRefusedError("refused"),
    smtplib.SMTPConnectError(421, b"busy"),
    TimeoutError("timed out"),
])
def test_connection_problems_become_delivery_errors(smtp, failure):
    smtp.fail_on_connect = failure
    with pytest.raises(mailer.EmailDeliveryError):
        send()


def test_rejected_message_becomes_a_delivery_error_without_leaking_secrets(smtp, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("SMTP_USERNAME", "api-user")
    monkeypatch.setenv("SMTP_PASSWORD", "api-secret")
    smtp.fail_on_send = smtplib.SMTPRecipientsRefused({"owner@acme.example": (550, b"no such user")})
    with pytest.raises(mailer.EmailDeliveryError) as raised:
        send()
    assert "SMTP delivery failed" in caplog.text  # control: the failure was logged...
    for secret in ("api-secret", "secret-token", "owner@acme.example", "/activate"):
        assert secret not in caplog.text  # ...without any secret
        assert secret not in str(raised.value)
