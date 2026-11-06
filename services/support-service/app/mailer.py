"""Support email notifications over SMTP, using the same SMTP_* settings as the Organization Service.

Locally the `mailpit` container catches everything; in production point SMTP_* at a real provider. The sender address is FIXED by
configuration (SMTP_FROM_ADDRESS); the recipient of a notification is decided by the server (the configured SUPPORT_NOTIFICATION_EMAIL,
or the ticket's verified requester address) and is never taken from a request.

Email is a NOTIFICATION. The conversation lives in the database; nothing here parses inbound mail.
Never log message bodies or links from this module.
"""
import html
import logging
import os
import re
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from typing import Optional

logger = logging.getLogger("impex.support.mailer")

EMAIL_RE = re.compile(r"^[^@\s<>\",;:\\]+@[^@\s<>\",;:\\]+\.[^@\s<>\",;:\\]+$")
_HEADER_UNSAFE = re.compile(r"[\x00-\x1f\x7f  ]")


class EmailDeliveryError(Exception):
    """The notification could not be delivered. `retryable` is False for a problem a retry cannot fix (a malformed address)."""

    def __init__(self, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class SmtpSettings:
    host: str
    port: int
    username: Optional[str]
    password: Optional[str]
    starttls: bool
    use_ssl: bool
    from_address: str
    from_name: str
    timeout: float


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


def load_smtp_settings() -> SmtpSettings:
    # Read on every send so a configuration change (and a test) takes effect without a restart.
    return SmtpSettings(
        host=os.getenv("SMTP_HOST", "mailpit"), port=int(os.getenv("SMTP_PORT", "1025")), username=os.getenv("SMTP_USERNAME") or None,
        password=os.getenv("SMTP_PASSWORD") or None, starttls=_flag("SMTP_STARTTLS"), use_ssl=_flag("SMTP_SSL"),
        from_address=os.getenv("SMTP_FROM_ADDRESS", "no-reply@impex.local"), from_name=os.getenv("SMTP_FROM_NAME", "Impex"),
        timeout=float(os.getenv("SMTP_TIMEOUT", "10")),
    )


def support_recipient() -> str:
    """The address that receives new-ticket and follow-up notifications ('' when it is not configured)."""
    return os.getenv("SUPPORT_NOTIFICATION_EMAIL", "").strip()


def super_admin_ticket_url(ticket_id) -> str:
    return f"{os.getenv('SUPER_ADMIN_PORTAL_URL', 'http://localhost:3000').rstrip('/')}/support/{ticket_id}"


def tenant_ticket_url(ticket_id) -> str:
    return f"{os.getenv('TENANT_PORTAL_URL', 'http://localhost:3001').rstrip('/')}/support/{ticket_id}"


def one_line(value: str, limit: int = 150) -> str:
    """Safe for an email header: no control characters or line breaks, bounded."""
    return " ".join(_HEADER_UNSAFE.sub(" ", value or "").split())[:limit]


def build_message(settings: SmtpSettings, *, kind: str, recipient: str, ticket, message_body: Optional[str]) -> EmailMessage:
    """`ticket` is the SupportTicket row. No password, token or credential is ever part of an email: only the ticket's reference,
    organization, category, subject and a link that still requires signing in."""
    from app.schemas import CATEGORY_LABELS  # local import: schemas import models

    if not EMAIL_RE.match(recipient or ""):
        raise EmailDeliveryError("the recipient address is missing or malformed", retryable=False)
    number, org, subject = ticket.ticket_number, one_line(ticket.organization_name, 100), one_line(ticket.subject)
    category = CATEGORY_LABELS.get(ticket.category, ticket.category)
    if kind == "staff_reply":
        link = tenant_ticket_url(ticket.id)
        title = f"[{number}] Impex Support replied: {subject}"
        intro = f"Impex Support replied to your request {number}."
        lines = [intro, "", f"Subject:  {subject}", f"Category:  {category}", "", "Reply:", "", message_body or "", "", "Read the whole conversation (and answer) in your Impex portal:", link]
        footer = "You are receiving this because you opened this request. Sign in to your Impex portal to continue the conversation; replying to this email does nothing."
    else:
        link = super_admin_ticket_url(ticket.id)
        title = f"[{number}] New support request from {org}: {subject}" if kind == "new_ticket" else f"[{number}] New follow-up from {org}: {subject}"
        intro = f"{org} opened a new support request." if kind == "new_ticket" else f"{org} replied to support request {number}."
        lines = [intro, "", f"Ticket:  {number}", f"Organization:  {org}", f"Category:  {category}", f"Subject:  {subject}", "", "Open it in the Super Admin portal:", link]
        footer = "This is a notification only. Answer from the Support Inbox in the Super Admin portal; replying to this email does nothing."

    email = EmailMessage()
    email["Subject"] = one_line(title, 250)
    email["From"] = formataddr((one_line(settings.from_name, 80), settings.from_address))  # fixed sender
    email["To"] = recipient
    email["Date"] = formatdate(localtime=False)
    email["X-Impex-Ticket"] = number
    email.set_content("\n".join(lines + ["", footer, ""]))

    safe = {k: html.escape(v) for k, v in {"intro": intro, "number": number, "org": org, "category": category, "subject": subject}.items()}
    reply_html = (
        f'<p style="margin:16px 0 4px;font-size:13px;color:#475569">Reply:</p>'
        f'<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #cbd5e1;background:#f8fafc;white-space:pre-wrap">{html.escape(message_body or "")}</blockquote>'
        if kind == "staff_reply" else ""
    )
    email.add_alternative(
        f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5">
  <p>{safe['intro']}</p>
  <p style="font-size:13px;color:#475569">Ticket: <strong>{safe['number']}</strong><br>Organization: {safe['org']}<br>Category: {safe['category']}<br>Subject: {safe['subject']}</p>
  {reply_html}
  <p><a href="{html.escape(link, quote=True)}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open the ticket</a></p>
  <p style="font-size:12px;color:#64748b">{html.escape(footer)}</p>
</body></html>""",
        subtype="html",
    )
    return email


def send(message: EmailMessage, settings: Optional[SmtpSettings] = None) -> None:
    settings = settings or load_smtp_settings()
    try:
        if settings.use_ssl:
            connection = smtplib.SMTP_SSL(settings.host, settings.port, timeout=settings.timeout, context=ssl.create_default_context())
        else:
            connection = smtplib.SMTP(settings.host, settings.port, timeout=settings.timeout)
        with connection as server:
            if settings.starttls and not settings.use_ssl:
                server.starttls(context=ssl.create_default_context())
            if settings.username and settings.password:
                server.login(settings.username, settings.password)
            server.send_message(message)
    except smtplib.SMTPRecipientsRefused as exc:
        raise EmailDeliveryError(f"the mail server refused the recipient ({len(exc.recipients)})", retryable=False) from exc
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        raise EmailDeliveryError(sanitize_error(exc, settings)) from exc


def sanitize_error(exc: BaseException, settings: Optional[SmtpSettings] = None) -> str:
    """A short reason that is safe to store and show: the error's kind and message, never a credential."""
    text = f"{exc.__class__.__name__}: {exc}"
    for secret in (os.getenv("SMTP_PASSWORD"), os.getenv("SMTP_USERNAME")):
        if secret:
            text = text.replace(secret, "***")
    return " ".join(text.split())[:300]
