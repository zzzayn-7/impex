"""Tests for the real-email test command and the SMTP failure diagnostics."""
import logging
import smtplib
import ssl
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app import mailer
from app.invitations import hash_token
from app.mailer import EmailDeliveryError, SmtpSettings, describe_failure
from app.models import Organization, OrganizationInvitation
from app.scripts import send_test_invitation as cli

from conftest import token_from_message

ME = "me@gmail.com"
GMAIL_ENV = {
    "SMTP_HOST": "smtp.gmail.com",
    "SMTP_PORT": "587",
    "SMTP_STARTTLS": "true",
    "SMTP_USERNAME": "me@gmail.com",
    "SMTP_PASSWORD": "super-secret-app-password",
    "SMTP_FROM_ADDRESS": "me@gmail.com",
}


@pytest.fixture(autouse=True)
def use_test_database(monkeypatch, session_factory):
    """cli.main() opens its own session; never let it reach the real impex_organizations database."""
    monkeypatch.setattr(cli, "SessionLocal", session_factory)


@pytest.fixture
def gmail(smtp, monkeypatch):
    for key, value in GMAIL_ENV.items():
        monkeypatch.setenv(key, value)
    return smtp


def settings(**overrides) -> SmtpSettings:
    base = dict(host="smtp.gmail.com", port=587, username="me@gmail.com", password="pw", starttls=True,
                use_ssl=False, from_address="me@gmail.com", from_name="Impex", timeout=10.0)
    return SmtpSettings(**{**base, **overrides})


# --- Gmail configuration is honoured ---------------------------------------
def test_gmail_settings_use_starttls_and_login(gmail, session_factory):
    with session_factory() as db:
        cli.send_test_invitation(db, ME)
    assert gmail.connections == [{
        "host": "smtp.gmail.com", "port": 587, "ssl": False, "starttls": True,
        "login": ("me@gmail.com", "super-secret-app-password"),
    }]
    (message,) = gmail.messages
    assert message["To"] == ME and message["From"] == "Impex <me@gmail.com>"


# --- the command sends a real, secure, expiring invitation ------------------
def test_sends_a_real_invitation_to_the_given_address(gmail, session_factory):
    with session_factory() as db:
        invitation = cli.send_test_invitation(db, ME)
    token = token_from_message(gmail.messages[0])
    assert f"/activate#token={token}" in gmail.messages[0].get_body(("plain",)).get_content()

    with session_factory() as db:
        org = db.scalars(select(Organization)).one()
        row = db.scalars(select(OrganizationInvitation)).one()
    assert (org.primary_admin_email, org.slug) == (ME, cli.org_slug_for(ME))
    assert row.id == invitation.id and row.email == ME
    assert row.token_hash == hash_token(token) != token  # only the hash is stored
    assert (row.expires_at - row.created_at).total_seconds() == 24 * 3600


def test_running_again_resends_and_invalidates_the_previous_link(gmail, session_factory):
    with session_factory() as db:
        cli.send_test_invitation(db, ME)
    with session_factory() as db:
        cli.send_test_invitation(db, ME)
    first, second = (token_from_message(m) for m in gmail.messages)
    assert first != second
    with session_factory() as db:
        assert len(db.scalars(select(Organization)).all()) == 1  # same test organization reused
        old, new = db.scalars(select(OrganizationInvitation).order_by(OrganizationInvitation.created_at)).all()
    assert old.token_hash == hash_token(first) and old.revoked_at is not None
    assert new.token_hash == hash_token(second) and new.revoked_at is None


def test_cleanup_removes_the_test_organization_and_its_invitations(gmail, session_factory):
    with session_factory() as db:
        cli.send_test_invitation(db, ME)
    with session_factory() as db:
        assert cli.cleanup(db, ME) is True
        assert cli.cleanup(db, ME) is False  # nothing left
    with session_factory() as db:
        assert db.scalars(select(Organization)).all() == []
        assert db.scalars(select(OrganizationInvitation)).all() == []


def test_does_not_touch_other_organizations(gmail, session_factory):
    with session_factory() as db:
        db.add(Organization(name="Real Co", slug="real-co", country_code="DE", contact_email="a@b.org"))
        db.commit()
        cli.send_test_invitation(db, ME)
        cli.cleanup(db, ME)
    with session_factory() as db:
        assert [o.slug for o in db.scalars(select(Organization))] == ["real-co"]


# --- main(): output never contains secrets ----------------------------------
def run_main(capsys, *args):
    code = cli.main(list(args))
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def test_main_success_output_has_no_password_or_token(gmail, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    code, output = run_main(capsys, "--to", ME)
    token = token_from_message(gmail.messages[0])
    assert "issued for organization" in caplog.text  # control: logging works
    assert code == 0
    assert "Invitation sent to me@gmail.com" in output and "24 hours" in output
    assert "smtp.gmail.com:587" in output and "STARTTLS" in output
    for secret in ("super-secret-app-password", token, hash_token(token), "/activate"):
        assert secret not in output and secret not in caplog.text
    cli.main(["--to", ME, "--cleanup"])


def test_main_reports_authentication_failure_without_leaking_credentials(gmail, capsys, caplog):
    gmail.fail_on_send = smtplib.SMTPAuthenticationError(535, b"5.7.8 Username and Password not accepted")
    code, output = run_main(capsys, "--to", ME)
    assert code == 1
    assert "FAILED (502)" in output and "App Password" in output
    assert "authentication failed" in caplog.text  # control: logging works
    assert "super-secret-app-password" not in output + caplog.text
    # nothing half-created: the test organization exists but has no invitation
    cli.main(["--to", ME, "--cleanup"])


def test_main_rejects_an_invalid_address(gmail, capsys):
    with pytest.raises(SystemExit) as exited:
        cli.main(["--to", "not-an-email"])
    assert exited.value.code == 2
    assert "not a valid email" in capsys.readouterr().err


def test_main_refuses_credentials_without_encryption(smtp, monkeypatch, capsys):
    for key, value in {**GMAIL_ENV, "SMTP_STARTTLS": "false"}.items():
        monkeypatch.setenv(key, value)
    code, output = run_main(capsys, "--to", ME)
    assert code == 2 and "unencrypted" in output
    assert smtp.connections == [] and smtp.messages == []  # nothing was attempted


def test_main_warns_when_mail_only_goes_to_mailpit(smtp, capsys):
    code, output = run_main(capsys, "--to", ME)
    assert code == 0 and "Mailpit" in output and "NOT in a real mailbox" in output
    cli.main(["--to", ME, "--cleanup"])


def test_settings_check():
    assert cli.check_settings(settings())[0] == []
    assert "both be set" in cli.check_settings(settings(password=None))[0][0]
    assert "Gmail" in cli.check_settings(settings(username=None, password=None))[0][0]  # Gmail needs a login
    assert cli.check_settings(settings(host="smtp.example.com", username=None, password=None))[0] == []
    assert "unencrypted" in cli.check_settings(settings(starttls=False))[0][0]
    assert cli.check_settings(settings(from_address="no-reply@impex.local"))[1]  # note about the sender


# --- failure diagnostics ----------------------------------------------------
@pytest.mark.parametrize("failure,expected", [
    (smtplib.SMTPAuthenticationError(535, b"bad credentials"), "App Password"),
    (ssl.SSLCertVerificationError("certificate verify failed"), "could not be verified"),
    (ssl.SSLError("handshake failure"), "TLS negotiation"),
    (smtplib.SMTPNotSupportedError("STARTTLS extension not supported by server."), "STARTTLS or AUTH"),
    (smtplib.SMTPRecipientsRefused({"x@y.org": (550, b"no")}), "rejected"),
    (ConnectionRefusedError("refused"), "could not connect to smtp.gmail.com:587"),
    (TimeoutError("timed out"), "could not connect to smtp.gmail.com:587"),
    (smtplib.SMTPServerDisconnected("gone"), "could not connect"),
])
def test_failures_are_described_without_secrets(failure, expected):
    reason = describe_failure(failure, settings())
    assert expected in reason
    for secret in ("x@y.org", "bad credentials", "pw"):
        assert secret not in reason


def test_delivery_error_carries_the_safe_reason(smtp, monkeypatch):
    smtp.fail_on_connect = smtplib.SMTPAuthenticationError(535, b"nope")
    with pytest.raises(EmailDeliveryError, match="App Password"):
        mailer.send_invitation_email("o@x.org", "Acme", "http://l/activate#token=t", datetime.now(timezone.utc))
