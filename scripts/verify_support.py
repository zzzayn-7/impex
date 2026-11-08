#!/usr/bin/env python3
"""End-to-end check of Help & Support against the RUNNING stack, including the real emails (caught by Mailpit).

    # 1. Mailpit must be the mail server for the Support Service, and a support address must be set. For a local run:
    #      SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_STARTTLS=false SMTP_SSL=false SMTP_USERNAME= SMTP_PASSWORD= \\
    #      SUPPORT_NOTIFICATION_EMAIL=support-inbox@impex.test SUPPORT_OUTBOX_INTERVAL_SECONDS=1 SUPPORT_OUTBOX_RETRY_BASE_SECONDS=2 \\
    #      SUPPORT_TICKETS_PER_HOUR=1000 SUPPORT_MESSAGES_PER_10_MIN=1000 \\
    #      docker compose --profile mailpit up -d mailpit support-service dashboard super-admin
    # 2. then
    python scripts/verify_support.py

The whole workflow, as people use it: an Organization Admin signs in to the Organization Portal and opens a ticket -> the ticket is in the
database with its first message and its notification record -> the Super Admin portal's Support Inbox shows it and an email reaches the
support address -> the Super Admin replies from the portal -> the Organization Admin sees the reply in the portal and receives an email.
Then: follow-ups, every status move, forged organization ids, two organizations side by side, a non-Super-Admin at the inbox, hostile
text, an SMTP outage (nothing is lost; the emails are sent when the mail server returns), onboarding that is not finished, deactivated
accounts and organizations, and the append-only guarantees of the database.

It creates throwaway organizations (names start with "Support Check"), administrators and tickets, and removes exactly those by id
afterwards (and the Mailpit messages it caused, by id). The ticket counter is put back where it was if nobody else opened a ticket meanwhile.
"""
import argparse
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _cleanup import CreatedIds, delete_exact  # noqa: E402
from _onboarding import mark_setup_complete  # noqa: E402

AUTH, ORG, SUPPORT, SA_PORTAL, TENANT_PORTAL, MAILPIT = 8000, 8001, 8005, 3000, 3001, 8025
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
NUMBER_RE = re.compile(r"^SUP-\d{6}$")
results = []


def find_docker() -> str:
    found = shutil.which("docker")
    if found:
        return found
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DockerDesktop" / "resources" / "bin" / "docker.exe"
    if candidate.exists():
        return str(candidate)
    sys.exit("docker was not found on PATH. Open a new terminal (or start Docker Desktop) and retry.")


DOCKER = find_docker()


def docker(*args: str) -> str:
    return subprocess.run([DOCKER, *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def psql(db: str, sql: str) -> str:
    return docker("exec", "impex-postgres", "sh", "-c", f'psql -U $POSTGRES_USER -d {db} -tAc "{sql}"')


def psql_with_errors(db: str, sql: str) -> str:
    return docker("exec", "impex-postgres", "sh", "-c", f'psql -U $POSTGRES_USER -d {db} -tAc "{sql}" 2>&1')


def check(name: str, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def call(port, method, path, body=None, headers=None, cookies=None, raw=None, content_type="application/json"):
    conn = http.client.HTTPConnection("localhost", port, timeout=90)
    hdrs = {"Content-Type": content_type, **(headers or {})}
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    payload = raw if raw is not None else (json.dumps(body) if body is not None else None)
    conn.request(method, path, payload, hdrs)
    res = conn.getresponse()
    data = res.read()
    set_cookies = [v for k, v in res.getheaders() if k.lower() == "set-cookie"]
    location = res.getheader("location") or ""
    response_headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, data, set_cookies, location, response_headers


def text_of(data: bytes) -> str:
    return data.decode(errors="replace").replace("<!-- -->", "")


def jbody(data: bytes):
    try:
        return json.loads(data)
    except ValueError:
        return {}


def cookie_value(set_cookies, name):
    for c in set_cookies:
        if c.startswith(name + "="):
            return c.split(";", 1)[0].split("=", 1)[1]
    return None


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def is_redirect(status):
    return status in (301, 302, 303, 307, 308)


def wait_until(fn, timeout=40, every=0.5):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(every)
    return fn()


def key():
    return "chk-" + secrets.token_hex(10)


# ---- Mailpit ------------------------------------------------------------------------------------------------------------------
def mail_all():
    status, data, _, _, _h = call(MAILPIT, "GET", "/api/v1/messages?limit=200")
    return jbody(data).get("messages", []) if status == 200 else []


def mail_find(ticket_number, to_addr=None):
    """Messages whose subject mentions the ticket number (and that were sent to the address, if given)."""
    out = []
    for m in mail_all():
        if ticket_number in m.get("Subject", "") and (to_addr is None or any(t.get("Address") == to_addr for t in m.get("To", []))):
            out.append(m)
    return out


def mail_full(message_id):
    status, data, _, _, _h = call(MAILPIT, "GET", f"/api/v1/message/{message_id}")
    return jbody(data)


def mail_raw(message_id):
    status, data, _, _, _h = call(MAILPIT, "GET", f"/api/v1/message/{message_id}/raw")
    return text_of(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-outage", action="store_true", help="do not stop the mail server (Mailpit) to test an SMTP outage")
    args = parser.parse_args()

    password = "Aa1!" + secrets.token_urlsafe(14)
    sa_email = "supcheck-sa@example.org"
    org_ids, user_ids, tokens, cookies = {}, {}, {}, {}
    emails = {}
    created = CreatedIds()
    mail_ids = set()
    counter_before = None

    # ---- doing things as each kind of person ----------------------------------------------------------------------------------
    def tenant(who, method, path, body=None, headers=None, **kw):
        return call(TENANT_PORTAL, method, path, body, headers, cookies={"impex_tenant_session": cookies[who]} if who in cookies else None, **kw)

    def tpage(who, path):
        status, data, _, location, _h = tenant(who, "GET", path)
        return status, text_of(data), location

    def tapi(who, method, path, body=None, headers=None):
        status, data, _, _, h = tenant(who, method, path, body, headers)
        return status, jbody(data)

    def sa_portal(method, path, body=None, headers=None):
        return call(SA_PORTAL, method, path, body, headers, cookies={"impex_session": cookies["sa"]})

    def sa_page(path):
        status, data, _, location, _h = sa_portal("GET", path)
        return status, text_of(data), location

    def sa_api(method, path, body=None, headers=None):
        status, data, _, _, _h = sa_portal(method, path, body, headers)
        return status, jbody(data)

    def service(who, method, path, body=None, headers=None):
        status, data, _, _, h = call(SUPPORT, method, path, body, bearer(tokens[who]) | (headers or {}))
        return status, jbody(data)

    def sign_in_tenant(who, address):
        status, data, sc, _, _h = call(TENANT_PORTAL, "POST", "/api/auth/login", {"email": address, "password": password})
        cookies[who] = cookie_value(sc, "impex_tenant_session")
        _s, data2, _, _, _h = call(AUTH, "POST", "/api/v1/auth/login", {"email": address, "password": password})
        tokens[who] = jbody(data2).get("access_token")
        return status

    def new_org(k, name):
        status, data, _, _, _h = call(ORG, "POST", "/api/v1/organizations", {"name": name, "slug": f"supcheck-{k}-{secrets.token_hex(3)}", "country_code": "DE", "contact_email": f"ops-{k}@example.org"}, bearer(tokens["sa"]))
        org_ids[k] = jbody(data).get("id")
        created.add("organizations", org_ids[k])
        return status

    def add_admin(org_key, who, name):
        emails[who] = f"supcheck-{who}-{secrets.token_hex(2)}@example.org"
        status, data, _, _, _h = call(AUTH, "POST", "/internal/organization-admins", {"organization_id": org_ids[org_key], "full_name": name, "email": emails[who], "password": password}, {"X-Internal-Key": internal_key})
        user_ids[who] = jbody(data).get("id")
        created.add("users", user_ids[who])
        return status

    def open_ticket(who, subject, message, category="technical_issue", priority="normal", extra=None, idem=None):
        body = {"subject": subject, "category": category, "priority": priority, "message": message, **(extra or {})}
        status, data = tapi(who, "POST", "/api/support/tickets", body, {"Idempotency-Key": idem or key()})
        ticket = data.get("ticket", {}) if isinstance(data, dict) else {}
        if status in (200, 201) and ticket.get("id"):
            created.add("tickets", ticket["id"])
        return status, data, ticket

    def sa_reply(ticket_id, text, status_after=None, idem=None):
        body = {"body": text, **({"status": status_after} if status_after else {})}
        return sa_api("POST", f"/api/support/tickets/{ticket_id}/messages", body, {"Idempotency-Key": idem or key()})

    def ticket_row(ticket_id):
        row = psql("impex_support", f"SELECT status || '|' || priority || '|' || category || '|' || organization_id || '|' || requester_email || '|' || organization_name || '|' || requester_name || '|' || ticket_number FROM support_tickets WHERE id = '{ticket_id}'")
        return row.split("|")

    def outbox(ticket_id, kind=None):
        sql = f"SELECT notification_type || '|' || delivery_status || '|' || recipient || '|' || attempts || '|' || coalesce(last_error, '') FROM support_email_outbox WHERE ticket_id = '{ticket_id}'"
        if kind:
            sql += f" AND notification_type = '{kind}'"
        return [r.split("|") for r in psql("impex_support", sql + " ORDER BY created_at").splitlines() if r]

    def wait_sent(ticket_id, kind, count=1, timeout=40):
        return wait_until(lambda: len([r for r in outbox(ticket_id, kind) if r[1] == "sent"]) >= count, timeout)

    def collect_mail(ticket_number, to_addr=None):
        found = mail_find(ticket_number, to_addr)
        for m in found:
            mail_ids.add(m["ID"])
        return found

    try:
        print("== setup: the mail server, a throwaway Super Admin, organizations and administrators")
        internal_key = docker("compose", "exec", "-T", "auth-service", "printenv", "INTERNAL_API_KEY")
        smtp_host = docker("compose", "exec", "-T", "support-service", "printenv", "SMTP_HOST")
        support_address = docker("compose", "exec", "-T", "support-service", "printenv", "SUPPORT_NOTIFICATION_EMAIL")
        sender = docker("compose", "exec", "-T", "support-service", "printenv", "SMTP_FROM_ADDRESS")
        tenant_url = docker("compose", "exec", "-T", "support-service", "printenv", "TENANT_PORTAL_URL").rstrip("/")
        sa_url = docker("compose", "exec", "-T", "support-service", "printenv", "SUPER_ADMIN_PORTAL_URL").rstrip("/")
        if smtp_host != "mailpit" or not support_address:
            print("FAIL  the Support Service must use Mailpit and have SUPPORT_NOTIFICATION_EMAIL set for this run. See the top of this file.")
            return 1
        check("the support service is healthy", call(SUPPORT, "GET", "/api/v1/support/health")[0] == 200)
        check("Mailpit answers (the mail server for this run)", call(MAILPIT, "GET", "/api/v1/info")[0] == 200)
        counter_before = psql("impex_support", "SELECT coalesce((SELECT last_number FROM support_counters WHERE name = 'ticket'), 0)")
        existing_before = psql("impex_support", "SELECT count(*) FROM support_tickets")

        sa_id = docker("compose", "exec", "-T", "-e", f"TPW={password}", "-e", f"TEM={sa_email}", "auth-service", "python", "-c",
                       "import os\nfrom app.database import SessionLocal\nfrom app.models import User\nfrom app.security import hash_password\n"
                       "with SessionLocal() as db:\n u = User(full_name='SUPcheck SA', email=os.environ['TEM'], password_hash=hash_password(os.environ['TPW']), role='super-admin')\n db.add(u); db.commit(); print(u.id)")
        created.add("users", sa_id)
        status, data, sc, _, _h = call(SA_PORTAL, "POST", "/api/auth/login", {"email": sa_email, "password": password})
        cookies["sa"] = cookie_value(sc, "impex_session")
        _s, data2, _, _, _h = call(AUTH, "POST", "/api/v1/auth/login", {"email": sa_email, "password": password})
        tokens["sa"] = jbody(data2).get("access_token")
        check("throwaway Super Admin can sign in to the Super Admin portal", status == 200 and cookies["sa"] and tokens["sa"], status)

        check("organization A (set up) and administrator A1", new_org("a", "Support Check Alpha GmbH") == 201 and add_admin("a", "a1", "Olivia Owner") == 201)
        check("organization B (set up) and administrator B1", new_org("b", "Support Check Beta SARL") == 201 and add_admin("b", "b1", "Bruno Beta") == 201)
        check("organization C (first-time setup NOT finished) and administrator C1", new_org("c", "Support Check Gamma Ltd") == 201 and add_admin("c", "c1", "Cora Newcomer") == 201)
        check("organization D with administrator D1 (will be deactivated)", new_org("d", "Support Check Delta AG") == 201 and add_admin("d", "d1", "Dana Deactivated") == 201)
        check("organization E with administrator E1 (will be deactivated)", new_org("e", "Support Check Epsilon NV") == 201 and add_admin("e", "e1", "Emil Inactive") == 201)
        for k in ("a", "b", "d", "e"):
            mark_setup_complete(psql, org_ids[k])
        for who, address in emails.items():
            check(f"{who.upper()} signs in to the Organization Portal", sign_in_tenant(who, address) == 200 and cookies.get(who) and tokens.get(who))

        print("\n== 1. THE WORKFLOW: Organization Admin opens a ticket")
        subject = "Label printer fails with error E-42"
        message = "Since this morning the label printer in the main warehouse shows E-42.\nWe already restarted it twice."
        status, data, t1 = open_ticket("a1", subject, message, category="technical_issue", priority="high")
        check("A1 submits the ticket through the Organization Portal (201)", status == 201 and UUID_RE.match(t1.get("id", "")), (status, data))
        n1 = t1.get("ticket_number", "")
        check("it has a ticket number like SUP-000123", NUMBER_RE.match(n1), n1)
        row = ticket_row(t1["id"])
        check("the database holds it: open, high priority, Technical Issue, organization A's id from the verified identity", row[:4] == ["open", "high", "technical_issue", org_ids["a"]], row)
        check("the requester's name, verified e-mail and the organization name are stored as a snapshot", row[4] == emails["a1"] and row[5] == "Support Check Alpha GmbH" and row[6] == "Olivia Owner", row)
        check("its first message is stored with the sender's role and the text exactly", psql("impex_support", f"SELECT sender_role || '|' || message_body FROM support_messages WHERE ticket_id = '{t1['id']}'") == f"organization-admin|{message}")
        ob = outbox(t1["id"])
        check("the notification email was recorded in the SAME transaction: one 'new_ticket' record to the configured support address", len(ob) == 1 and ob[0][0] == "new_ticket" and ob[0][2] == support_address, ob)
        check("the audit trail has a 'created' event by the organization administrator", psql("impex_support", f"SELECT count(*) FROM support_ticket_events WHERE ticket_id = '{t1['id']}' AND event_type = 'created' AND actor_role = 'organization-admin'") == "1")
        check("the portal's ticket page opens for A1 and shows the question", (lambda s_h: s_h[0] == 200 and n1 in s_h[1] and "E-42" in s_h[1] and "Technical Issue" in s_h[1])(tpage("a1", f"/support/{t1['id']}")[:2]))

        print("\n== 2. THE WORKFLOW: the Super Admin receives it - in the portal and by email")
        check("the notification is sent by the background worker (status 'sent')", wait_sent(t1["id"], "new_ticket"), outbox(t1["id"]))
        mails = wait_until(lambda: collect_mail(n1, support_address), 20)
        check("exactly one email reached the support address", len(mails) == 1, len(mails))
        if mails:
            full = mail_full(mails[0]["ID"])
            body_text = full.get("Text", "")
            html_body = full.get("HTML", "")
            check("subject names the ticket, the organization and the subject", n1 in full["Subject"] and "Support Check Alpha GmbH" in full["Subject"] and subject in full["Subject"], full["Subject"])
            check("body carries the ticket number, organization, category and subject", all(x in body_text for x in (n1, "Support Check Alpha GmbH", "Technical Issue", subject)), body_text[:200])
            check("it links to the ticket in the SUPER ADMIN portal", f"{sa_url}/support/{t1['id']}" in body_text and f"{sa_url}/support/{t1['id']}" in html_body, body_text)
            check("the sender is the fixed configured address", full["From"]["Address"] == sender, full["From"])
            check("it contains no password, token or key, and not the question's private text", not any(x in body_text.lower() + html_body.lower() for x in ("password", "token", "secret", "bearer", "restarted it twice")), body_text[:300])
        status, html, loc = sa_page("/support")
        check("the Super Admin's Support Inbox lists the ticket: number, organization, requester, subject, category, priority, status", status == 200 and all(x in html for x in (n1, "Support Check Alpha GmbH", "Olivia Owner", subject, "Technical Issue", "High", "Open")), (status, loc))
        check("it is marked unread in the inbox, and the navigation shows the unread count", 'aria-label="Unread"' in html and "Support Inbox" in html and re.search(r'aria-label="\d+ unread"', html))
        st, inbox = service("sa", "GET", f"/api/v1/support/admin/tickets?q={n1}")
        item = (inbox.get("items") or [{}])[0]
        check("the inbox API row is unread and shows the requester's e-mail and the organization id (Super Admin only)", item.get("unread") is True and item.get("requester_email") == emails["a1"] and item.get("organization_id") == org_ids["a"], item)
        status, html, loc = sa_page(f"/support/{t1['id']}")
        check("the Super Admin opens the conversation: question, organization identity, contact, requester and controls", status == 200 and all(x in html for x in ("E-42", "Support Check Alpha GmbH", "ops-a@example.org", emails["a1"], "Send reply", "Mark In Progress", "Mark Resolved", "Close ticket", "Email notifications", "New ticket → support team")), status)
        check("opening it marked the customer's message as read (no longer unread)", psql("impex_support", f"SELECT count(*) FROM support_messages WHERE ticket_id = '{t1['id']}' AND sender_role = 'organization-admin' AND read_at IS NULL") == "0")
        st, detail = service("sa", "GET", f"/api/v1/support/admin/tickets/{t1['id']}")
        check("the Super Admin's detail view includes the audit events and the notification records", st == 200 and detail.get("events") and detail.get("notifications") and detail["notifications"][0]["delivery_status"] == "sent", st)

        print("\n== 3. THE WORKFLOW: the Super Admin replies in the portal; the Organization Admin sees it and gets an email")
        reply_text = "Thanks - please power-cycle the printer and update its firmware to 2.4. Tell us if E-42 returns."
        reply_key = key()
        status, data = sa_reply(t1["id"], reply_text, idem=reply_key)
        check("the Super Admin sends the reply from the portal (201)", status == 201 and data.get("replayed") is False, (status, data))
        check("it is saved at once: status moves to 'Waiting for Customer'", ticket_row(t1["id"])[0] == "waiting_for_customer" and psql("impex_support", f"SELECT message_body FROM support_messages WHERE ticket_id = '{t1['id']}' AND sender_role = 'super-admin'") == reply_text)
        check("a 'staff_reply' notification was recorded for the REQUESTER (the e-mail verified when the ticket was opened)", [r[2] for r in outbox(t1["id"], "staff_reply")] == [emails["a1"]], outbox(t1["id"]))
        status, html, loc = tpage("a1", "/support")
        check("the Organization Admin's list shows the 'New reply' marker", status == 200 and n1 in html and ">New reply<" in html, status)
        status, html, loc = tpage("a1", f"/support/{t1['id']}")
        check("the Organization Admin sees the reply, from 'Impex Support', and the new status", status == 200 and reply_text in html and "Impex Support" in html and "Waiting for You" in html, status)
        status, html, loc = tpage("a1", "/support")
        check("opening it cleared the 'New reply' marker", ">New reply<" not in html)
        check("the reply notification is sent", wait_sent(t1["id"], "staff_reply"), outbox(t1["id"]))
        mails = wait_until(lambda: collect_mail(n1, emails["a1"]), 20)
        check("an email reached the Organization Admin's own address", len(mails) == 1, len(mails))
        if mails:
            full = mail_full(mails[0]["ID"])
            body_text, html_body = full.get("Text", ""), full.get("HTML", "")
            check("it contains the reply text and a link to the ticket in the ORGANIZATION portal", reply_text in body_text and f"{tenant_url}/support/{t1['id']}" in body_text and f"{tenant_url}/support/{t1['id']}" in html_body, body_text[:300])
            check("it is from the fixed sender, addressed to the requester only, with a single-line subject", full["From"]["Address"] == sender and [t["Address"] for t in full["To"]] == [emails["a1"]] and full["Cc"] == [] and full["Bcc"] == [] and "\n" not in full["Subject"], full["Subject"])
        status, data = sa_reply(t1["id"], reply_text, idem=reply_key)
        check("the same reply sent again with the same key is recognised (200, replayed) and not saved twice", status == 200 and data.get("replayed") is True and psql("impex_support", f"SELECT count(*) FROM support_messages WHERE ticket_id = '{t1['id']}' AND sender_role = 'super-admin'") == "1", (status, data))
        time.sleep(3)
        check("and it did not send a second email", len(collect_mail(n1, emails["a1"])) == 1)

        print("\n== 4. follow-ups in both directions")
        follow = "Updated the firmware - E-42 is gone, but now the printer is slow."
        fkey = key()
        status, data = tapi("a1", "POST", f"/api/support/tickets/{t1['id']}/messages", {"body": follow}, {"Idempotency-Key": fkey})
        check("the Organization Admin answers (201); the ticket goes back to Open", status == 201 and ticket_row(t1["id"])[0] == "open", (status, data))
        status, data = tapi("a1", "POST", f"/api/support/tickets/{t1['id']}/messages", {"body": follow}, {"Idempotency-Key": fkey})
        check("a double click (same key) is recognised and not saved twice", status == 200 and psql("impex_support", f"SELECT count(*) FROM support_messages WHERE ticket_id = '{t1['id']}' AND sender_role = 'organization-admin'") == "2", (status, data))
        check("a 'customer_followup' notification to the support address was recorded and sent", wait_sent(t1["id"], "customer_followup") and [r[2] for r in outbox(t1["id"], "customer_followup")] == [support_address], outbox(t1["id"]))
        found = wait_until(lambda: [m for m in collect_mail(n1, support_address) if "follow-up" in m["Subject"]], 20)
        check("the Super Admin is notified again by email", len(found) == 1, len(found))
        status, html, loc = sa_page("/support?unread=true")
        check("the ticket is unread in the Super Admin's inbox again, and the 'unread only' filter finds it", status == 200 and n1 in html and 'aria-label="Unread"' in html, status)
        status, html, loc = sa_page(f"/support/{t1['id']}")
        check("the Super Admin sees the follow-up in the conversation", status == 200 and follow in html)

        print("\n== 5. status and priority: every move, the refusals, the audit trail")
        for target, label in (("in_progress", "In Progress"), ("waiting_for_customer", "Waiting for Customer"), ("resolved", "Resolved"), ("open", "Open"), ("resolved", "Resolved"), ("closed", "Closed")):
            status, data = sa_api("PATCH", f"/api/support/tickets/{t1['id']}", {"status": target})
            check(f"status -> {label} is accepted (200) and stored", status == 200 and ticket_row(t1["id"])[0] == target, (status, data))
        status, data = sa_api("PATCH", f"/api/support/tickets/{t1['id']}", {"status": "resolved"})
        check("Closed -> Resolved is refused (409): a closed ticket can only be reopened", status == 409 and ticket_row(t1["id"])[0] == "closed", (status, data))
        status, data = tapi("a1", "POST", f"/api/support/tickets/{t1['id']}/messages", {"body": "hello?"}, {"Idempotency-Key": key()})
        check("the customer cannot write to a closed ticket (409)", status == 409, (status, data))
        status, data = sa_reply(t1["id"], "replying while closed")
        check("and the Super Admin must reopen it before replying (409)", status == 409, (status, data))
        status, data = sa_api("PATCH", f"/api/support/tickets/{t1['id']}", {"status": "open"})
        check("the Super Admin reopens it (200)", status == 200 and ticket_row(t1["id"])[0] == "open", (status, data))
        status, data = sa_api("PATCH", f"/api/support/tickets/{t1['id']}", {"priority": "urgent"})
        check("priority -> Urgent (200)", status == 200 and ticket_row(t1["id"])[1] == "urgent", (status, data))
        status, data = sa_api("PATCH", f"/api/support/tickets/{t1['id']}", {"status": "banana"})
        check("an unknown status is refused (400)", status == 400, (status, data))
        events = psql("impex_support", f"SELECT event_type || ':' || coalesce(old_value, '') || '>' || coalesce(new_value, '') || ':' || actor_role FROM support_ticket_events WHERE ticket_id = '{t1['id']}' ORDER BY seq").splitlines()
        check("every change is in the audit trail, in order, with who made it", "status_changed:open>in_progress:super-admin" in events and "status_changed:resolved>closed:super-admin" in events and "status_changed:closed>open:super-admin" in events and "priority_changed:high>urgent:super-admin" in events, events)
        check("the customer's own follow-up reopening was recorded too", any(e.endswith(":organization-admin") and e.startswith("status_changed:waiting_for_customer>open") for e in events), events)
        st, detail = service("a1", "GET", f"/api/v1/support/tickets/{t1['id']}")
        check("the Organization Admin sees the status in plain words and no internal audit data or other people's addresses", st == 200 and detail.get("status") == "open" and "events" not in json.dumps(detail).replace('"events": null', "") and support_address not in json.dumps(detail), st)

        print("\n== 6. security: who may do what")
        st, _ = service("a1", "GET", "/api/v1/support/admin/tickets")
        check("an Organization Admin's token is refused at the Super Admin inbox (403)", st == 403, st)
        st, _ = service("a1", "PATCH", f"/api/v1/support/admin/tickets/{t1['id']}", {"status": "closed"})
        check("...and cannot change a ticket's status or priority there (403)", st == 403 and ticket_row(t1["id"])[0] == "open", st)
        st, _ = service("a1", "POST", f"/api/v1/support/admin/tickets/{t1['id']}/messages", {"body": "I am staff now"}, {"Idempotency-Key": key()})
        check("...nor reply as the Super Admin (403)", st == 403, st)
        st, _ = service("a1", "POST", f"/api/v1/support/admin/notifications/{uuid_zero()}/retry")
        check("...nor retry notifications (403)", st == 403, st)
        st = call(SUPPORT, "GET", "/api/v1/support/admin/tickets")[0]
        check("no token: 401 at both the inbox and the customer API", st == 401 and call(SUPPORT, "GET", "/api/v1/support/tickets")[0] == 401, st)
        st = call(SUPPORT, "GET", "/api/v1/support/tickets", headers=bearer("not.a.token"))[0]
        check("a forged token: 401", st == 401, st)
        st = service("sa", "GET", "/api/v1/support/tickets")[0]
        check("the Super Admin's token is not an organization identity at the customer API (403)", st == 403, st)
        status, data, _, loc, _h = call(SA_PORTAL, "GET", "/support", cookies={"impex_session": tokens["a1"]})
        check("an Organization Admin's token placed in the Super Admin cookie does not open the inbox (redirect to login)", is_redirect(status) and "/login" in loc and n1 not in text_of(data), (status, loc))
        status, data, _, _, _h = call(SA_PORTAL, "POST", f"/api/support/tickets/{t1['id']}/messages", {"body": "hi"}, {"Idempotency-Key": key()}, cookies={"impex_session": tokens["a1"]})
        check("...and the Super Admin reply route refuses it (403)", status == 403, status)
        status, data, _, _, _h = call(SA_PORTAL, "POST", f"/api/support/tickets/{t1['id']}/messages", {"body": "hi"}, {"Idempotency-Key": key()})
        check("the Super Admin reply route needs a session (401)", status == 401, status)
        status, data, _, _, _h = call(TENANT_PORTAL, "POST", "/api/support/tickets", {"subject": "no session", "category": "general_inquiry", "message": "x"}, {"Idempotency-Key": key()})
        check("creating a ticket without a session is refused (401)", status == 401, status)

        print("\n== 7. validation, idempotency and forged data")
        for label, body in (("a one-letter subject", {"subject": "ab", "category": "technical_issue", "message": "x"}), ("an unknown category", {"subject": "Valid subject", "category": "hacking", "message": "x"}),
                            ("an empty message", {"subject": "Valid subject", "category": "technical_issue", "message": "   "}), ("an unknown priority", {"subject": "Valid subject", "category": "technical_issue", "priority": "critical!", "message": "x"}),
                            ("a 5001-character message", {"subject": "Valid subject", "category": "technical_issue", "message": "a" * 5001})):
            before = psql("impex_support", "SELECT count(*) FROM support_tickets")
            st, data = tapi("a1", "POST", "/api/support/tickets", body, {"Idempotency-Key": key()})
            check(f"{label} is refused (400) and nothing is stored", st == 400 and psql("impex_support", "SELECT count(*) FROM support_tickets") == before, (st, data))
        st, data = tapi("a1", "POST", "/api/support/tickets", {"subject": "Valid subject", "category": "technical_issue", "message": "x"})
        check("a request without an Idempotency-Key is refused (400)", st == 400, st)
        st, data, t_forged = open_ticket("a1", "Forged identity attempt", "Trying to file this for another organization.", extra={
            "organization_id": org_ids["b"], "organizationId": org_ids["b"], "requester_email": "victim@example.org", "requester_name": "Someone Else", "organization_name": "Support Check Beta SARL",
            "ticket_number": "SUP-999999", "status": "closed", "created_by_user_id": user_ids["b1"], "recipient": "attacker@evil.example", "to": "attacker@evil.example"})
        row = ticket_row(t_forged.get("id", "")) if t_forged else []
        check("forged organization, requester, number, status and recipient fields are ignored: the ticket belongs to A1's own organization, as open", st == 201 and row[:1] == ["open"] and row[3] == org_ids["a"] and row[4] == emails["a1"] and row[5] == "Support Check Alpha GmbH" and row[6] == "Olivia Owner" and row[7] != "SUP-999999", (st, row))
        ob = outbox(t_forged.get("id", ""))
        check("and the notification goes to the configured support address, not to a browser-supplied one", [r[2] for r in ob] == [support_address], ob)
        idem = key()
        st1, d1, ta = open_ticket("a1", "Duplicate submit test", "Pressing send twice.", idem=idem)
        st2, d2, tb = open_ticket("a1", "Duplicate submit test", "Pressing send twice.", idem=idem)
        check("sending the same request twice (same key) returns the same ticket: 201 then 200", st1 == 201 and st2 == 200 and ta["id"] == tb["id"], (st1, st2))
        st3, d3, _t = open_ticket("a1", "Duplicate submit test with other text", "Different.", idem=idem)
        check("the same key with a different request is refused (409)", st3 == 409, (st3, d3))
        idem = key()
        outcomes = []
        threads = [threading.Thread(target=lambda: outcomes.append(open_ticket("a1", "Five fast clicks", "Pressing send five times at once.", idem=idem)[0])) for _ in range(5)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        ids_five = psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE organization_id = '{org_ids['a']}' AND subject = 'Five fast clicks'")
        check("five simultaneous identical requests create exactly one ticket and one notification", ids_five == "1" and sorted(outcomes).count(201) == 1 and set(outcomes) <= {200, 201}, (ids_five, outcomes))
        numbers = psql("impex_support", f"SELECT ticket_number FROM support_tickets WHERE organization_id IN ({', '.join(repr(o) for o in org_ids.values())})").splitlines()
        check("ticket numbers are unique and well formed", len(numbers) == len(set(numbers)) and all(NUMBER_RE.match(n) for n in numbers), numbers)
        st, data = tapi("a1", "PATCH", f"/api/support/tickets/{t1['id']}", {"status": "closed"})
        check("the Organization Portal has no way to change a status (no such route)", st in (404, 405) and ticket_row(t1["id"])[0] == "open", st)

        print("\n== 8. two organizations side by side")
        st, data, tb1 = open_ticket("b1", "Beta secret problem", "Beta's private details: contract 4471.", category="billing_subscription")
        nb = tb1.get("ticket_number", "")
        check("organization B's administrator opens a ticket of their own", st == 201 and NUMBER_RE.match(nb) and ticket_row(tb1["id"])[3] == org_ids["b"], (st, data))
        st, page_a = tapi("a1", "GET", "/api/support/tickets?limit=100")
        st2, page_b = tapi("b1", "GET", "/api/support/tickets?limit=100")
        a_numbers = {i["ticket_number"] for i in page_a.get("items", [])}
        b_numbers = {i["ticket_number"] for i in page_b.get("items", [])}
        check("A's list contains only A's tickets, B's only B's", n1 in a_numbers and nb not in a_numbers and b_numbers == {nb}, (a_numbers, b_numbers))
        st, page = tapi("a1", "GET", f"/api/support/tickets?organization_id={org_ids['b']}&limit=100")
        check("naming another organization in the query changes nothing", {i["ticket_number"] for i in page.get("items", [])} == a_numbers, st)
        st_foreign, foreign = service("a1", "GET", f"/api/v1/support/tickets/{tb1['id']}")
        st_missing, missing = service("a1", "GET", f"/api/v1/support/tickets/{uuid_zero()}")
        check("A cannot read B's ticket: the answer is a 404 identical to a ticket that does not exist", st_foreign == 404 and st_missing == 404 and foreign == missing, (st_foreign, foreign, missing))
        st, data = tapi("a1", "POST", f"/api/support/tickets/{tb1['id']}/messages", {"body": "Injected into B's ticket"}, {"Idempotency-Key": key()})
        check("A cannot reply to B's ticket (404) and nothing is added to it", st == 404 and psql("impex_support", f"SELECT count(*) FROM support_messages WHERE ticket_id = '{tb1['id']}'") == "1", st)
        s_foreign, html, _l = tpage("a1", f"/support/{tb1['id']}")
        check("A's ticket page for B's ticket says 'not found' and shows nothing of B", "Request not found" in html and "Beta" not in html and "4471" not in html, s_foreign)
        s_list, html, _l = tpage("a1", "/support")
        check("A's list page shows no trace of B's ticket", nb not in html and "Beta secret" not in html)
        st, data = service("a1", "GET", f"/api/v1/support/tickets/{tb1['id']}")
        check("directly at the service as well: A cannot read B's ticket (404)", st == 404, st)
        st, inbox = service("sa", "GET", "/api/v1/support/admin/tickets?limit=100")
        listed = {i["ticket_number"] for i in inbox.get("items", [])}
        check("the Super Admin sees both organizations' tickets in one inbox", {n1, nb} <= listed, listed)
        for label, query, expected, excluded in (("search by ticket number", f"q={nb}", {nb}, {n1}), ("search by organization name", "q=Beta+SARL", {nb}, {n1}), ("search by requester name", "q=Bruno", {nb}, {n1}),
                                                 ("search by requester e-mail", f"q={emails['b1']}", {nb}, {n1}), ("filter by category", "category=billing_subscription", {nb}, {n1}),
                                                 ("filter by organization", f"organization_id={org_ids['b']}", {nb}, {n1}), ("filter by priority", "priority=urgent", {n1}, {nb})):
            st, found = service("sa", "GET", f"/api/v1/support/admin/tickets?{query}&limit=100")
            got = {i["ticket_number"] for i in found.get("items", [])}
            check(f"inbox {label}", expected <= got and excluded.isdisjoint(got), (query, got))
        st, p1 = service("sa", "GET", "/api/v1/support/admin/tickets?limit=1&offset=0")
        st, p2 = service("sa", "GET", "/api/v1/support/admin/tickets?limit=1&offset=1")
        check("pagination: two pages of one are two different tickets, with the same total", len(p1["items"]) == 1 and len(p2["items"]) == 1 and p1["items"][0]["id"] != p2["items"][0]["id"] and p1["total"] == p2["total"], (p1.get("total"), p2.get("total")))
        status, html, loc = sa_page(f"/support?q={urllib.parse.quote(nb)}")
        check("the inbox page's search finds B's ticket and only it", status == 200 and nb in html and n1 not in html, status)
        status, html, loc = sa_page("/support?status=open&category=bogus&page=-5&foo=bar")
        check("the inbox page ignores unknown filters and bad page numbers (200)", status == 200, status)

        print("\n== 9. hostile text is shown as text, never run")
        evil_subject = 'Bad <img src=x onerror=alert(1)> subject\r\nBcc: spy@evil.example'
        evil_body = '<script>window.__pwned=1</script><b onclick="evil()">bold</b> {{7*7}} ${7*7} ‮ reversed'
        st, data, te = open_ticket("a1", evil_subject, evil_body, category="general_inquiry")
        ne = te.get("ticket_number", "")
        check("a ticket with markup and a header-injection attempt in the subject is accepted as plain text (201)", st == 201 and NUMBER_RE.match(ne), (st, data))
        stored_subject = psql("impex_support", f"SELECT subject FROM support_tickets WHERE id = '{te['id']}'")
        check("the stored subject has no line break (so no extra header can be formed)", "\r" not in stored_subject and "\n" not in stored_subject and "spy@evil.example" in stored_subject.replace("\n", " "), repr(stored_subject))
        sa_reply(te["id"], "<script>window.__pwned=2</script> Thanks, we are looking into it.")
        status, html, _l = tpage("a1", f"/support/{te['id']}")
        check("the Organization Portal shows the markup escaped: no live <script>, <img> or onclick", status == 200 and "<script>window" not in html and "<img src=x" not in html and 'onclick="evil' not in html and "&lt;script&gt;window.__pwned=1&lt;/script&gt;" in html and "&lt;script&gt;window.__pwned=2" in html, status)
        status, html, _l = sa_page(f"/support/{te['id']}")
        check("the Super Admin portal shows it escaped too", status == 200 and "<script>window" not in html and "<img src=x" not in html and "&lt;script&gt;window.__pwned=1&lt;/script&gt;" in html, status)
        status, html, _l = sa_page("/support?q=Bad")
        check("and so does the inbox list", status == 200 and "<img src=x" not in html and "&lt;img src=x" in html, status)
        wait_sent(te["id"], "staff_reply")
        mails = wait_until(lambda: collect_mail(ne), 25)
        check("the emails for it were sent", len(mails) >= 2, len(mails))
        bad = []
        for m in mails:
            raw = mail_raw(m["ID"])
            head = raw.split("\r\n\r\n", 1)[0]
            if any(line.lower().startswith(("bcc:", "cc:")) for line in head.split("\r\n")):
                bad.append("header injection")
            full = mail_full(m["ID"])
            if "<script>" in full.get("HTML", "") or "<img src=x" in full.get("HTML", ""):
                bad.append("live markup in html part")
        check("no email has an injected header (Bcc) or live markup in its HTML part", not bad and all(not m.get("Bcc") for m in mails), bad)
        check("every email subject is on one line", all("\n" not in m["Subject"] and "\r" not in m["Subject"] for m in mails))

        print("\n== 10. Help & Support while first-time setup is NOT finished (organization C)")
        status, html, loc = tpage("c1", "/")
        check("C1's dashboard still redirects to /setup (onboarding unchanged)", is_redirect(status) and loc.endswith("/setup"), (status, loc))
        status, html, loc = tpage("c1", "/setup")
        check("the setup screen offers 'Need help? Contact support'", status == 200 and "Need help? Contact support" in html and 'href="/support"' in html, status)
        status, html, loc = tpage("c1", "/support")
        check("/support opens without finishing setup (no redirect), with a way back to the setup", status == 200 and "Help &amp; Support" in html and "Back to setup" in html and 'href="/setup"' in html, (status, loc))
        status, html, loc = tpage("c1", "/support/new")
        check("the new-request form opens too", status == 200 and "New request" in html, status)
        st, data, tc = open_ticket("c1", "I cannot upload my logo", "The setup screen rejects my PNG, what is wrong?", category="account_organization")
        check("C1 opens a ticket before setup is finished (201)", st == 201 and NUMBER_RE.match(tc.get("ticket_number", "")), (st, data))
        check("it belongs to organization C, and the Super Admin sees it", ticket_row(tc["id"])[3] == org_ids["c"] and tc["ticket_number"] in sa_page("/support?q=logo")[1])
        sa_reply(tc["id"], "Please use a PNG between 64 and 4000 pixels wide.")
        status, html, _l = tpage("c1", f"/support/{tc['id']}")
        check("C1 reads the Super Admin's answer before setup is finished", status == 200 and "64 and 4000 pixels" in html, status)
        check("C1's setup is still not finished (support did not complete or skip it)", psql("impex_organizations", f"SELECT setup_status FROM organizations WHERE id = '{org_ids['c']}'") != "completed")
        for path in ("/products", "/stock", "/scan", "/invoices", "/clients", "/delivery-lists", "/dispatches", "/suppliers", "/purchase-orders", "/goods-receipts"):
            status, html, loc = tpage("c1", path)
            check(f"{path} still redirects C1 to /setup", is_redirect(status) and loc.endswith("/setup"), (status, loc))
        for path in ("/api/products", "/api/stock/in", "/api/scan/resolve", "/api/sales/clients", "/api/sales/invoices", "/api/purchasing/suppliers", "/api/purchasing/purchase-orders"):
            status, data, _, _, _h = tenant("c1", "GET", path)
            body = jbody(data)
            check(f"{path} is refused on the SERVER while setup is unfinished (403 setup_required), not merely hidden", status == 403 and body.get("code") == "setup_required", (status, body))
        for path in ("/api/support/tickets", "/api/organization/logo"):
            status, data, _, _, _h = tenant("c1", "GET", path)
            check(f"{path} stays reachable during setup (not 403 setup_required)", jbody(data).get("code") != "setup_required" and status != 403, status)
        status, data, _, _, _h = call(TENANT_PORTAL, "GET", "/api/sales/clients")
        check("business APIs without a session still answer 401 (not a setup error)", status == 401, status)
        status, data, _, _, _h = tenant("a1", "GET", "/api/sales/clients")
        check("a configured organization's business API still works (200)", status == 200, status)
        status, data, _, _, _h = tenant("a1", "GET", "/api/purchasing/suppliers")
        check("...for the purchasing APIs as well (200)", status == 200, status)
        check("the Auth, Organization and Support health endpoints are all reachable", all(call(p, "GET", path)[0] == 200 for p, path in ((AUTH, "/health"), (ORG, "/health"), (SUPPORT, "/api/v1/support/health"))))

        print("\n== 11. deactivated accounts and organizations")
        st, data, td = open_ticket("d1", "Delta question", "Before I leave.", category="general_inquiry")
        te2_status, data, te2 = open_ticket("e1", "Epsilon question", "Before we are suspended.", category="billing_subscription")
        check("D1 and E1 each opened a ticket while active", st == 201 and te2_status == 201)
        psql("impex_auth", f"UPDATE users SET is_active = false WHERE id = '{user_ids['d1']}'")
        st, data = tapi("d1", "GET", "/api/support/tickets")
        check("a deactivated user can no longer use support through the portal (401)", st == 401, (st, data))
        st, data = service("d1", "GET", "/api/v1/support/tickets")
        check("...nor at the service (401)", st == 401, st)
        st, data = tapi("d1", "POST", "/api/support/tickets", {"subject": "Still here?", "category": "general_inquiry", "message": "x"}, {"Idempotency-Key": key()})
        check("...nor open a new ticket (401)", st == 401, st)
        psql("impex_organizations", f"UPDATE organizations SET is_active = false WHERE id = '{org_ids['e']}'")
        st, data = tapi("e1", "GET", "/api/support/tickets")
        check("an inactive organization's administrator is refused (403)", st == 403, (st, data))
        st, data = tapi("e1", "POST", "/api/support/tickets", {"subject": "Still here?", "category": "general_inquiry", "message": "x"}, {"Idempotency-Key": key()})
        check("...and cannot open a ticket (403)", st == 403, st)
        status, html, loc = tpage("e1", "/support")
        check("...and the portal page explains it instead of listing tickets", status == 200 and "inactive or unavailable" in html and "Epsilon question" not in html, status)
        status, html, _l = sa_page("/support?q=question")
        check("the Super Admin still sees both tickets (nothing was deleted by deactivation) and can reply", status == 200 and td["ticket_number"] in html and te2["ticket_number"] in html, status)
        status, data = sa_reply(td["id"], "Goodbye, Dana.")
        check("the Super Admin can still reply to a deactivated user's ticket, and the reply is stored", status == 201, (status, data))
        psql("impex_auth", f"UPDATE users SET is_active = true WHERE id = '{user_ids['d1']}'")
        psql("impex_organizations", f"UPDATE organizations SET is_active = true WHERE id = '{org_ids['e']}'")
        st, data = tapi("d1", "GET", "/api/support/tickets")
        check("when D1 is reactivated, the old ticket and the reply are there", st == 200 and any(i["ticket_number"] == td["ticket_number"] for i in data.get("items", [])), st)

        print("\n== 12. the database keeps the conversation: nothing can be deleted or rewritten")
        out = psql_with_errors("impex_support", f"DELETE FROM support_tickets WHERE id = '{t1['id']}'")
        check("a ticket cannot be deleted", "ERROR" in out and psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE id = '{t1['id']}'") == "1", out)
        out = psql_with_errors("impex_support", f"DELETE FROM support_messages WHERE ticket_id = '{t1['id']}'")
        check("messages cannot be deleted", "ERROR" in out, out)
        out = psql_with_errors("impex_support", f"UPDATE support_messages SET message_body = 'rewritten' WHERE ticket_id = '{t1['id']}'")
        check("a message cannot be rewritten", "ERROR" in out, out)
        out = psql_with_errors("impex_support", f"UPDATE support_tickets SET organization_id = '{org_ids['b']}' WHERE id = '{t1['id']}'")
        check("a ticket cannot be moved to another organization", "ERROR" in out and ticket_row(t1["id"])[3] == org_ids["a"], out)
        out = psql_with_errors("impex_support", f"UPDATE support_tickets SET status = 'bogus' WHERE id = '{tb1['id']}'")
        check("a status the rules do not know is refused by the database itself", "ERROR" in out and ticket_row(tb1["id"])[0] == "open", out)
        out = psql_with_errors("impex_support", f"DELETE FROM support_ticket_events WHERE ticket_id = '{t1['id']}'")
        check("the audit trail cannot be deleted", "ERROR" in out, out)

        if args.skip_outage:
            print("\n(skipped: SMTP outage checks - run without --skip-outage)")
        else:
            print("\n== 13. SMTP outage: nothing is lost, and the emails follow when the mail server returns")
            docker("stop", "impex-mailpit")
            try:
                st, data, to = open_ticket("a1", "Opened while the mail server is down", "The mail server is unavailable right now.")
                no = to.get("ticket_number", "")
                check("a ticket opened during the outage is accepted at once (201) and stored", st == 201 and NUMBER_RE.match(no) and ticket_row(to["id"])[0] == "open", (st, data))
                st, data = sa_reply(to["id"], "Replied during the outage; saved first, emailed later.")
                check("the Super Admin's reply is saved and shown during the outage (201)", st == 201, (st, data))
                st, html, _l = tpage("a1", f"/support/{to['id']}")
                check("the Organization Admin reads it in the portal during the outage", st == 200 and "saved first, emailed later" in html, st)
                failing = wait_until(lambda: (lambda rows: rows if len(rows) == 2 and all(r[1] == "pending" and r[3] != "0" and r[4] for r in rows) else None)(outbox(to["id"])), 90)
                check("both notifications are kept as pending, with a recorded attempt and a short error (visible to the Super Admin)", bool(failing), outbox(to["id"]))
                check("the recorded error is short and contains no credential", bool(failing) and all(len(r[4]) < 300 and "password" not in r[4].lower() for r in failing), failing)
                st, over = service("sa", "GET", "/api/v1/support/admin/notifications")
                check("the notification overview shows the waiting emails and that the support address is configured", st == 200 and over.get("pending", 0) >= 2 and over.get("support_email_configured") is True, over)
                status, html, _l = sa_page(f"/support/{to['id']}")
                check("the ticket page shows each email's delivery state to the Super Admin", status == 200 and "Email notifications" in html and ("Waiting to send" in html or "Sending" in html), status)
            finally:
                docker("start", "impex-mailpit")
                wait_until(lambda: call(MAILPIT, "GET", "/api/v1/info")[0] == 200, 40)
            check("after the mail server is back, both emails are delivered by the worker (retry with backoff)", wait_until(lambda: len([r for r in outbox(to["id"]) if r[1] == "sent"]) == 2, 90), outbox(to["id"]))
            mails = collect_mail(no)
            check("one email for the support address and one for the requester arrived, each exactly once", sorted(t["Address"] for m in mails for t in m["To"]) == sorted([support_address, emails["a1"]]), [[t["Address"] for t in m["To"]] for m in mails])

        print("\n== 14. the earlier portals and data are untouched")
        check("the Super Admin portal's Organizations page still loads", sa_page("/organizations")[0] == 200)
        check("the Super Admin dashboard still loads and its navigation has Support Inbox", (lambda r: r[0] == 200 and "Support Inbox" in r[1] and "Organizations" in r[1])(sa_page("/")))
        check("the Organization Portal dashboard still loads for a configured administrator, with Help & Support in its navigation", (lambda r: r[0] == 200 and "Help &amp; Support" in r[1])(tpage("a1", "/")))
        check("the Products, Stock, Invoices and Clients pages still load", all(tpage("a1", p)[0] == 200 for p in ("/products", "/stock", "/invoices", "/clients")))
        check("tickets that existed before this run are unchanged in number", int(psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE organization_id NOT IN ({', '.join(repr(o) for o in org_ids.values())})")) == int(existing_before))
    finally:
        print("\n== cleanup (exactly the rows this run created, by id)")
        orgs = created.get("organizations")
        users = created.get("users")
        ticket_ids = list(dict.fromkeys(created.get("tickets") + ([r for r in psql("impex_support", "SELECT id FROM support_tickets WHERE organization_id IN (" + ", ".join(f"'{o}'" for o in orgs) + ")").splitlines() if UUID_RE.match(r)] if orgs else [])))
        left = {}
        if ticket_ids:
            for table, column in (("support_ticket_events", "ticket_id"), ("support_email_outbox", "ticket_id"), ("support_requests", "ticket_id"), ("support_messages", "ticket_id"), ("support_tickets", "id")):
                left[table] = delete_exact(psql, "impex_support", table, ticket_ids, column, ledger=True)
        if users:
            left["support_requests(by user)"] = delete_exact(psql, "impex_support", "support_requests", users, "scope_id", ledger=True)
        if orgs:
            left["support_requests(by org)"] = delete_exact(psql, "impex_support", "support_requests", orgs, "scope_id", ledger=True)
        if counter_before is not None and counter_before.isdigit():
            newer = psql("impex_support", f"SELECT count(*) FROM support_tickets WHERE ticket_number > 'SUP-' || lpad('{int(counter_before)}', 6, '0')")
            if newer == "0":
                psql("impex_support", f"UPDATE support_counters SET last_number = {int(counter_before)} WHERE name = 'ticket'")
        left["organizations"] = delete_exact(psql, "impex_organizations", "organizations", orgs)
        left["users"] = delete_exact(psql, "impex_auth", "users", users)
        removed_mail = 0
        if mail_ids:
            status, _d, _, _, _h = call(MAILPIT, "DELETE", "/api/v1/messages", {"IDs": sorted(mail_ids)})
            removed_mail = len(mail_ids) if status == 200 else 0
        print(f"deleted {len(ticket_ids)} tickets (with their messages, events, notifications, requests), {len(orgs)} organizations, {len(users)} users and {removed_mail} caught emails")
        print("of those ids, rows still present -> " + ", ".join(f"{k}: {v}" for k, v in left.items()))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if results and all(results) else 1


def uuid_zero() -> str:
    return "00000000-0000-4000-8000-000000000000"


if __name__ == "__main__":
    sys.exit(main())
