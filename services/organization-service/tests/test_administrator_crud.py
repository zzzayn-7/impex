"""Edit and delete administrators, and DEMO MODE (account created at once, credentials emailed).

Create/list/resend/duplicates are covered in test_administrators.py; these tests cover what CRUD adds.
"""
import pytest
from sqlalchemy import select

from app.models import OrganizationInvitation

from conftest import token_from_message
from test_activation import accept, lookup
from test_administrators import (  # noqa: F401  (fixtures are used by name)
    ADMIN, ORGS, add, client, expire, fake_auth, listing, make_org, resend, rows,
)


def patch(client, org_id, admin_id, headers=ADMIN, **body):
    return client.patch(f"{ORGS}/{org_id}/administrators/{admin_id}", json=body, headers=headers)


def remove(client, org_id, admin_id, headers=ADMIN):
    return client.delete(f"{ORGS}/{org_id}/administrators/{admin_id}", headers=headers)


@pytest.fixture
def demo(monkeypatch):
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.delenv("DEMO_ADMIN_PASSWORD", raising=False)


# --- authorization ------------------------------------------------------------
@pytest.mark.parametrize("headers,expected", [
    ({}, 401), ({"Authorization": "Bearer expired-token"}, 401),
    ({"Authorization": "Bearer user-token"}, 403), ({"Authorization": "Bearer disabled-admin-token"}, 403),
])
def test_only_super_admins_may_edit_or_delete(client, smtp, fake_auth, session_factory, headers, expected):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    assert patch(client, org["id"], admin["id"], headers=headers, full_name="Hijack").status_code == expected
    assert remove(client, org["id"], admin["id"], headers=headers).status_code == expected
    assert [r.full_name for r in rows(session_factory)] == ["Ada Lovelace"]
    assert fake_auth.updates == [] and fake_auth.deletes == []


# --- update a pending invitation -----------------------------------------------
def test_editing_the_name_of_a_pending_administrator_keeps_the_same_link(client, smtp, session_factory):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    token = token_from_message(smtp.messages[0])
    response = patch(client, org["id"], admin["id"], full_name="  Ada   King ")
    assert response.status_code == 200 and response.json()["full_name"] == "Ada King"
    assert response.json()["id"] == admin["id"] and response.json()["status"] == "pending"
    assert len(smtp.messages) == 1  # nothing re-sent
    assert lookup(client, token).json()["full_name"] == "Ada King"  # the same link, with the new name


def test_changing_the_email_of_a_pending_administrator_replaces_the_invitation(client, smtp, session_factory):
    org = make_org(client)
    admin = add(client, org["id"], email="ada@example.org").json()
    old_token = token_from_message(smtp.messages[0])

    response = patch(client, org["id"], admin["id"], email="Ada.New@Example.org")
    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "ada.new@example.org" and body["status"] == "pending" and body["id"] != admin["id"]
    assert body["full_name"] == "Ada Lovelace"  # carried over

    assert len(smtp.messages) == 2 and smtp.messages[1]["To"] == "ada.new@example.org"
    old = lookup(client, old_token)
    assert old.status_code == 410 and old.json()["detail"]["code"] == "revoked"
    assert lookup(client, token_from_message(smtp.messages[1])).status_code == 200
    assert [a["email"] for a in listing(client).json()] == ["ada.new@example.org"]  # one row, no duplicate


def test_changing_to_an_email_that_cannot_be_used_is_refused_and_changes_nothing(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = add(client, org["id"], email="ada@example.org").json()
    add(client, org["id"], email="grace@example.org", full_name="Grace")
    fake_auth.users["taken@example.org"] = {"org": "other-org", "password": "x" * 12, "name": "Someone"}
    assert patch(client, org["id"], admin["id"], email="grace@example.org").status_code == 409  # already listed
    assert patch(client, org["id"], admin["id"], email="taken@example.org").status_code == 409  # another account
    assert len(smtp.messages) == 2 and {r.email for r in rows(session_factory)} == {"ada@example.org", "grace@example.org"}


def test_email_failure_while_changing_the_email_keeps_the_old_invitation(client, smtp, session_factory):
    org = make_org(client)
    admin = add(client, org["id"], email="ada@example.org").json()
    smtp.fail_on_connect = ConnectionRefusedError("down")
    assert patch(client, org["id"], admin["id"], email="new@example.org").status_code == 502
    (row,) = rows(session_factory)
    assert (str(row.id), row.email, row.revoked_at) == (admin["id"], "ada@example.org", None)


# --- update an active account ----------------------------------------------------
def activate(client, smtp, org, email="ada@example.org", name="Ada Lovelace"):
    admin = add(client, org["id"], email=email, full_name=name).json()
    assert accept(client, token_from_message(smtp.messages[-1]), name=name).status_code == 201
    return admin


def test_editing_an_active_administrator_updates_the_account_and_our_records(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = activate(client, smtp, org)
    response = patch(client, org["id"], admin["id"], full_name="Ada King", email="ada.king@example.org",
                     role="super-admin", organization_id="00000000-0000-4000-8000-000000000000")
    assert response.status_code == 200
    assert (response.json()["full_name"], response.json()["email"], response.json()["status"]) == ("Ada King", "ada.king@example.org", "active")

    (update,) = fake_auth.updates
    assert update == {"organization_id": org["id"], "email": "ada@example.org", "new_full_name": "Ada King", "new_email": "ada.king@example.org"}
    assert list(fake_auth.users) == ["ada.king@example.org"] and fake_auth.users["ada.king@example.org"]["name"] == "Ada King"
    assert {r.email for r in rows(session_factory)} == {"ada.king@example.org"}


def test_a_conflict_or_outage_in_the_account_service_changes_nothing(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = activate(client, smtp, org)
    fake_auth.users["taken@example.org"] = {"org": "other-org", "password": "x" * 12, "name": "Someone"}
    assert patch(client, org["id"], admin["id"], email="taken@example.org").status_code == 409
    fake_auth.mode = "down"
    assert patch(client, org["id"], admin["id"], full_name="New Name").status_code == 503
    fake_auth.mode = None
    assert [(r.email, r.full_name) for r in rows(session_factory)] == [("ada@example.org", "Ada Lovelace")]


@pytest.mark.parametrize("body,expected", [({}, 422), ({"email": "nope"}, 422), ({"full_name": "x" * 256}, 422)])
def test_invalid_edits_are_rejected(client, smtp, body, expected):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    assert patch(client, org["id"], admin["id"], **body).status_code == expected


def test_edit_validates_that_the_administrator_belongs_to_the_organization(client, smtp):
    acme, globex = make_org(client, "acme"), make_org(client, "globex", "Globex")
    admin = add(client, acme["id"]).json()
    assert patch(client, globex["id"], admin["id"], full_name="Hijack").status_code == 404
    assert patch(client, acme["id"], "not-a-uuid", full_name="X Y").status_code == 404


# --- delete ----------------------------------------------------------------------
def test_deleting_a_pending_administrator_kills_the_link_and_allows_a_fresh_start(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    token = token_from_message(smtp.messages[0])
    assert remove(client, org["id"], admin["id"]).status_code == 204
    assert rows(session_factory) == [] and listing(client).json() == []
    assert lookup(client, token).status_code == 404  # the link no longer exists
    assert fake_auth.deletes == []  # there was no account to remove
    assert add(client, org["id"]).status_code == 201  # and the same person can be invited again


def test_deleting_an_active_administrator_removes_their_account(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = activate(client, smtp, org)
    assert "ada@example.org" in fake_auth.users
    assert remove(client, org["id"], admin["id"]).status_code == 204
    assert fake_auth.deletes == [{"organization_id": org["id"], "email": "ada@example.org"}]
    assert fake_auth.users == {} and rows(session_factory) == []
    assert remove(client, org["id"], admin["id"]).status_code == 404  # already gone
    assert add(client, org["id"]).status_code == 201


def test_deleting_keeps_everything_when_the_account_service_is_down(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    admin = activate(client, smtp, org)
    fake_auth.mode = "down"
    assert remove(client, org["id"], admin["id"]).status_code == 503
    fake_auth.mode = None
    assert "ada@example.org" in fake_auth.users and len(rows(session_factory)) == 1
    assert remove(client, org["id"], admin["id"]).status_code == 204  # and the retry works


def test_delete_only_touches_the_named_administrator(client, smtp, fake_auth, session_factory):
    org = make_org(client)
    activate(client, smtp, org, "ada@example.org", "Ada")
    other = add(client, org["id"], email="grace@example.org", full_name="Grace").json()
    other_org = make_org(client, "globex", "Globex")
    foreign = add(client, other_org["id"], email="hank@example.org", full_name="Hank").json()
    assert remove(client, org["id"], foreign["id"]).status_code == 404  # right id, wrong organization
    assert remove(client, org["id"], other["id"]).status_code == 204
    assert {r.email for r in rows(session_factory)} == {"ada@example.org", "hank@example.org"}
    assert "ada@example.org" in fake_auth.users


# --- DEMO MODE -------------------------------------------------------------------
def test_demo_mode_creates_the_account_at_once_and_emails_the_sign_in_details(client, smtp, fake_auth, session_factory, demo):
    org = make_org(client)
    response = add(client, org["id"], email="Ada@Example.org", full_name="Ada Lovelace")
    assert response.status_code == 201
    body = response.json()
    assert (body["status"], body["role"], body["email"], body["organization_id"]) == ("active", "organization-admin", "ada@example.org", org["id"])
    assert body["activated_at"] is not None
    assert "12345678" not in response.text  # the API response never carries the password

    (create, _), = fake_auth.calls
    assert create["password"] == "12345678" and create["allow_weak_password"] is True
    assert create["organization_id"] == org["id"] and create["email"] == "ada@example.org"
    assert "role" not in create  # the role is decided by the Auth Service
    assert fake_auth.users["ada@example.org"]["org"] == org["id"]

    (message,) = smtp.messages
    assert message["To"] == "ada@example.org"
    assert message["Subject"] == "Your Impex administrator account for Acme Imports"
    for part in (message.get_body(("plain",)).get_content(), message.get_body(("html",)).get_content()):
        assert "Acme Imports" in part and "ada@example.org" in part and "12345678" in part
        assert "http://portal.test/login" in part
        assert "/activate" not in part  # no activation step in demo mode
    assert "Hello Ada Lovelace," in message.get_body(("plain",)).get_content()

    (row,) = rows(session_factory)
    assert row.accepted_at is not None and row.full_name == "Ada Lovelace"
    assert [a["status"] for a in listing(client).json()] == ["active"]


def test_demo_password_is_configurable(client, smtp, fake_auth, demo, monkeypatch):
    monkeypatch.setenv("DEMO_ADMIN_PASSWORD", "demo-pass-99")
    org = make_org(client)
    add(client, org["id"])
    assert fake_auth.calls[0][0]["password"] == "demo-pass-99"
    assert "demo-pass-99" in smtp.messages[0].get_body(("plain",)).get_content()


def test_demo_mode_still_rejects_duplicates_and_existing_accounts(client, smtp, fake_auth, session_factory, demo):
    org = make_org(client)
    assert add(client, org["id"]).status_code == 201
    assert add(client, org["id"]).status_code == 409  # already an administrator
    fake_auth.users["taken@example.org"] = {"org": "other-org", "password": "x" * 12, "name": "Someone"}
    assert add(client, org["id"], email="taken@example.org").status_code == 409
    assert len(smtp.messages) == 1 and len(rows(session_factory)) == 1 and len(fake_auth.users) == 2


def test_demo_email_failure_undoes_the_account_so_a_retry_starts_clean(client, smtp, fake_auth, session_factory, demo):
    org = make_org(client)
    smtp.fail_on_connect = ConnectionRefusedError("down")
    failed = add(client, org["id"])
    assert failed.status_code == 502 and "credentials email could not be sent" in failed.json()["detail"]
    assert fake_auth.users == {} and rows(session_factory) == []  # no account, no record
    assert fake_auth.deletes == [{"organization_id": org["id"], "email": "ada@example.org"}]
    smtp.fail_on_connect = None
    assert add(client, org["id"]).status_code == 201
    assert len(fake_auth.users) == 1 and len(rows(session_factory)) == 1


def test_demo_mode_fails_clearly_when_the_account_service_is_not_in_demo_mode(client, smtp, fake_auth, session_factory, demo):
    org = make_org(client)
    fake_auth.demo = False
    response = add(client, org["id"])
    assert response.status_code == 502 and "DEMO_MODE=true" in response.json()["detail"]
    assert smtp.messages == [] and rows(session_factory) == [] and fake_auth.users == {}


def test_demo_resend_sends_the_credentials_again_without_a_second_account(client, smtp, fake_auth, session_factory, demo):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    response = resend(client, org["id"], admin["id"])
    assert response.status_code == 201 and response.json()["id"] == admin["id"] and response.json()["status"] == "active"
    assert len(smtp.messages) == 2 and len(fake_auth.users) == 1 and len(rows(session_factory)) == 1
    assert "12345678" in smtp.messages[1].get_body(("plain",)).get_content()


def test_demo_resend_activates_an_administrator_who_was_only_invited(client, smtp, fake_auth, session_factory, monkeypatch):
    org = make_org(client)
    admin = add(client, org["id"]).json()  # created before demo mode: a normal pending invitation
    monkeypatch.setenv("DEMO_MODE", "true")
    expire(session_factory, admin["id"])
    response = resend(client, org["id"], admin["id"])
    assert response.status_code == 201 and response.json()["status"] == "active"
    assert fake_auth.users["ada@example.org"]["org"] == org["id"]
    assert "12345678" in smtp.messages[-1].get_body(("plain",)).get_content()


def test_demo_email_change_moves_the_account_and_tells_the_new_address(client, smtp, fake_auth, demo):
    org = make_org(client)
    admin = add(client, org["id"]).json()
    assert patch(client, org["id"], admin["id"], email="ada.new@example.org").status_code == 200
    assert list(fake_auth.users) == ["ada.new@example.org"]
    assert smtp.messages[-1]["To"] == "ada.new@example.org"
    assert "12345678" in smtp.messages[-1].get_body(("plain",)).get_content()


def test_normal_mode_never_emails_a_password(client, smtp, fake_auth):
    org = make_org(client)
    add(client, org["id"])
    text = smtp.messages[0].get_body(("plain",)).get_content()
    assert "12345678" not in text and "Password:" not in text and "/activate#token=" in text
    assert fake_auth.calls == []  # no account until the person activates it
