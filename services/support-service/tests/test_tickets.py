"""Tickets, the conversation, the lifecycle, the audit trail, unread tracking, search, idempotency and rate limits."""
import threading
import uuid

import pytest
from sqlalchemy import select

from app.models import SupportEmailOutbox, SupportMessage, SupportTicket, SupportTicketEvent

from conftest import ADMIN, TICKETS


def rows(session_factory, model):
    with session_factory() as db:
        return db.scalars(select(model)).all()


# =====================================================================================================
# creating a ticket
# =====================================================================================================
def test_an_administrator_opens_a_ticket_that_is_saved_with_its_first_message(world, session_factory):
    response = world["alpha"].open(subject="  Cannot   print labels ", category="technical_issue", priority="high", message="The printer shows E-42.\nTried twice.")
    assert response.status_code == 201
    ticket = response.json()
    assert ticket["ticket_number"] == "SUP-000001" and ticket["status"] == "open" and ticket["status_label"] == "Open"
    assert (ticket["subject"], ticket["category"], ticket["category_label"], ticket["priority"]) == ("Cannot print labels", "technical_issue", "Technical Issue", "high")
    assert ticket["organization_name"] == "Alpha Trading" and ticket["requester_name"] == "Alice Alpha"
    assert [(m["sender_role"], m["sender_name"], m["body"]) for m in ticket["messages"]] == [("organization-admin", "Alice Alpha", "The printer shows E-42.\nTried twice.")]
    assert ticket["can_reply"] is True and ticket["message_count"] == 1
    (stored,) = rows(session_factory, SupportTicket)
    assert (stored.organization_id, stored.requester_email, stored.created_by_user_id) == (
        uuid.UUID(world["alpha_id"]), "alice@alpha.example", uuid.UUID(world["directory"].users["alpha"]["id"]))
    assert len(rows(session_factory, SupportMessage)) == 1


def test_creating_a_ticket_also_records_the_audit_event_and_the_email_notification_in_the_same_transaction(world, session_factory):
    world["alpha"].ticket()
    (event,) = rows(session_factory, SupportTicketEvent)
    assert (event.event_type, event.old_value, event.new_value, event.actor_role) == ("created", None, "open", "organization-admin")
    (note,) = rows(session_factory, SupportEmailOutbox)
    assert (note.notification_type, note.recipient, note.delivery_status, note.attempts) == ("new_ticket", "support-inbox@example.org", "pending", 0)
    assert note.message_id is not None


def test_a_refused_ticket_leaves_nothing_behind(world, session_factory):
    assert world["alpha"].open(subject="x").status_code == 422
    assert [len(rows(session_factory, m)) for m in (SupportTicket, SupportMessage, SupportTicketEvent, SupportEmailOutbox)] == [0, 0, 0, 0]


def test_ticket_numbers_are_unique_and_gapless_across_organizations(world):
    numbers = [world[w].ticket()["ticket_number"] for w in ("alpha", "beta", "alpha", "beta", "alpha2")]
    assert numbers == ["SUP-000001", "SUP-000002", "SUP-000003", "SUP-000004", "SUP-000005"]


@pytest.mark.parametrize("category", ["technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry"])
def test_all_five_categories_are_accepted(world, category):
    assert world["alpha"].ticket(category=category)["category"] == category


def test_the_category_labels(world):
    labels = {c: world["alpha"].ticket(category=c)["category_label"] for c in ("technical_issue", "change_request", "account_organization", "billing_subscription", "general_inquiry")}
    assert labels == {"technical_issue": "Technical Issue", "change_request": "Change Request", "account_organization": "Account & Organization",
                      "billing_subscription": "Billing & Subscription", "general_inquiry": "General Inquiry"}


def test_the_priority_defaults_to_normal_and_must_be_a_known_one(world):
    assert world["alpha"].client.post(TICKETS, json={"subject": "Hello there", "category": "general_inquiry", "message": "Hi"}, headers={**world["alpha"].headers, **world["alpha"].key()}).json()["priority"] == "normal"
    for bad in ("critical", "", "HIGH", None, 3):
        assert world["alpha"].open(priority=bad).status_code == 422, bad
    for good in ("low", "normal", "high", "urgent"):
        assert world["alpha"].ticket(priority=good)["priority"] == good


@pytest.mark.parametrize("field, value", [
    ("subject", ""), ("subject", "  "), ("subject", "ab"), ("subject", "x" * 151), ("subject", 5), ("message", ""), ("message", "   \n  "), ("message", "x" * 5001), ("message", None),
    ("category", "sales"), ("category", ""),
])
def test_bad_values_are_refused(world, field, value):
    assert world["alpha"].open(**{field: value}).status_code == 422


@pytest.mark.parametrize("field, value", [
    ("organization_id", str(uuid.uuid4())), ("status", "resolved"), ("ticket_number", "SUP-999999"), ("created_by_user_id", str(uuid.uuid4())), ("requester_email", "evil@example.org"),
    ("requester_name", "Someone Else"), ("recipient", "evil@example.org"), ("sender_role", "super-admin"), ("organization_name", "Beta Logistics"), ("to", "evil@example.org"),
])
def test_nothing_the_server_decides_can_be_supplied_by_the_caller(world, session_factory, field, value):
    assert world["alpha"].open(**{field: value}).status_code == 422
    assert rows(session_factory, SupportTicket) == []


def test_the_message_is_plain_text_with_line_breaks_kept_and_control_characters_removed(world):
    ticket = world["alpha"].ticket(subject="Line one\r\nBcc: evil@example.org", message="First\r\nSecond\u0000‮\n\n\n\n\n\nThird")
    assert ticket["subject"] == "Line one Bcc: evil@example.org"  # one line: it can never add a header
    assert ticket["messages"][0]["body"] == "First\nSecond\n\n\nThird"


def test_markup_is_stored_as_text_not_interpreted(world):
    body = '<script>alert("x")</script> <img src=x onerror=alert(1)> & "quotes"'
    ticket = world["alpha"].ticket(subject="<b>bold</b> subject", message=body)
    assert ticket["subject"] == "<b>bold</b> subject" and ticket["messages"][0]["body"] == body
    shown = world["root"].open_admin(ticket["id"])
    assert shown.headers["content-type"] == "application/json" and shown.json()["messages"][0]["body"] == body


def test_a_change_request_is_only_a_request_nothing_about_the_organization_changes(world):
    world["directory"].requests.clear()
    ticket = world["alpha"].ticket(category="change_request", subject="Enable the invoicing module", message="Please enable invoicing and rename our organization to Alpha Group.")
    assert ticket["category"] == "change_request" and ticket["status"] == "open"
    assert {(svc, method) for svc, method, _ in world["directory"].requests} <= {("auth", "GET"), ("org", "GET")}  # reads only: no service was asked to change anything
    assert world["directory"].organizations[world["alpha_id"]]["name"] == "Alpha Trading"


def test_forged_organization_ids_are_ignored(world, session_factory):
    other = world["beta_id"]
    response = world["alpha"].client.post(f"{TICKETS}?organization_id={other}", json={"subject": "Hello there", "category": "general_inquiry", "message": "hi"},
                                          headers={**world["alpha"].headers, **world["alpha"].key(), "X-Organization-Id": other})
    assert response.status_code == 201
    (stored,) = rows(session_factory, SupportTicket)
    assert str(stored.organization_id) == world["alpha_id"] and stored.organization_name == "Alpha Trading"


# =====================================================================================================
# the Super Admin sees it, and replies
# =====================================================================================================
def test_the_super_admin_sees_tickets_of_every_organization(world):
    a, b = world["alpha"].ticket(subject="Alpha problem"), world["beta"].ticket(subject="Beta problem")
    inbox = world["root"].inbox().json()
    assert inbox["total"] == 2 and {i["ticket_number"] for i in inbox["items"]} == {a["ticket_number"], b["ticket_number"]}
    by = {i["subject"]: i for i in inbox["items"]}
    assert (by["Alpha problem"]["organization_name"], by["Alpha problem"]["requester_name"], by["Alpha problem"]["requester_email"], by["Alpha problem"]["organization_id"]) == (
        "Alpha Trading", "Alice Alpha", "alice@alpha.example", world["alpha_id"])
    assert by["Beta problem"]["organization_name"] == "Beta Logistics"
    for item in by.values():
        assert {"ticket_number", "organization_name", "requester_name", "subject", "category", "priority", "status", "created_at", "last_reply_at", "unread"} <= set(item)


def test_the_customer_view_hides_platform_only_details(world):
    ticket = world["alpha"].ticket()
    mine = world["alpha"].read(ticket["id"]).json()
    assert mine["organization_id"] is None and mine["requester_email"] is None and mine["events"] is None and mine["notifications"] is None
    platform = world["root"].open_admin(ticket["id"]).json()
    assert platform["requester_email"] == "alice@alpha.example" and platform["events"] and platform["notifications"]


def test_the_super_admin_replies_in_the_portal_and_the_customer_sees_it(world, session_factory):
    ticket = world["alpha"].ticket()
    reply = world["root"].reply(ticket["id"], body="Please restart the printer service, then tell us if E-42 returns.")
    assert reply.status_code == 201
    body = reply.json()
    assert body["status"] == "waiting_for_customer" and [m["sender_role"] for m in body["messages"]] == ["organization-admin", "super-admin"]
    assert body["messages"][1]["sender_name"] == "Root Admin"
    seen = world["alpha"].read(ticket["id"]).json()
    assert seen["status"] == "waiting_for_customer" and seen["messages"][1]["body"].startswith("Please restart")
    notes = rows(session_factory, SupportEmailOutbox)
    assert sorted(n.notification_type for n in notes) == ["new_ticket", "staff_reply"]
    assert next(n for n in notes if n.notification_type == "staff_reply").recipient == "alice@alpha.example"  # the ticket's verified requester, nobody else


def test_a_reply_can_move_the_ticket_along_with_it(world):
    ticket = world["alpha"].ticket()
    assert world["root"].reply(ticket["id"], status="resolved").json()["status"] == "resolved"
    other = world["alpha"].ticket(subject="Another problem")
    assert world["root"].reply(other["id"], status="in_progress").json()["status"] == "in_progress"
    assert world["root"].reply(other["id"], status="closed").json()["status"] == "closed"


def test_a_note_after_resolution_keeps_it_resolved_and_a_closed_ticket_must_be_reopened_first(world):
    ticket = world["alpha"].ticket()
    world["root"].update(ticket["id"], status="resolved")
    assert world["root"].reply(ticket["id"], body="Glad it works.").json()["status"] == "resolved"
    world["root"].update(ticket["id"], status="closed")
    closed = world["root"].reply(ticket["id"])
    assert closed.status_code == 409 and closed.json()["detail"]["code"] == "ticket_closed"
    world["root"].update(ticket["id"], status="open")
    assert world["root"].reply(ticket["id"]).status_code == 201


def test_replies_must_be_valid_and_cannot_choose_the_sender(world):
    ticket = world["alpha"].ticket()
    for bad in ("", "  ", "x" * 5001):
        assert world["root"].reply(ticket["id"], body=bad).status_code == 422
    for extra in ({"sender_role": "organization-admin"}, {"recipient": "evil@example.org"}, {"organization_id": world["beta_id"]}):
        response = world["root"].client.post(f"{ADMIN}/tickets/{ticket['id']}/messages", json={"body": "hello", **extra}, headers={**world["root"].headers, **world["root"].key()})
        assert response.status_code == 422
    assert world["root"].reply(ticket["id"], status="waiting").status_code == 422
    assert world["root"].reply(str(uuid.uuid4())).status_code == 404


# =====================================================================================================
# follow-ups and the lifecycle
# =====================================================================================================
def test_a_customer_follow_up_goes_back_to_open_and_asks_for_attention(world, session_factory):
    ticket = world["alpha"].ticket()
    world["root"].reply(ticket["id"])
    follow = world["alpha"].follow_up(ticket["id"], "It still fails.")
    assert follow.status_code == 201 and follow.json()["status"] == "open" and follow.json()["messages"][-1]["body"] == "It still fails."
    item = world["root"].inbox().json()["items"][0]
    assert item["awaiting_staff"] is True and item["last_message_role"] == "organization-admin" and item["unread"] is True
    assert sorted(n.notification_type for n in rows(session_factory, SupportEmailOutbox)) == ["customer_followup", "new_ticket", "staff_reply"]
    assert [e.new_value for e in rows(session_factory, SupportTicketEvent) if e.event_type == "status_changed"] == ["waiting_for_customer", "open"]


def test_a_follow_up_on_a_ticket_being_worked_keeps_it_in_progress_and_reopens_a_resolved_one(world):
    ticket = world["alpha"].ticket()
    world["root"].update(ticket["id"], status="in_progress")
    assert world["alpha"].follow_up(ticket["id"]).json()["status"] == "in_progress"
    world["root"].update(ticket["id"], status="resolved")
    reopened = world["alpha"].follow_up(ticket["id"], "Not fixed after all.").json()
    assert reopened["status"] == "open" and reopened["resolved_at"] is None


def test_a_closed_ticket_takes_no_more_messages_from_the_customer(world):
    ticket = world["alpha"].ticket()
    world["root"].update(ticket["id"], status="closed")
    response = world["alpha"].follow_up(ticket["id"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "ticket_closed"
    assert world["alpha"].read(ticket["id"]).json()["can_reply"] is False


def test_any_administrator_of_the_organization_can_follow_up_and_it_is_attributed_to_them(world):
    ticket = world["alpha"].ticket()
    reply = world["alpha2"].follow_up(ticket["id"], "Alan here: same problem on our side.").json()
    assert reply["messages"][-1]["sender_name"] == "Alan Alpha"
    assert reply["requester_name"] == "Alice Alpha"  # the ticket keeps its requester


def test_the_documented_status_moves_and_no_others(world, monkeypatch):
    monkeypatch.setenv("SUPPORT_TICKETS_PER_HOUR", "1000")  # this test opens 25 tickets
    allowed = {"open": {"in_progress", "waiting_for_customer", "resolved", "closed"}, "in_progress": {"open", "waiting_for_customer", "resolved", "closed"},
               "waiting_for_customer": {"open", "in_progress", "resolved", "closed"}, "resolved": {"open", "in_progress", "closed"}, "closed": {"open"}}
    every = ["open", "in_progress", "waiting_for_customer", "resolved", "closed"]
    path = {"open": [], "in_progress": ["in_progress"], "waiting_for_customer": ["waiting_for_customer"], "resolved": ["resolved"], "closed": ["closed"]}
    for start in every:
        for target in every:
            ticket = world["alpha"].ticket()
            for step in path[start]:
                assert world["root"].update(ticket["id"], status=step).status_code == 200
            response = world["root"].update(ticket["id"], status=target)
            if target == start or target in allowed[start]:
                assert response.status_code == 200 and response.json()["status"] == target, (start, target)
            else:
                assert response.status_code == 409 and response.json()["detail"]["code"] == "invalid_transition", (start, target)


def test_resolving_records_the_time_and_reopening_clears_it(world):
    ticket = world["alpha"].ticket()
    resolved = world["root"].update(ticket["id"], status="resolved").json()
    assert resolved["resolved_at"]
    assert world["root"].update(ticket["id"], status="closed").json()["resolved_at"] == resolved["resolved_at"]  # closing keeps when it was resolved
    assert world["root"].update(ticket["id"], status="open").json()["resolved_at"] is None


def test_priority_and_status_changes_are_audited_in_order(world):
    ticket = world["alpha"].ticket()
    world["root"].update(ticket["id"], priority="urgent", status="in_progress")
    world["root"].update(ticket["id"], status="resolved")
    world["root"].update(ticket["id"], status="resolved")  # nothing changes: nothing is recorded
    events = world["root"].open_admin(ticket["id"]).json()["events"]
    assert [(e["event_type"], e["old_value"], e["new_value"], e["actor_role"]) for e in events] == [
        ("created", None, "open", "organization-admin"), ("priority_changed", "normal", "urgent", "super-admin"),
        ("status_changed", "open", "in_progress", "super-admin"), ("status_changed", "in_progress", "resolved", "super-admin"),
    ]


def test_updating_needs_a_change_and_only_those_fields(world):
    ticket = world["alpha"].ticket()
    assert world["root"].update(ticket["id"]).status_code == 422
    assert world["root"].update(ticket["id"], status="frozen").status_code == 422
    assert world["root"].update(ticket["id"], priority="meh").status_code == 422
    for extra in ({"organization_id": world["beta_id"]}, {"subject": "Hijacked"}, {"ticket_number": "SUP-1"}):
        assert world["root"].client.patch(f"{ADMIN}/tickets/{ticket['id']}", json={"status": "open", **extra}, headers=world["root"].headers).status_code == 422
    assert world["root"].update(str(uuid.uuid4()), status="closed").status_code == 404


# =====================================================================================================
# unread, search, filters, pagination
# =====================================================================================================
def test_unread_indicators_follow_who_has_opened_what(world):
    ticket = world["alpha"].ticket()
    assert world["root"].inbox().json()["items"][0]["unread"] is True and world["root"].client.get(f"{ADMIN}/summary", headers=world["root"].headers).json()["unread"] == 1
    assert world["alpha"].mine().json()["items"][0]["unread"] is False  # the customer wrote it: nothing for them to read
    world["root"].open_admin(ticket["id"])
    assert world["root"].inbox().json()["items"][0]["unread"] is False
    world["root"].reply(ticket["id"])
    assert world["alpha"].mine().json()["items"][0]["unread"] is True
    assert world["alpha"].client.get("/api/v1/support/summary", headers=world["alpha"].headers).json() == {"unread": 1, "open": 1, "total": 1}
    detail = world["alpha"].read(ticket["id"]).json()
    assert detail["unread"] is False  # opening the ticket is what clears the indicator
    assert world["alpha"].mine().json()["items"][0]["unread"] is False
    assert world["alpha"].client.get("/api/v1/support/summary", headers=world["alpha"].headers).json()["unread"] == 0
    assert world["root"].open_admin(ticket["id"]).json()["messages"][1]["read"] is True  # the customer has seen the reply


def test_each_message_remembers_whether_the_other_side_has_read_it(world):
    ticket = world["alpha"].ticket()
    assert world["alpha"].read(ticket["id"]).json()["messages"][0]["read"] is False
    world["root"].open_admin(ticket["id"])
    assert world["alpha"].read(ticket["id"]).json()["messages"][0]["read"] is True


def test_the_customer_list_filters_by_status_category_search_and_unread(world):
    a = world["alpha"].ticket(subject="Printer broken", category="technical_issue")
    world["alpha"].ticket(subject="Invoice question", category="billing_subscription")
    c = world["alpha"].ticket(subject="Enable module", category="change_request")
    world["root"].reply(a["id"])
    world["root"].update(c["id"], status="closed")
    assert world["alpha"].mine().json()["total"] == 3
    assert [i["subject"] for i in world["alpha"].mine(status="closed").json()["items"]] == ["Enable module"]
    assert [i["subject"] for i in world["alpha"].mine(category="billing_subscription").json()["items"]] == ["Invoice question"]
    assert [i["subject"] for i in world["alpha"].mine(q="printer").json()["items"]] == ["Printer broken"]
    assert [i["subject"] for i in world["alpha"].mine(q=a["ticket_number"]).json()["items"]] == ["Printer broken"]
    assert [i["subject"] for i in world["alpha"].mine(unread="true").json()["items"]] == ["Printer broken"]
    assert world["alpha"].mine(unread="false").json()["total"] == 2
    counts = world["alpha"].mine().json()["counts"]
    assert counts == {"open": 1, "in_progress": 0, "waiting_for_customer": 1, "resolved": 0, "closed": 1}
    assert world["alpha"].mine(status="nonsense").status_code == 422 and world["alpha"].mine(category="nonsense").status_code == 422


def test_the_inbox_filters_by_priority_category_organization_and_searches_names(world):
    world["alpha"].ticket(subject="Alpha low", priority="low")
    world["beta"].ticket(subject="Beta urgent", priority="urgent", category="billing_subscription")
    assert [i["subject"] for i in world["root"].inbox(priority="urgent").json()["items"]] == ["Beta urgent"]
    assert [i["subject"] for i in world["root"].inbox(category="billing_subscription").json()["items"]] == ["Beta urgent"]
    assert [i["subject"] for i in world["root"].inbox(organization_id=world["alpha_id"]).json()["items"]] == ["Alpha low"]
    assert [i["subject"] for i in world["root"].inbox(q="beta logistics").json()["items"]] == ["Beta urgent"]
    assert [i["subject"] for i in world["root"].inbox(q="alice").json()["items"]] == ["Alpha low"]
    assert [i["subject"] for i in world["root"].inbox(q="bob@beta").json()["items"]] == ["Beta urgent"]
    assert world["root"].inbox(q="nobody").json()["total"] == 0


def test_search_text_is_matched_literally(world):
    world["alpha"].ticket(subject="100% sure", message="x")
    world["alpha"].ticket(subject="Something else", message="x")
    assert [i["subject"] for i in world["alpha"].mine(q="100%").json()["items"]] == ["100% sure"]
    assert world["alpha"].mine(q="%").json()["total"] == 1
    assert world["alpha"].mine(q="_").json()["total"] == 0


def test_pagination_and_newest_activity_first(world):
    tickets = [world["alpha"].ticket(subject=f"Problem number {i}") for i in range(5)]
    world["root"].reply(tickets[0]["id"])  # activity: the oldest ticket moves to the top
    page = world["alpha"].mine(limit=2, offset=0).json()
    assert (page["total"], page["limit"], page["offset"], [i["subject"] for i in page["items"]]) == (5, 2, 0, ["Problem number 0", "Problem number 4"])
    assert [i["subject"] for i in world["alpha"].mine(limit=2, offset=4).json()["items"]] == ["Problem number 1"]
    assert world["alpha"].mine(limit=0).status_code == 422 and world["alpha"].mine(limit=101).status_code == 422 and world["alpha"].mine(offset=-1).status_code == 422


# =====================================================================================================
# duplicate submissions and rate limits
# =====================================================================================================
def test_the_same_submission_twice_is_one_ticket(world, session_factory):
    first = world["alpha"].open(key="idem-ticket-0001")
    again = world["alpha"].open(key="idem-ticket-0001")
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["id"] == again.json()["id"]
    assert [len(rows(session_factory, m)) for m in (SupportTicket, SupportMessage, SupportEmailOutbox)] == [1, 1, 1]
    different = world["alpha"].open(subject="A different request", key="idem-ticket-0001")
    assert different.status_code == 409 and different.json()["detail"]["code"] == "idempotency_conflict"


def test_a_key_is_required_and_must_look_like_one(world):
    for headers in ({}, {"Idempotency-Key": ""}, {"Idempotency-Key": "short"}, {"Idempotency-Key": "has spaces in it!"}):
        response = world["alpha"].client.post(TICKETS, json={"subject": "Hello there", "category": "general_inquiry", "message": "hi"}, headers={**world["alpha"].headers, **headers})
        assert response.status_code == 400, headers


def test_simultaneous_identical_submissions_create_one_ticket(world, session_factory):
    results = []

    def go():
        results.append(world["alpha"].open(key="idem-race-00001").status_code)

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200] * 5 + [201]
    assert len(rows(session_factory, SupportTicket)) == 1 and len(rows(session_factory, SupportEmailOutbox)) == 1


def test_a_follow_up_submitted_twice_is_recorded_once(world, session_factory):
    ticket = world["alpha"].ticket()
    first = world["alpha"].follow_up(ticket["id"], "Any news?", key="idem-follow-0001")
    again = world["alpha"].follow_up(ticket["id"], "Any news?", key="idem-follow-0001")
    assert (first.status_code, again.status_code) == (201, 200) and len(again.json()["messages"]) == 2
    assert world["alpha"].follow_up(ticket["id"], "Different words", key="idem-follow-0001").status_code == 409
    assert len(rows(session_factory, SupportMessage)) == 2


def test_a_staff_reply_submitted_twice_is_recorded_once(world, session_factory):
    ticket = world["alpha"].ticket()
    first, again = world["root"].reply(ticket["id"], key="idem-reply-00001"), world["root"].reply(ticket["id"], key="idem-reply-00001")
    assert (first.status_code, again.status_code) == (201, 200)
    assert len(rows(session_factory, SupportMessage)) == 2 and len([n for n in rows(session_factory, SupportEmailOutbox) if n.notification_type == "staff_reply"]) == 1


def test_simultaneous_replies_with_one_key_send_one_reply(world, session_factory):
    ticket = world["alpha"].ticket()
    results = []

    def go():
        results.append(world["root"].reply(ticket["id"], key="idem-reply-race-1").status_code)

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(results) == [200] * 5 + [201]
    assert len(rows(session_factory, SupportMessage)) == 2


def test_ticket_creation_is_rate_limited_per_administrator(world, monkeypatch):
    monkeypatch.setenv("SUPPORT_TICKETS_PER_HOUR", "3")
    for _ in range(3):
        world["alpha"].ticket()
    limited = world["alpha"].open()
    assert limited.status_code == 429 and limited.json()["detail"]["code"] == "rate_limited" and "Retry-After" in limited.headers
    assert world["alpha2"].open().status_code == 201  # another person is not affected
    assert world["beta"].open().status_code == 201


def test_messages_are_rate_limited_per_person(world, monkeypatch):
    monkeypatch.setenv("SUPPORT_MESSAGES_PER_10_MIN", "3")
    ticket = world["alpha"].ticket()  # the first message counts
    assert world["alpha"].follow_up(ticket["id"], "one").status_code == 201
    assert world["alpha"].follow_up(ticket["id"], "two").status_code == 201
    assert world["alpha"].follow_up(ticket["id"], "three").status_code == 429
    assert world["alpha2"].follow_up(ticket["id"], "someone else").status_code == 201


def test_a_rate_limited_request_stores_nothing_and_can_be_retried_later(world, session_factory, monkeypatch):
    monkeypatch.setenv("SUPPORT_TICKETS_PER_HOUR", "1")
    world["alpha"].ticket()
    assert world["alpha"].open(key="idem-limited-001").status_code == 429
    assert len(rows(session_factory, SupportTicket)) == 1
    monkeypatch.setenv("SUPPORT_TICKETS_PER_HOUR", "5")
    assert world["alpha"].open(key="idem-limited-001").status_code == 201  # the refused key was not consumed


# --- deleting a ticket from YOUR side ------------------------------------------------------------------------------------------------------
def test_deleting_a_ticket_removes_it_from_my_side_only_and_unsends_nothing(world, session_factory):
    from sqlalchemy import text
    mine, keep = world["alpha"].ticket(subject="Delete me"), world["alpha"].ticket(subject="Keep me")
    other = world["beta"].ticket(subject="Beta ticket")
    assert world["alpha"].client.post(f"{TICKETS}/{mine['id']}/hide", headers=world["alpha"].headers).status_code == 204
    assert world["alpha"].client.post(f"{TICKETS}/{mine['id']}/hide", headers=world["alpha"].headers).status_code == 204  # asking twice is fine
    page = world["alpha"].mine().json()
    assert [i["id"] for i in page["items"]] == [keep["id"]] and page["total"] == 1 and page["counts"]["open"] == 1
    assert world["alpha"].client.get("/api/v1/support/summary", headers=world["alpha"].headers).json()["total"] == 1
    assert world["alpha"].read(mine["id"]).status_code == 404  # it cannot be opened or replied to any more
    assert world["alpha"].follow_up(mine["id"]).status_code == 404
    inbox = world["root"].inbox().json()
    assert mine["id"] in [i["id"] for i in inbox["items"]]  # the Super Admin still has it: nothing was unsent
    assert world["root"].open_admin(mine["id"]).status_code == 200
    with session_factory() as db:
        assert db.execute(text("SELECT count(*), count(hidden_by_organization_at) FROM support_tickets")).one() == (3, 1)
        assert db.execute(text("SELECT count(*) FROM support_messages")).scalar() == 3 and db.execute(text("SELECT count(*) FROM support_email_outbox")).scalar() >= 3
    assert [i["id"] for i in world["beta"].mine().json()["items"]] == [other["id"]]


def test_nobody_can_delete_another_organizations_ticket_and_a_super_admin_has_no_such_button(world):
    mine = world["alpha"].ticket()
    assert world["beta"].client.post(f"{TICKETS}/{mine['id']}/hide", headers=world["beta"].headers).status_code == 404
    assert world["root"].client.post(f"{TICKETS}/{mine['id']}/hide", headers=world["root"].headers).status_code == 403
    assert world["alpha"].client.post(f"{TICKETS}/{mine['id']}/hide").status_code == 401
    assert len(world["alpha"].mine().json()["items"]) == 1
