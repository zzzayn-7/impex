"""Rules the DATABASE enforces by itself, with the API bypassed (raw SQL): nothing is deleted or edited, identity never changes, the status
moves only along the documented transitions, the audit trail is append-only, and the schema is exactly what the migration built."""
import uuid

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import alembic_config, targeting_test_database


def run(engine, sql, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params)


def refused(engine, sql, **params) -> str:
    with pytest.raises(DBAPIError) as caught:
        run(engine, sql, **params)
    return str(caught.value.orig)


def make_ticket(engine, number="SUP-000001", status="open", organization=None):
    ticket, org = uuid.uuid4(), organization or uuid.uuid4()
    resolved = "now()" if status == "resolved" else "NULL"
    run(engine,
        "INSERT INTO support_tickets (id, organization_id, ticket_number, created_by_user_id, requester_name, requester_email, organization_name, subject, category, status, resolved_at) "
        f"VALUES (:id, :o, :n, :u, 'A', 'a@b.c', 'Org', 'Subject line', 'general_inquiry', :s, {resolved})", id=ticket, o=org, n=number, u=uuid.uuid4(), s=status)
    return ticket


def make_message(engine, ticket, body="hello", role="organization-admin"):
    message = uuid.uuid4()
    run(engine, "INSERT INTO support_messages (id, ticket_id, sender_user_id, sender_role, sender_name, message_body) VALUES (:id, :t, :u, :r, 'A', :b)",
        id=message, t=ticket, u=uuid.uuid4(), r=role, b=body)
    return message


def test_the_schema_comes_from_the_migration_and_matches_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0002"
    with targeting_test_database():
        command.check(alembic_config())  # raises if the models and the migrations disagree


def test_tickets_are_never_deleted(engine):
    ticket = make_ticket(engine)
    assert "never deleted" in refused(engine, "DELETE FROM support_tickets WHERE id = :i", i=ticket)
    assert run(engine, "SELECT count(*) FROM support_tickets").scalar() == 1


def test_a_ticket_with_messages_cannot_be_deleted_even_with_the_maintenance_switch_unless_its_messages_go_first(engine):
    ticket = make_ticket(engine)
    make_message(engine, ticket)
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
            conn.execute(text("DELETE FROM support_tickets WHERE id = :i"), {"i": ticket})  # the foreign key still protects the conversation
    assert run(engine, "SELECT count(*) FROM support_messages").scalar() == 1


def test_messages_are_never_deleted_or_edited(engine):
    message = make_message(engine, make_ticket(engine), "original words")
    assert "never deleted" in refused(engine, "DELETE FROM support_messages WHERE id = :i", i=message)
    for change in ("message_body = 'edited'", "sender_role = 'super-admin'", "sender_name = 'Someone Else'", "created_at = now() - interval '1 day'", "sender_user_id = gen_random_uuid()"):
        assert "cannot be edited" in refused(engine, f"UPDATE support_messages SET {change} WHERE id = :i", i=message), change
    assert run(engine, "SELECT message_body FROM support_messages WHERE id = :i", i=message).scalar() == "original words"


def test_the_only_change_a_message_allows_is_being_read_once(engine):
    message = make_message(engine, make_ticket(engine))
    run(engine, "UPDATE support_messages SET read_at = now() WHERE id = :i", i=message)
    assert "cannot be edited" in refused(engine, "UPDATE support_messages SET read_at = NULL WHERE id = :i", i=message)
    assert "cannot be edited" in refused(engine, "UPDATE support_messages SET read_at = now() + interval '1 hour' WHERE id = :i", i=message)


def test_a_ticket_identity_never_changes(engine):
    ticket = make_ticket(engine)
    for change in ("organization_id = gen_random_uuid()", "ticket_number = 'SUP-999999'", "created_by_user_id = gen_random_uuid()", "created_at = now() - interval '1 year'", "id = gen_random_uuid()"):
        assert "identity" in refused(engine, f"UPDATE support_tickets SET {change} WHERE id = :i", i=ticket), change


@pytest.mark.parametrize("start, target, allowed", [
    ("open", "in_progress", True), ("open", "waiting_for_customer", True), ("open", "resolved", True), ("open", "closed", True),
    ("in_progress", "open", True), ("in_progress", "resolved", True), ("waiting_for_customer", "in_progress", True),
    ("resolved", "open", True), ("resolved", "in_progress", True), ("resolved", "closed", True), ("resolved", "waiting_for_customer", False),
    ("closed", "open", True), ("closed", "in_progress", False), ("closed", "waiting_for_customer", False), ("closed", "resolved", False),
])
def test_the_database_enforces_the_status_transitions(engine, start, target, allowed):
    ticket = make_ticket(engine, status=start)
    sql = "UPDATE support_tickets SET status = :s, resolved_at = " + ("now()" if target == "resolved" else "NULL") + " WHERE id = :i"
    if allowed:
        run(engine, sql, s=target, i=ticket)
        assert run(engine, "SELECT status FROM support_tickets WHERE id = :i", i=ticket).scalar() == target
    else:
        assert "cannot go from" in refused(engine, sql, s=target, i=ticket)


def test_ticket_numbers_are_unique(engine):
    make_ticket(engine, "SUP-000001")
    assert "uq_support_tickets_ticket_number" in refused(engine, "INSERT INTO support_tickets (organization_id, ticket_number, created_by_user_id, requester_name, requester_email, organization_name, subject, category) "
                                                          "VALUES (gen_random_uuid(), 'SUP-000001', gen_random_uuid(), 'A', 'a@b.c', 'O', 'Subject', 'general_inquiry')")


@pytest.mark.parametrize("assignment, word", [
    ("category = 'sales'", "category_valid"), ("priority = 'critical'", "priority_valid"), ("status = 'frozen'", "cannot go from"), ("subject = 'ab'", "subject_length"),
    ("status = 'resolved', resolved_at = NULL", "resolved_has_a_time"),
])
def test_values_are_checked_by_the_database(engine, assignment, word):
    ticket = make_ticket(engine)
    assert word in refused(engine, f"UPDATE support_tickets SET {assignment} WHERE id = :i", i=ticket)


def test_message_bodies_are_bounded_and_roles_known(engine):
    ticket = make_ticket(engine)
    assert "body_length" in refused(engine, "INSERT INTO support_messages (ticket_id, sender_user_id, sender_role, sender_name, message_body) VALUES (:t, gen_random_uuid(), 'organization-admin', 'A', '')", t=ticket)
    assert "body_length" in refused(engine, "INSERT INTO support_messages (ticket_id, sender_user_id, sender_role, sender_name, message_body) VALUES (:t, gen_random_uuid(), 'organization-admin', 'A', repeat('x', 5001))", t=ticket)
    assert "sender_role_valid" in refused(engine, "INSERT INTO support_messages (ticket_id, sender_user_id, sender_role, sender_name, message_body) VALUES (:t, gen_random_uuid(), 'user', 'A', 'hi')", t=ticket)


def test_the_audit_trail_is_append_only(engine):
    ticket = make_ticket(engine)
    event = uuid.uuid4()
    run(engine, "INSERT INTO support_ticket_events (id, ticket_id, actor_user_id, actor_role, event_type, new_value) VALUES (:e, :t, gen_random_uuid(), 'super-admin', 'created', 'open')", e=event, t=ticket)
    assert "append-only" in refused(engine, "UPDATE support_ticket_events SET new_value = 'x' WHERE id = :e", e=event)
    assert "append-only" in refused(engine, "DELETE FROM support_ticket_events WHERE id = :e", e=event)
    assert "event_type_valid" in refused(engine, "INSERT INTO support_ticket_events (ticket_id, actor_user_id, actor_role, event_type) VALUES (:t, gen_random_uuid(), 'super-admin', 'erased')", t=ticket)


def test_a_notification_record_is_never_deleted_and_never_changes_what_it_is_about(engine):
    ticket = make_ticket(engine)
    note = uuid.uuid4()
    run(engine, "INSERT INTO support_email_outbox (id, ticket_id, recipient, notification_type) VALUES (:n, :t, 'x@y.z', 'new_ticket')", n=note, t=ticket)
    assert "never deleted" in refused(engine, "DELETE FROM support_email_outbox WHERE id = :n", n=note)
    assert "can never change" in refused(engine, "UPDATE support_email_outbox SET notification_type = 'staff_reply' WHERE id = :n", n=note)
    run(engine, "UPDATE support_email_outbox SET delivery_status = 'sent', attempts = 1, sent_at = now() WHERE id = :n", n=note)  # delivery state is what changes
    assert "delivery_status_valid" in refused(engine, "UPDATE support_email_outbox SET delivery_status = 'lost' WHERE id = :n", n=note)
    assert "notification_type_valid" in refused(engine, "INSERT INTO support_email_outbox (ticket_id, notification_type) VALUES (:t, 'spam')", t=ticket)


def test_a_request_record_is_unique_per_scope_and_key(engine):
    scope = uuid.uuid4()
    run(engine, "INSERT INTO support_requests (scope_id, idempotency_key, request_hash) VALUES (:s, 'key-12345678', 'h')", s=scope)
    assert "uq_support_requests_scope_id_idempotency_key" in refused(engine, "INSERT INTO support_requests (scope_id, idempotency_key, request_hash) VALUES (:s, 'key-12345678', 'h2')", s=scope)
    run(engine, "INSERT INTO support_requests (scope_id, idempotency_key, request_hash) VALUES (gen_random_uuid(), 'key-12345678', 'h')")  # another scope may reuse a key


def test_the_maintenance_switch_lets_a_verification_script_clean_up_its_own_rows(engine):
    ticket = make_ticket(engine)
    message = make_message(engine, ticket)
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
        conn.execute(text("DELETE FROM support_messages WHERE id = :m"), {"m": message})
        conn.execute(text("DELETE FROM support_tickets WHERE id = :t"), {"t": ticket})
    assert run(engine, "SELECT count(*) FROM support_tickets").scalar() == 0
    ticket2 = make_ticket(engine, "SUP-000002")
    assert "never deleted" in refused(engine, "DELETE FROM support_tickets WHERE id = :i", i=ticket2)  # the switch was only for that transaction
