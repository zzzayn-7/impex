"""The durable email outbox: notification records, what the emails contain, delivery, SMTP outages and retries, failure visibility,
concurrent workers, and the background worker itself."""
import smtplib
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.main import app
from app.models import SupportEmailOutbox, SupportTicket
from app.outbox import process_batch

from conftest import ADMIN, SUPPORT_EMAIL, html_text, plain_text


def notes(session_factory):
    with session_factory() as db:
        return db.scalars(select(SupportEmailOutbox).order_by(SupportEmailOutbox.created_at, SupportEmailOutbox.id)).all()


def make_due(session_factory):
    with session_factory() as db:
        db.execute(text("UPDATE support_email_outbox SET next_retry_at = now() - interval '1 second' WHERE delivery_status = 'pending'"))
        db.commit()


def run(session_factory):
    return process_batch(session_factory)


# =====================================================================================================
# the records
# =====================================================================================================
def test_every_event_that_needs_an_email_leaves_one_durable_record_with_a_fixed_recipient(world, session_factory):
    ticket = world["alpha"].ticket()
    world["root"].reply(ticket["id"], body="Hello Alice")
    world["alpha"].follow_up(ticket["id"], "Thanks")
    recorded = [(n.notification_type, n.recipient, n.delivery_status, n.attempts, n.sent_at) for n in notes(session_factory)]
    assert recorded == [("new_ticket", SUPPORT_EMAIL, "pending", 0, None), ("staff_reply", "alice@alpha.example", "pending", 0, None), ("customer_followup", SUPPORT_EMAIL, "pending", 0, None)]


def test_the_requester_address_is_the_one_verified_when_the_ticket_was_opened(world, session_factory):
    ticket = world["alpha"].ticket()
    world["directory"].users["alpha"]["email"] = "changed@alpha.example"  # the account's address changes later
    world["root"].reply(ticket["id"])
    assert [n.recipient for n in notes(session_factory) if n.notification_type == "staff_reply"] == ["alice@alpha.example"]


def test_a_second_administrators_follow_up_does_not_redirect_the_requesters_replies(world, session_factory):
    ticket = world["alpha"].ticket()
    world["alpha2"].follow_up(ticket["id"])
    world["root"].reply(ticket["id"])
    assert [n.recipient for n in notes(session_factory) if n.notification_type == "staff_reply"] == ["alice@alpha.example"]


# =====================================================================================================
# the emails
# =====================================================================================================
def test_a_new_ticket_email_goes_to_the_support_address_with_the_ticket_the_organization_the_category_and_a_link(world, session_factory, smtp):
    ticket = world["alpha"].ticket(subject="Cannot print labels", category="change_request", message="PRIVATE BODY TEXT")
    assert run(session_factory) == {"sent": 1, "retry": 0, "failed": 0}
    (mail,) = smtp.messages
    assert (mail["To"], mail["From"]) == (SUPPORT_EMAIL, "Impex <no-reply@impex.test>")
    assert mail["Subject"] == "[SUP-000001] New support request from Alpha Trading: Cannot print labels" and mail["X-Impex-Ticket"] == "SUP-000001"
    text_body = plain_text(mail)
    for expected in ("SUP-000001", "Alpha Trading", "Change Request", "Cannot print labels", f"http://admin.test/support/{ticket['id']}"):
        assert expected in text_body, expected
    assert "PRIVATE BODY TEXT" not in text_body and "PRIVATE BODY TEXT" not in html_text(mail)  # the request itself is read in the portal


def test_a_reply_email_goes_to_the_requester_with_the_reply_and_a_link_to_their_ticket_page(world, session_factory, smtp):
    ticket = world["alpha"].ticket(subject="Printer")
    world["root"].reply(ticket["id"], body="Please restart the print spooler.\nThen try again.")
    run(session_factory)
    mail = next(m for m in smtp.messages if m["To"] == "alice@alpha.example")
    assert mail["Subject"] == "[SUP-000001] Impex Support replied: Printer"
    for expected in ("Please restart the print spooler.\nThen try again.", f"http://portal.test/support/{ticket['id']}", "SUP-000001"):
        assert expected in plain_text(mail)
    assert "Please restart the print spooler." in html_text(mail)


def test_a_follow_up_email_notifies_the_support_address_again(world, session_factory, smtp):
    ticket = world["alpha"].ticket()
    world["alpha"].follow_up(ticket["id"], "SECRET FOLLOW UP")
    run(session_factory)
    follow = [m for m in smtp.messages if "follow-up" in m["Subject"]]
    assert len(follow) == 1 and follow[0]["To"] == SUPPORT_EMAIL and "SECRET FOLLOW UP" not in plain_text(follow[0])
    assert f"http://admin.test/support/{ticket['id']}" in plain_text(follow[0])


def test_hostile_text_cannot_inject_a_header_or_markup_into_an_email(world, session_factory, smtp):
    ticket = world["alpha"].ticket(subject='Hi\r\nBcc: evil@example.org\r\nSubject: pwned <script>alert(1)</script>', message="m")
    world["root"].reply(ticket["id"], body='<img src=x onerror=alert(1)> & <script>steal()</script>\r\nBcc: evil@example.org')
    run(session_factory)
    for mail in smtp.messages:
        assert mail["Bcc"] is None and mail["Cc"] is None and len(mail.get_all("To")) == 1 and len(mail.get_all("Subject")) == 1
        assert "\n" not in mail["Subject"] and "evil@example.org" not in (mail["To"] or "")
    reply_mail = next(m for m in smtp.messages if m["To"] == "alice@alpha.example")
    html = html_text(reply_mail)
    assert "<script>" not in html and "<img" not in html and "&lt;script&gt;" in html and "&lt;img src=x onerror=alert(1)&gt;" in html


def test_no_credential_or_token_is_ever_in_an_email(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SMTP_PASSWORD", "s3cret-smtp-password")
    monkeypatch.setenv("SMTP_USERNAME", "mailer-user")
    ticket = world["alpha"].ticket()
    world["root"].reply(ticket["id"])
    run(session_factory)
    for mail in smtp.messages:
        everything = mail.as_string() + plain_text(mail) + html_text(mail)
        for secret in ("s3cret-smtp-password", "token", "Bearer", "password"):
            assert secret not in everything.replace("Authorization", ""), secret


def test_the_sender_is_always_the_configured_address(world, session_factory, smtp):
    world["alpha"].ticket()
    run(session_factory)
    assert {m["From"] for m in smtp.messages} == {"Impex <no-reply@impex.test>"}


# =====================================================================================================
# delivery
# =====================================================================================================
def test_a_sent_notification_is_marked_and_never_sent_again(world, session_factory, smtp):
    world["alpha"].ticket()
    assert run(session_factory)["sent"] == 1
    (note,) = notes(session_factory)
    assert (note.delivery_status, note.attempts, note.last_error) == ("sent", 1, None) and note.sent_at is not None and note.locked_until is None
    assert run(session_factory) == {"sent": 0, "retry": 0, "failed": 0} and len(smtp.messages) == 1


def test_smtp_settings_are_applied(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "smtp.example.net")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_STARTTLS", "true")
    monkeypatch.setenv("SMTP_USERNAME", "u")
    monkeypatch.setenv("SMTP_PASSWORD", "p")
    world["alpha"].ticket()
    run(session_factory)
    assert smtp.connections == [{"host": "smtp.example.net", "port": 587, "ssl": False, "starttls": True, "login": ("u", "p")}]


# =====================================================================================================
# SMTP outage and retry
# =====================================================================================================
def test_when_smtp_is_down_the_ticket_is_still_saved_shown_and_the_notification_stays_pending(world, session_factory, smtp):
    smtp.fail_on_connect = ConnectionRefusedError("connection refused")
    ticket = world["alpha"].ticket(subject="Urgent: cannot log in")
    # the administrator did not lose anything, and the Super Admin sees it, whatever the mail server does
    assert world["alpha"].read(ticket["id"]).json()["messages"][0]["body"] and world["root"].inbox().json()["items"][0]["subject"] == "Urgent: cannot log in"
    assert run(session_factory) == {"sent": 0, "retry": 1, "failed": 0}
    (note,) = notes(session_factory)
    assert (note.delivery_status, note.attempts) == ("pending", 1) and "ConnectionRefusedError" in note.last_error and note.next_retry_at > datetime.now(timezone.utc)
    assert smtp.messages == []
    # visible to the Super Admin on the ticket
    visible = world["root"].open_admin(ticket["id"]).json()["notifications"][0]
    assert (visible["delivery_status"], visible["attempts"]) == ("pending", 1) and "ConnectionRefusedError" in visible["last_error"]


def test_a_failed_attempt_is_not_retried_before_its_time_then_is_and_succeeds_when_the_server_returns(world, session_factory, smtp):
    smtp.fail_on_connect = ConnectionRefusedError("down")
    world["alpha"].ticket()
    run(session_factory)
    attempts_after_first = smtp.attempts
    assert run(session_factory) == {"sent": 0, "retry": 0, "failed": 0} and smtp.attempts == attempts_after_first  # not due yet: no hammering
    make_due(session_factory)
    assert run(session_factory)["retry"] == 1  # still down: another attempt, a longer wait
    (note,) = notes(session_factory)
    assert note.attempts == 2
    smtp.fail_on_connect = None  # the mail server is back
    make_due(session_factory)
    assert run(session_factory) == {"sent": 1, "retry": 0, "failed": 0}
    (note,) = notes(session_factory)
    assert (note.delivery_status, note.attempts, note.last_error) == ("sent", 3, None) and len(smtp.messages) == 1


def test_the_wait_between_attempts_grows(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SUPPORT_OUTBOX_RETRY_BASE_SECONDS", "30")
    smtp.fail_on_connect = ConnectionRefusedError("down")
    world["alpha"].ticket()
    waits = []
    for _ in range(4):
        before = datetime.now(timezone.utc)
        run(session_factory)
        waits.append(round((notes(session_factory)[0].next_retry_at - before).total_seconds()))
        make_due(session_factory)
    assert [w // 10 for w in waits] == [3, 6, 12, 24]  # 30, 60, 120, 240 seconds


def test_after_the_maximum_attempts_it_is_marked_failed_and_stays_visible_and_retryable(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SUPPORT_OUTBOX_MAX_ATTEMPTS", "2")
    smtp.fail_on_connect = ConnectionRefusedError("down")
    ticket = world["alpha"].ticket()
    run(session_factory)
    make_due(session_factory)
    assert run(session_factory) == {"sent": 0, "retry": 0, "failed": 1}
    (note,) = notes(session_factory)
    assert note.delivery_status == "failed" and note.attempts == 2 and note.last_error
    overview = world["root"].client.get(f"{ADMIN}/notifications", headers=world["root"].headers).json()
    assert overview == {"support_email_configured": True, "pending": 0, "failed": 1}
    assert run(session_factory) == {"sent": 0, "retry": 0, "failed": 0}  # failed rows are not picked up on their own
    smtp.fail_on_connect = None
    retried = world["root"].client.post(f"{ADMIN}/notifications/{note.id}/retry", headers=world["root"].headers)
    assert retried.status_code == 200 and retried.json()["delivery_status"] == "pending" and retried.json()["attempts"] == 0
    assert run(session_factory)["sent"] == 1
    assert world["root"].open_admin(ticket["id"]).json()["notifications"][0]["delivery_status"] == "sent"
    again = world["root"].client.post(f"{ADMIN}/notifications/{note.id}/retry", headers=world["root"].headers)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_sent"
    assert world["root"].client.post(f"{ADMIN}/notifications/{note.id}/retry", headers=world["alpha"].headers).status_code == 403


def test_a_rejected_recipient_fails_at_once_because_retrying_cannot_help(world, session_factory, smtp):
    smtp.fail_on_send = smtplib.SMTPRecipientsRefused({"alice@alpha.example": (550, b"no such user")})
    ticket = world["alpha"].ticket()
    world["root"].reply(ticket["id"])
    run(session_factory)
    staff = next(n for n in notes(session_factory) if n.notification_type == "staff_reply")
    assert (staff.delivery_status, staff.attempts) == ("failed", 1) and "refused the recipient" in staff.last_error


def test_a_malformed_requester_address_fails_at_once_and_never_reaches_the_mail_server(world, session_factory, smtp, directory):
    directory.add_user("odd", "organization-admin", world["alpha_id"], email="not-an-address", full_name="Odd Address")
    from conftest import Api

    ticket = Api(world["alpha"].client, "odd").ticket()
    world["root"].reply(ticket["id"])
    run(session_factory)
    staff = next(n for n in notes(session_factory) if n.notification_type == "staff_reply")
    assert staff.delivery_status == "failed" and "malformed" in staff.last_error
    assert all(m["To"] != "not-an-address" for m in smtp.messages)


def test_an_error_message_never_stores_the_smtp_password(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SMTP_PASSWORD", "s3cret-smtp-password")
    monkeypatch.setenv("SMTP_USERNAME", "mailer-user")
    smtp.fail_on_connect = smtplib.SMTPAuthenticationError(535, b"bad login mailer-user / s3cret-smtp-password")
    world["alpha"].ticket()
    run(session_factory)
    (note,) = notes(session_factory)
    assert "s3cret-smtp-password" not in note.last_error and "mailer-user" not in note.last_error and "SMTPAuthenticationError" in note.last_error


def test_an_unexpected_error_in_sending_is_a_delivery_failure_not_a_crash(world, session_factory, smtp):
    smtp.fail_on_send = RuntimeError("something odd")
    world["alpha"].ticket()
    assert run(session_factory)["retry"] == 1
    assert "RuntimeError" in notes(session_factory)[0].last_error


# =====================================================================================================
# the support address is not configured
# =====================================================================================================
def test_without_a_support_address_tickets_are_saved_and_the_notification_waits_for_it(world, session_factory, smtp, monkeypatch):
    monkeypatch.delenv("SUPPORT_NOTIFICATION_EMAIL")
    ticket = world["alpha"].ticket()
    assert world["root"].inbox().json()["total"] == 1
    assert world["root"].client.get(f"{ADMIN}/notifications", headers=world["root"].headers).json()["support_email_configured"] is False
    assert run(session_factory)["retry"] == 1 and smtp.messages == []
    assert "SUPPORT_NOTIFICATION_EMAIL is not configured" in notes(session_factory)[0].last_error
    monkeypatch.setenv("SUPPORT_NOTIFICATION_EMAIL", "later@example.org")
    make_due(session_factory)
    assert run(session_factory)["sent"] == 1 and smtp.messages[0]["To"] == "later@example.org"
    assert world["root"].open_admin(ticket["id"]).status_code == 200


def test_replies_still_reach_the_requester_when_the_support_address_is_missing(world, session_factory, smtp, monkeypatch):
    monkeypatch.delenv("SUPPORT_NOTIFICATION_EMAIL")
    ticket = world["alpha"].ticket()
    world["root"].reply(ticket["id"], body="We fixed it.")
    run(session_factory)
    assert [m["To"] for m in smtp.messages] == ["alice@alpha.example"]


# =====================================================================================================
# workers
# =====================================================================================================
def test_a_worker_that_died_while_sending_does_not_strand_the_notification(world, session_factory, smtp):
    world["alpha"].ticket()
    with session_factory() as db:  # a crashed worker: claimed, then gone, lease expired
        db.execute(text("UPDATE support_email_outbox SET delivery_status = 'sending', attempts = 1, locked_until = now() - interval '1 minute'"))
        db.commit()
    assert run(session_factory)["sent"] == 1
    assert notes(session_factory)[0].attempts == 2


def test_a_notification_being_sent_right_now_is_left_alone(world, session_factory, smtp):
    world["alpha"].ticket()
    with session_factory() as db:
        db.execute(text("UPDATE support_email_outbox SET delivery_status = 'sending', attempts = 1, locked_until = now() + interval '1 minute'"))
        db.commit()
    assert run(session_factory) == {"sent": 0, "retry": 0, "failed": 0} and smtp.messages == []


def test_several_workers_at_once_send_each_notification_once(world, session_factory, smtp):
    for i in range(6):
        world["alpha"].ticket(subject=f"Problem number {i}")
    results = []

    def go():
        results.append(process_batch(session_factory, limit=3))

    threads = [threading.Thread(target=go) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    run(session_factory)  # whatever the racing workers left
    assert len(smtp.messages) == 6 and len({m["Subject"] for m in smtp.messages}) == 6
    assert {n.delivery_status for n in notes(session_factory)} == {"sent"} and {n.attempts for n in notes(session_factory)} == {1}


def test_the_background_worker_delivers_without_any_help(world, session_factory, smtp, monkeypatch):
    monkeypatch.setenv("SUPPORT_OUTBOX_WORKER", "on")
    monkeypatch.setenv("SUPPORT_OUTBOX_INTERVAL_SECONDS", "0.2")
    monkeypatch.setattr(app.state, "session_factory", session_factory, raising=False)  # the worker works on the TEST database
    with TestClient(app):  # the lifespan starts the worker
        ticket = world["alpha"].ticket()
        deadline = time.time() + 10
        while time.time() < deadline and not smtp.messages:
            time.sleep(0.1)
    assert len(smtp.messages) == 1 and smtp.messages[0]["To"] == SUPPORT_EMAIL and ticket["ticket_number"] in smtp.messages[0]["Subject"]
    assert notes(session_factory)[0].delivery_status == "sent"
