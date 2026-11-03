"""Outgoing email over SMTP.

Configured entirely through environment variables (see .env.example). Locally the
`mailpit` container catches everything; in production point SMTP_* at a real provider.

Never log message bodies, links or tokens from this module.
"""
import html
import logging
import os
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from typing import Optional

logger = logging.getLogger("impex.mailer")


class EmailDeliveryError(Exception):
    """The SMTP server could not be reached or rejected the message."""


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
    # Read on every send so configuration changes (and tests) take effect without a restart.
    return SmtpSettings(
        host=os.getenv("SMTP_HOST", "mailpit"),
        port=int(os.getenv("SMTP_PORT", "1025")),
        username=os.getenv("SMTP_USERNAME") or None,
        password=os.getenv("SMTP_PASSWORD") or None,
        starttls=_flag("SMTP_STARTTLS"),
        use_ssl=_flag("SMTP_SSL"),
        from_address=os.getenv("SMTP_FROM_ADDRESS", "no-reply@impex.local"),
        from_name=os.getenv("SMTP_FROM_NAME", "Impex"),
        timeout=float(os.getenv("SMTP_TIMEOUT", "10")),
    )


def build_invitation_message(
    settings: SmtpSettings,
    to_email: str,
    organization_name: str,
    activation_link: str,
    expires_at: datetime,
    recipient_name: Optional[str] = None,
    login_url: Optional[str] = None,
) -> EmailMessage:
    safe_name = " ".join(organization_name.split())  # no newlines in headers
    safe_recipient = " ".join(recipient_name.split()) if recipient_name else ""
    expires = expires_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    message = EmailMessage()
    message["Subject"] = f"You're invited to administer {safe_name} on Impex"
    message["From"] = formataddr((settings.from_name, settings.from_address))
    message["To"] = to_email
    message["Date"] = formatdate(localtime=False)

    greeting = f"Hello {safe_recipient}," if safe_recipient else "Hello,"
    text = [
        greeting,
        "",
        f"You have been invited to be the administrator of {safe_name} on Impex.",
        "",
        f"Organization:  {safe_name}",
        f"Your account email:  {to_email}",
        "",
        "Activate your account and choose your password using this link:",
        activation_link,
        "",
        f"The link can be used once and expires on {expires} (24 hours after it was sent).",
        "",
    ]
    if login_url:
        text += ["After activating, sign in to your organization portal here:", login_url, ""]
    text += [
        "For your security, we never send passwords by email.",
        "If you were not expecting this invitation, you can ignore this email.",
        "",
    ]
    message.set_content("\n".join(text))
    login_html = (
        f'<p style="font-size:13px;color:#475569">After activating, sign in here: '
        f'<a href="{html.escape(login_url, quote=True)}">{html.escape(login_url)}</a></p>'
        if login_url
        else ""
    )
    message.add_alternative(
        f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5">
  <h2 style="margin:0 0 12px">You're invited to Impex</h2>
  <p>{html.escape(greeting)}</p>
  <p>You have been invited to be the administrator of <strong>{html.escape(safe_name)}</strong>.</p>
  <p style="font-size:13px;color:#475569">Organization: {html.escape(safe_name)}<br>Your account email: {html.escape(to_email)}</p>
  <p><a href="{html.escape(activation_link, quote=True)}"
        style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">
     Activate your account</a></p>
  {login_html}
  <p style="font-size:13px;color:#475569">The link can be used once and expires on {expires} (24 hours after it was sent).<br>
  For your security, we never send passwords by email.<br>
  If you were not expecting this invitation, you can ignore this email.</p>
</body></html>""",
        subtype="html",
    )
    return message


def build_credentials_message(
    settings: SmtpSettings,
    to_email: str,
    organization_name: str,
    login_url: str,
    password: str,
    recipient_name: Optional[str] = None,
) -> EmailMessage:
    """DEMO MODE ONLY: the administrator's sign-in details are emailed instead of an activation link."""
    safe_name = " ".join(organization_name.split())
    safe_recipient = " ".join(recipient_name.split()) if recipient_name else ""
    greeting = f"Hello {safe_recipient}," if safe_recipient else "Hello,"

    message = EmailMessage()
    message["Subject"] = f"Your Impex administrator account for {safe_name}"
    message["From"] = formataddr((settings.from_name, settings.from_address))
    message["To"] = to_email
    message["Date"] = formatdate(localtime=False)
    message.set_content(
        "\n".join(
            [
                greeting,
                "",
                f"An administrator account has been created for you for {safe_name} on Impex (demo environment).",
                "",
                f"Organization:  {safe_name}",
                f"Email (username):  {to_email}",
                f"Password:  {password}",
                "",
                "Sign in here:",
                login_url,
                "",
                "This is a demo account. If you were not expecting this email, you can ignore it.",
                "",
            ]
        )
    )
    message.add_alternative(
        f"""<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5">
  <h2 style="margin:0 0 12px">Your Impex administrator account</h2>
  <p>{html.escape(greeting)}</p>
  <p>An administrator account has been created for you for <strong>{html.escape(safe_name)}</strong> (demo environment).</p>
  <table style="border-collapse:collapse;margin:12px 0">
    <tr><td style="padding:4px 14px 4px 0;color:#475569">Organization</td><td><strong>{html.escape(safe_name)}</strong></td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#475569">Email (username)</td><td><strong>{html.escape(to_email)}</strong></td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#475569">Password</td><td><strong>{html.escape(password)}</strong></td></tr>
  </table>
  <p><a href="{html.escape(login_url, quote=True)}"
        style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">
     Sign in</a></p>
  <p style="font-size:13px;color:#475569">This is a demo account. If you were not expecting this email, you can ignore it.</p>
</body></html>""",
        subtype="html",
    )
    return message


def send_message(settings: SmtpSettings, message: EmailMessage) -> None:
    if settings.username and not settings.password:
        # Providers such as Gmail just drop the connection on an empty password; say what is wrong instead.
        reason = "SMTP_USERNAME is set but SMTP_PASSWORD is empty (Gmail needs an App Password)"
        logger.warning("SMTP delivery failed: %s", reason)
        raise EmailDeliveryError(reason)

    smtp_class = smtplib.SMTP_SSL if settings.use_ssl else smtplib.SMTP
    stage = "connecting"
    try:
        with smtp_class(settings.host, settings.port, timeout=settings.timeout) as smtp:
            if settings.starttls and not settings.use_ssl:
                stage = "starting TLS"
                smtp.starttls(context=ssl.create_default_context())
            if settings.username:
                stage = "logging in"
                smtp.login(settings.username, settings.password or "")
            stage = "sending"
            smtp.send_message(message)
    except (smtplib.SMTPException, OSError) as exc:
        reason = describe_failure(exc, settings, stage)
        # Only a safe, generic reason is logged: never the message, recipients, links or credentials.
        logger.warning("SMTP delivery failed: %s", reason)
        raise EmailDeliveryError(reason) from None


def describe_failure(exc: Exception, settings: SmtpSettings, stage: Optional[str] = None) -> str:
    """A human-readable cause for an SMTP failure that contains no secrets or message content."""
    where = f"{settings.host}:{settings.port}"
    if isinstance(exc, (smtplib.SMTPServerDisconnected, ConnectionResetError)) and stage == "logging in":
        # The connection worked; the server hung up during login.
        return (
            f"{settings.host} closed the connection during login - check SMTP_USERNAME and SMTP_PASSWORD "
            "(Gmail requires an App Password)"
        )
    if isinstance(exc, (smtplib.SMTPServerDisconnected, ConnectionResetError)) and stage in ("starting TLS", "sending"):
        return f"{settings.host} closed the connection while {stage}"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return (
            "authentication failed - check SMTP_USERNAME and SMTP_PASSWORD "
            "(Gmail requires an App Password, not your normal password)"
        )
    if isinstance(exc, ssl.SSLCertVerificationError):
        return f"the TLS certificate of {where} could not be verified"
    if isinstance(exc, ssl.SSLError):
        return f"TLS negotiation with {where} failed - check SMTP_STARTTLS / SMTP_SSL and SMTP_PORT"
    if isinstance(exc, smtplib.SMTPNotSupportedError):
        return f"the server at {where} does not support the requested feature (STARTTLS or AUTH)"
    if isinstance(exc, (smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError)):
        return "the server rejected the sender, recipient or message"
    if isinstance(exc, (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError)):
        return f"could not connect to {where} (is SMTP_HOST / SMTP_PORT correct and reachable?)"
    if isinstance(exc, OSError) and not isinstance(exc, smtplib.SMTPException):
        return f"could not connect to {where} ({type(exc).__name__})"
    return type(exc).__name__


def send_invitation_email(
    to_email: str,
    organization_name: str,
    activation_link: str,
    expires_at: datetime,
    recipient_name: Optional[str] = None,
    login_url: Optional[str] = None,
) -> None:
    settings = load_smtp_settings()
    send_message(
        settings,
        build_invitation_message(
            settings, to_email, organization_name, activation_link, expires_at, recipient_name, login_url
        ),
    )


def send_credentials_email(
    to_email: str,
    organization_name: str,
    login_url: str,
    password: str,
    recipient_name: Optional[str] = None,
) -> None:
    """DEMO MODE ONLY. The password is in the message by design; it is never logged."""
    settings = load_smtp_settings()
    send_message(
        settings,
        build_credentials_message(settings, to_email, organization_name, login_url, password, recipient_name),
    )
