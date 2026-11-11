"""Locking and deleting an organization (the Super Admin's decisions about a customer that stops paying, or leaves the CRM).

The Auth Service and the other services' purge endpoints are stand-ins (a recording fake that can be told to fail); everything else is real: the database is built from the
migrations, the lock reaches the answer every service enforces, and the append-only record is the production trigger.

LOCK: the administrators can still reach their organization (Settings, Help & Support) but the tenant answer reports NO usable modules and `is_locked`; the Super Admin's note is
never sent to them; the stored entitlements are untouched so unlocking restores exactly what they had; idempotent; Super Admin only; the finance feed stops listing it.
DELETE: needs the exact name; locks first; asks every service in turn (accounts last); removes the logo file and the organization with its history; keeps only the append-only
record; a failing service stops the deletion with the organization still locked and marked, and a retry finishes it; it can never be unlocked while a deletion is pending.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.auth import get_auth_client
from app.main import app
from app.module_usage import get_usage_client
from app.purge_client import SERVICES, PurgeClient, PurgeFailed, get_purge_client
from app.storage import LocalLogoStorage, get_logo_storage

from conftest import fake_auth_client
from test_modules import FakeUsage, account, admin_for, apply, bearer, enabled, make_org, state

ORGS = "/api/v1/organizations"
TENANT_ORG = "/api/v1/tenant/organization"
TENANT_MODULES = "/api/v1/tenant/modules"
ORDER = [name for name, *_ in SERVICES]


class FakePurge:
    """Records which service was asked to delete what, and can be told that a service fails."""

    def __init__(self):
        self.calls = []
        self.fail = {}  # service -> message

    def purge(self, service, organization_id):
        self.calls.append((service, str(organization_id)))
        if service in self.fail:
            raise PurgeFailed(service, self.fail[service])
        return {f"{service}_rows": 3}


@pytest.fixture
def purge():
    return FakePurge()


@pytest.fixture
def store(tmp_path):
    return LocalLogoStorage(str(tmp_path / "logos"))


@pytest.fixture
def tokens():
    return {
        "super": (200, account("super-admin", None, full_name="Sam Super", email="sam@impex.example")),
        "regular": (200, account("user", None)),
    }


@pytest.fixture
def client(tokens, purge, store):
    auth = fake_auth_client(tokens)
    usage = FakeUsage()
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_usage_client] = lambda: usage
    app.dependency_overrides[get_purge_client] = lambda: purge
    app.dependency_overrides[get_logo_storage] = lambda: store
    with TestClient(app) as test_client:
        yield test_client
    for dependency in (get_auth_client, get_usage_client, get_purge_client, get_logo_storage):
        app.dependency_overrides.pop(dependency, None)


@pytest.fixture
def org(client, tokens):
    org_id = make_org(client)
    admin = admin_for(tokens, org_id)
    apply(client, org_id, {"purchasing": True, "sales": True})
    return {"id": org_id, "admin": admin}


def lock(client, org_id, reason=None, token="super"):
    return client.post(f"{ORGS}/{org_id}/lock", json={"reason": reason} if reason else {}, headers=bearer(token))


def unlock(client, org_id, token="super"):
    return client.post(f"{ORGS}/{org_id}/unlock", headers=bearer(token))


def delete(client, org_id, confirm, token="super"):
    return client.post(f"{ORGS}/{org_id}/delete", json={"confirm_name": confirm}, headers=bearer(token))


def tenant(client, who):
    response = client.get(TENANT_ORG, headers=bearer(who))
    assert response.status_code == 200, response.text
    return response.json()


def events(session_factory, org_id):
    with session_factory() as db:
        return [dict(r._mapping) for r in db.execute(text("SELECT action, reason, details, organization_name FROM organization_lifecycle_events WHERE organization_id = :o ORDER BY seq"), {"o": org_id})]


# ------------------------------------------------------------------------------------------------------------------ LOCK
class TestLock:
    def test_locking_cuts_every_module_but_keeps_the_organization_reachable(self, client, org):
        before = tenant(client, org["admin"])
        assert before["modules"] == ["inventory", "purchasing", "sales"] and before["is_locked"] is False
        response = lock(client, org["id"], "June payment is overdue")
        assert response.status_code == 200
        body = response.json()
        assert body["is_locked"] is True and body["locked_at"] and body["lock_reason"] == "June payment is overdue" and body["deletion_pending"] is False and body["is_active"] is True
        after = tenant(client, org["admin"])  # they can still sign in and reach their organization ...
        assert after["is_locked"] is True and after["modules"] == [] and after["is_active"] is True  # ... but have no module at all
        assert client.get(TENANT_MODULES, headers=bearer(org["admin"])).json()["modules"] == []

    def test_the_super_admins_note_is_never_sent_to_the_organization(self, client, org):
        lock(client, org["id"], "secret internal note about their payment")
        response = client.get(TENANT_ORG, headers=bearer(org["admin"]))
        assert "secret internal note" not in response.text and "lock_reason" not in response.json()

    def test_the_stored_entitlements_are_untouched_so_unlocking_restores_exactly_what_they_had(self, client, org):
        stored = enabled(state(client, org["id"]))
        lock(client, org["id"])
        assert enabled(state(client, org["id"])) == stored  # the Super Admin's own view of what they are entitled to is unchanged
        assert unlock(client, org["id"]).status_code == 200
        restored = tenant(client, org["admin"])
        assert restored["is_locked"] is False and restored["modules"] == ["inventory", "purchasing", "sales"]

    def test_settings_and_the_organization_itself_still_answer_while_locked(self, client, org, session_factory, tokens):
        tokens[org["admin"]] = (200, account("organization-admin", org["id"], email="admin@example.org", profile_setup_completed_at="2026-11-04T00:05:00+00:00"))
        with session_factory() as db:
            db.execute(text("UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id = :o"), {"o": org["id"]})
            db.commit()
        assert client.get("/api/v1/tenant/settings", headers=bearer(org["admin"])).status_code == 200
        lock(client, org["id"])
        assert client.get("/api/v1/tenant/settings", headers=bearer(org["admin"])).status_code == 200  # Settings
        assert client.get(TENANT_ORG, headers=bearer(org["admin"])).status_code == 200  # the answer Help & Support asks

    def test_a_module_change_while_locked_is_kept_for_the_unlock_but_changes_nothing_now(self, client, org):
        lock(client, org["id"])
        assert apply(client, org["id"], {"finance": True}).status_code == 200
        assert tenant(client, org["admin"])["modules"] == []
        unlock(client, org["id"])
        assert tenant(client, org["admin"])["modules"] == ["finance", "inventory", "purchasing", "sales"]

    def test_locking_twice_is_harmless_and_records_one_lock(self, client, org, session_factory):
        assert lock(client, org["id"], "first").status_code == 200
        again = lock(client, org["id"], "second note")
        assert again.status_code == 200 and again.json()["lock_reason"] == "second note"
        assert [e["action"] for e in events(session_factory, org["id"])] == ["locked"]

    def test_unlocking_an_unlocked_organization_is_harmless(self, client, org, session_factory):
        assert unlock(client, org["id"]).status_code == 200
        assert events(session_factory, org["id"]) == []
        lock(client, org["id"])
        unlock(client, org["id"])
        unlock(client, org["id"])
        assert [e["action"] for e in events(session_factory, org["id"])] == ["locked", "unlocked"]

    def test_only_a_super_admin_can_lock_or_unlock(self, client, org, tokens):
        assert lock(client, org["id"], token=org["admin"]).status_code == 403  # not even the organization's own administrator
        assert unlock(client, org["id"], token=org["admin"]).status_code == 403
        assert lock(client, org["id"], token="regular").status_code == 403
        assert client.post(f"{ORGS}/{org['id']}/lock", json={}).status_code == 401
        assert tenant(client, org["admin"])["is_locked"] is False

    def test_an_unknown_organization_is_a_404_and_a_slug_works(self, client, org):
        assert lock(client, uuid.uuid4()).status_code == 404
        assert lock(client, "alpha-trading").status_code == 200

    def test_the_note_is_limited_and_unknown_fields_are_refused(self, client, org):
        assert lock(client, org["id"], "x" * 501).status_code == 422
        assert client.post(f"{ORGS}/{org['id']}/lock", json={"is_locked": False}, headers=bearer("super")).status_code == 422

    def test_the_super_admins_list_and_detail_show_the_lock(self, client, org):
        lock(client, org["id"], "overdue")
        listed = {o["id"]: o for o in client.get(ORGS, headers=bearer("super")).json()}
        assert listed[org["id"]]["is_locked"] is True and listed[org["id"]]["lock_reason"] == "overdue"
        assert client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).json()["is_locked"] is True
        history = client.get(f"{ORGS}/{org['id']}/lifecycle", headers=bearer("super")).json()
        assert history[0]["action"] == "locked" and history[0]["actor_email"] == "sam@impex.example"

    def test_the_internal_entitlements_and_the_finance_feed_follow_the_lock(self, client, org, session_factory, monkeypatch):
        monkeypatch.setenv("MODULE_INTERNAL_API_KEY", "k")
        headers = {"X-Internal-Key": "k"}
        apply(client, org["id"], {"finance": True})
        with session_factory() as db:
            db.execute(text("UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id = :o"), {"o": org["id"]})
            db.commit()
        feed = "/internal/v1/modules/finance/organizations"
        assert [r["organization_id"] for r in client.get(feed, headers=headers).json()] == [org["id"]]
        lock(client, org["id"])
        assert client.get(feed, headers=headers).json() == []  # the Finance worker stops synchronising a locked organization
        body = client.get(f"/internal/v1/organizations/{org['id']}/entitlements", headers=headers).json()
        assert body["is_locked"] is True and body["modules"] == [] and body["is_active"] is True
        unlock(client, org["id"])
        assert [r["organization_id"] for r in client.get(feed, headers=headers).json()] == [org["id"]]


# ------------------------------------------------------------------------------------------------------------------ DELETE
class TestDelete:
    def test_it_needs_the_exact_name_and_changes_nothing_otherwise(self, client, org, purge, session_factory):
        for wrong in ("alpha trading", "Alpha", "", " Beta Trading ", "Alpha Trading 2"):
            response = delete(client, org["id"], wrong)
            assert response.status_code == 422 and response.json()["detail"]["code"] == "confirmation_mismatch"
        assert purge.calls == []  # no service was asked to delete anything
        assert tenant(client, org["admin"])["is_locked"] is False  # and it was not even locked
        assert events(session_factory, org["id"]) == []

    def test_it_deletes_everything_everywhere_and_keeps_only_the_record(self, client, org, purge, store, session_factory):
        with session_factory() as db:
            key = store.new_key()
            store.write(key, b"\x89PNG fake logo")
            db.execute(text("UPDATE organizations SET logo_storage_key = :k, logo_content_type = 'image/png' WHERE id = :o"), {"k": key, "o": org["id"]})
            db.commit()
        client.post("/api/v1/organizations/%s/invitations" % org["id"], json={"email": "boss@alpha.example"}, headers=bearer("super"))
        response = delete(client, org["id"], "Alpha Trading")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["deleted"] is True and body["name"] == "Alpha Trading" and body["organization_id"] == org["id"]
        assert list(body["purged"]) == ORDER and body["purged"]["sales"] == {"sales_rows": 3}
        assert [c[0] for c in purge.calls] == ORDER and {c[1] for c in purge.calls} == {org["id"]}  # every service, the accounts last
        assert client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).status_code == 404
        assert client.get(TENANT_ORG, headers=bearer(org["admin"])).status_code == 403  # nothing is left for the administrator to reach
        assert store.read(key) is None  # the logo file is gone
        with session_factory() as db:
            for table in ("organizations", "organization_modules", "organization_module_history", "organization_settings_history", "organization_invitations"):
                column = "id" if table == "organizations" else "organization_id"
                assert db.execute(text(f"SELECT count(*) FROM {table} WHERE {column} = :o"), {"o": org["id"]}).scalar() == 0, table
        record = events(session_factory, org["id"])
        assert [e["action"] for e in record] == ["deletion_started", "deleted"]
        assert record[-1]["organization_name"] == "Alpha Trading" and record[-1]["details"] == {"purged": {n: 3 for n in ORDER}}  # counts only: no business data

    def test_the_record_cannot_be_edited_or_removed_by_the_application(self, client, org, session_factory):
        delete(client, org["id"], "Alpha Trading")
        with session_factory() as db:
            with pytest.raises(Exception, match="append-only"):
                db.execute(text("UPDATE organization_lifecycle_events SET action = 'locked' WHERE organization_id = :o"), {"o": org["id"]})
            db.rollback()
            with pytest.raises(Exception, match="append-only"):
                db.execute(text("DELETE FROM organization_lifecycle_events WHERE organization_id = :o"), {"o": org["id"]})

    def test_it_locks_first_so_nobody_can_use_the_organization_while_it_is_removed(self, client, org, purge):
        seen = []
        original = purge.purge

        def watching(service, organization_id):
            seen.append(client.get(TENANT_ORG, headers=bearer(org["admin"])).json()["modules"])
            return original(service, organization_id)

        purge.purge = watching
        assert delete(client, org["id"], "Alpha Trading").status_code == 200
        assert seen and all(modules == [] for modules in seen)  # locked before the first service was asked

    def test_a_service_that_fails_stops_the_deletion_and_leaves_the_organization_locked_and_marked(self, client, org, purge, session_factory):
        purge.fail["sales"] = "the service could not be reached"
        response = delete(client, org["id"], "Alpha Trading")
        assert response.status_code == 502
        detail = response.json()["detail"]
        assert detail["code"] == "deletion_failed" and detail["service"] == "sales" and detail["completed"] == ["finance"] and "run the deletion again" in detail["message"]
        assert [c[0] for c in purge.calls] == ["finance", "sales"]  # nothing after the failure was touched
        listed = client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).json()
        assert listed["is_locked"] is True and listed["deletion_pending"] is True  # still there, locked, and marked for a retry
        assert tenant(client, org["admin"])["modules"] == []
        failed = [e for e in events(session_factory, org["id"]) if e["action"] == "deletion_failed"]
        assert len(failed) == 1 and failed[0]["details"]["service"] == "sales"

    def test_a_retry_finishes_the_job(self, client, org, purge):
        purge.fail["purchasing"] = "boom"
        assert delete(client, org["id"], "Alpha Trading").status_code == 502
        purge.fail.clear()
        purge.calls.clear()
        response = delete(client, org["id"], "Alpha Trading")
        assert response.status_code == 200 and list(response.json()["purged"]) == ORDER
        assert [c[0] for c in purge.calls] == ORDER  # every service is asked again: each purge is idempotent
        assert client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).status_code == 404

    def test_an_organization_being_deleted_cannot_be_unlocked(self, client, org, purge):
        purge.fail["inventory"] = "boom"
        delete(client, org["id"], "Alpha Trading")
        response = unlock(client, org["id"])
        assert response.status_code == 409 and response.json()["detail"]["code"] == "deletion_pending"
        assert client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).json()["is_locked"] is True

    def test_a_deletion_that_failed_at_the_accounts_still_has_everything_else_removed_and_can_be_finished(self, client, org, purge):
        purge.fail["auth"] = "down"
        assert delete(client, org["id"], "Alpha Trading").status_code == 502
        assert [c[0] for c in purge.calls] == ORDER  # the accounts are asked last
        assert client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).status_code == 200  # the organization record stays until everything else is gone
        purge.fail.clear()
        assert delete(client, org["id"], "Alpha Trading").status_code == 200

    def test_a_locked_organization_can_be_deleted(self, client, org, purge):
        lock(client, org["id"], "left the CRM")
        assert delete(client, org["id"], "Alpha Trading").status_code == 200

    def test_only_a_super_admin_can_delete(self, client, org, purge):
        assert delete(client, org["id"], "Alpha Trading", token=org["admin"]).status_code == 403  # not even their own administrator
        assert delete(client, org["id"], "Alpha Trading", token="regular").status_code == 403
        assert client.post(f"{ORGS}/{org['id']}/delete", json={"confirm_name": "Alpha Trading"}).status_code == 401
        assert purge.calls == [] and client.get(f"{ORGS}/{org['id']}", headers=bearer("super")).status_code == 200

    def test_unknown_organizations_and_unknown_fields(self, client, org, purge):
        assert delete(client, uuid.uuid4(), "x").status_code == 404
        assert client.post(f"{ORGS}/{org['id']}/delete", json={"confirm_name": "Alpha Trading", "force": True}, headers=bearer("super")).status_code == 422
        assert purge.calls == []

    def test_another_organization_is_never_touched(self, client, org, purge, tokens):
        other = make_org(client, name="Beta Logistics", slug="beta-logistics")
        delete(client, org["id"], "Alpha Trading")
        assert client.get(f"{ORGS}/{other}", headers=bearer("super")).status_code == 200
        assert {c[1] for c in purge.calls} == {org["id"]}


class TestPurgeClient:
    def test_it_asks_every_service_with_its_own_key_and_reads_the_counts(self, monkeypatch):
        import httpx

        seen = []

        def fake_post(url, headers=None, timeout=None):
            seen.append((url, headers["X-Internal-Key"]))
            return httpx.Response(200, json={"deleted": {"rows": 2}}, request=httpx.Request("POST", url))

        monkeypatch.setattr("app.purge_client.httpx.post", fake_post)
        monkeypatch.setenv("PURGE_API_KEY", "purge-key")
        monkeypatch.setenv("AUTH_INTERNAL_API_KEY", "auth-key")
        org = uuid.uuid4()
        client = PurgeClient()
        assert [client.purge(name, org) for name, *_ in SERVICES] == [{"rows": 2}] * len(SERVICES)
        assert [u.rsplit("/purge", 1)[0].rsplit("/organizations/", 1)[0] for u, _ in seen] == ["http://finance-service:8006/internal/v1", "http://sales-service:8003/internal/v1", "http://purchasing-service:8004/internal/v1", "http://inventory-service:8002/internal/v1", "http://support-service:8005/internal/v1", "http://auth-service:8000/internal"]
        assert [k for _, k in seen] == ["purge-key"] * 5 + ["auth-key"]

    def test_anything_but_a_clear_200_is_a_failure(self, monkeypatch):
        import httpx

        monkeypatch.setenv("PURGE_API_KEY", "purge-key")
        for response in (httpx.Response(500, json={}), httpx.Response(401, json={}), httpx.Response(200, json={"unexpected": 1}), httpx.Response(200, content=b"not json")):
            monkeypatch.setattr("app.purge_client.httpx.post", lambda url, headers=None, timeout=None, r=response: r)
            with pytest.raises(PurgeFailed):
                PurgeClient().purge("sales", uuid.uuid4())

        def unreachable(url, headers=None, timeout=None):
            raise httpx.ConnectError("refused")

        monkeypatch.setattr("app.purge_client.httpx.post", unreachable)
        with pytest.raises(PurgeFailed, match="could not be reached"):
            PurgeClient().purge("sales", uuid.uuid4())

    def test_without_a_key_nothing_is_sent(self, monkeypatch):
        monkeypatch.delenv("PURGE_API_KEY", raising=False)
        with pytest.raises(PurgeFailed, match="no service key"):
            PurgeClient().purge("sales", uuid.uuid4())
