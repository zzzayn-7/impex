"""Module management (Step 19): which business modules each organization may use.

The Auth Service and the Purchasing/Sales services are stand-ins. Everything else is real: the database is built from the migrations,
and the history trigger, the row lock and the dependency rules are the production ones.
"""
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from app.auth import get_auth_client
from app.database import get_database_url
from app.main import app
from app.module_usage import get_usage_client, modules_to_ask
from app.models import Organization, OrganizationModule
from app.modules import PERMANENT, REGISTRY, default_enabled, effective, validate_target

from conftest import alembic_config, fake_auth_client, targeting_test_database

ORGS = "/api/v1/organizations"
TENANT_ORG = "/api/v1/tenant/organization"
TENANT_MODULES = "/api/v1/tenant/modules"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def account(role, organization_id, **overrides):
    return {
        "id": str(uuid.uuid4()), "email": f"{role}@example.org", "full_name": f"Test {role}", "role": role,
        "organization_id": organization_id, "is_active": True, "created_at": "2026-11-04T00:00:00+00:00", **overrides,
    }


class FakeUsage:
    """Stands in for the Purchasing and Sales services' module-usage answers."""

    def __init__(self):
        self.answers = {}  # module -> a dict, or None (the service cannot be asked)
        self.asked = []

    def fetch(self, module, organization_id):
        self.asked.append((module, str(organization_id)))
        if module in self.answers:
            return self.answers[module]
        return {"module": module, "blocking": [], "warnings": []}


@pytest.fixture
def usage():
    return FakeUsage()


@pytest.fixture
def tokens():
    return {
        "super": (200, account("super-admin", None, full_name="Sam Super", email="sam@impex.example")),
        "expired": (401, {"detail": "Invalid or expired token"}),
        "regular": (200, account("user", None)),
    }


@pytest.fixture
def client(tokens, usage):
    auth = fake_auth_client(tokens)
    app.dependency_overrides[get_auth_client] = lambda: auth
    app.dependency_overrides[get_usage_client] = lambda: usage
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_auth_client, None)
    app.dependency_overrides.pop(get_usage_client, None)


def make_org(client, name="Alpha Trading", slug="alpha-trading"):
    """Created through the real API, as the Super Admin does: this is what seeds the defaults."""
    response = client.post(ORGS, json={"name": name, "slug": slug, "country_code": "DE", "contact_email": f"ops@{slug}.example"}, headers=bearer("super"))
    assert response.status_code == 201, response.text
    return response.json()["id"]


def admin_for(tokens, org_id, name="admin"):
    tokens[name] = (200, account("organization-admin", org_id, email=f"{name}@example.org"))
    return name


def state(client, org_id):
    response = client.get(f"{ORGS}/{org_id}/modules", headers=bearer("super"))
    assert response.status_code == 200, response.text
    return response.json()


def enabled(data):
    return {m["key"]: m["enabled"] for m in data["modules"]}


def apply(client, org_id, changes, revision=None, reason=None, token="super"):
    if revision is None:
        revision = state(client, org_id)["revision"]
    body = {"changes": changes, "expected_revision": revision, **({"reason": reason} if reason else {})}
    return client.put(f"{ORGS}/{org_id}/modules", json=body, headers=bearer(token))


# ----------------------------------------------------------------------------------------------------- the registry
class TestRegistry:
    def test_the_four_modules_and_their_features(self):
        assert list(REGISTRY) == ["inventory", "purchasing", "sales", "finance"]
        assert REGISTRY["inventory"].features == ("Products", "Warehouses", "Stock", "Scanning", "Movements")
        assert REGISTRY["purchasing"].features == ("Suppliers", "Purchase Orders", "Goods Receipts")
        assert REGISTRY["sales"].features == ("Clients", "Delivery Lists", "Dispatches", "Invoices and Payments")
        assert REGISTRY["finance"].available is True and REGISTRY["finance"].requires == () and REGISTRY["finance"].default_for_new is False

    def test_permanent_capabilities_are_not_modules(self):
        assert [key for key, _n, _d in PERMANENT] == ["authentication", "organization", "onboarding", "support"]
        assert not set(REGISTRY) & {key for key, _n, _d in PERMANENT}

    def test_a_new_organization_gets_inventory_only(self):
        assert default_enabled() == {"inventory": True, "purchasing": False, "sales": False, "finance": False}

    def test_effective_needs_the_requirements(self):
        assert effective({"inventory": True, "purchasing": True, "sales": True, "finance": True}) == {"inventory", "purchasing", "sales", "finance"}
        assert effective({"finance": True}) == {"finance"}  # Finance needs no other module
        assert effective({"inventory": False, "purchasing": True, "sales": True}) == set()  # enabled by hand without Inventory: unusable
        assert effective({"inventory": True, "sales": True}) == {"inventory", "sales"}
        assert effective({}) == set()

    def test_dependency_rules(self):
        current = {"inventory": True, "purchasing": False, "sales": False, "finance": False}
        assert validate_target(current, {"sales": True})[1] == []
        _target, blockers = validate_target({**current, "inventory": False}, {"sales": True})
        assert [b.code for b in blockers] == ["requires"]
        _target, blockers = validate_target({**current, "sales": True}, {"inventory": False})
        assert [b.code for b in blockers] == ["required_by"]
        assert validate_target({**current, "sales": True, "purchasing": True}, {"inventory": False, "sales": False, "purchasing": False})[1] == []
        assert validate_target(current, {"finance": True})[1] == []
        assert validate_target({**current, "finance": True}, {"finance": False})[1] == []  # nothing depends on Finance

    def test_which_services_are_asked_before_switching_things_off(self):
        assert modules_to_ask(["sales"]) == ["sales"]
        assert modules_to_ask(["purchasing"]) == ["purchasing"]
        assert modules_to_ask(["inventory"]) == ["purchasing", "sales"]
        assert modules_to_ask(["finance"]) == []


# ----------------------------------------------------------------------------------------------------- defaults
class TestDefaults:
    def test_a_new_organization_has_inventory_enabled_and_the_rest_disabled(self, client, tokens):
        org = make_org(client)
        data = state(client, org)
        assert enabled(data) == {"inventory": True, "purchasing": False, "sales": False, "finance": False}
        assert [m["key"] for m in data["modules"] if m["effective"]] == ["inventory"]
        assert [p["key"] for p in data["permanent"]] == ["authentication", "organization", "onboarding", "support"]
        finance = next(m for m in data["modules"] if m["key"] == "finance")
        assert finance["available"] is True and finance["enabled"] is False and finance["effective"] is False  # available to enable, off by default

    def test_the_defaults_are_recorded_in_the_history(self, client):
        org = make_org(client)
        history = client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()
        assert history["total"] == 4
        assert {h["action"] for h in history["items"]} == {"seeded"}
        assert all(h["changed_by_name"] == "System" for h in history["items"])

    def test_the_organizations_own_answer_lists_its_modules(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        answer = client.get(TENANT_ORG, headers=bearer(who)).json()
        assert answer["modules"] == ["inventory"]
        assert client.get(TENANT_MODULES, headers=bearer(who)).json() == {"modules": ["inventory"]}

    def test_an_organization_with_no_recorded_rows_gets_the_defaults(self, client, tokens, session_factory):
        with session_factory() as db:  # created behind the API's back (no seed rows)
            organization = Organization(name="Rowless", slug="rowless", country_code="DE", contact_email="x@y.example")
            db.add(organization)
            db.commit()
            org = str(organization.id)
        who = admin_for(tokens, org)
        assert client.get(TENANT_MODULES, headers=bearer(who)).json() == {"modules": ["inventory"]}


# ----------------------------------------------------------------------------------------------------- enabling and disabling
class TestChanging:
    def test_enable_and_disable_optional_modules(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        response = apply(client, org, {"purchasing": True, "sales": True}, reason="Contract signed")
        assert response.status_code == 200, response.text
        assert enabled(response.json()) == {"inventory": True, "purchasing": True, "sales": True, "finance": False}
        assert client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"] == ["inventory", "purchasing", "sales"]
        response = apply(client, org, {"sales": False})
        assert enabled(response.json())["sales"] is False
        assert client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"] == ["inventory", "purchasing"]
        assert client.get(TENANT_ORG, headers=bearer(who)).json()["modules"] == ["inventory", "purchasing"]

    def test_the_change_is_recorded_with_who_when_and_why(self, client):
        org = make_org(client)
        apply(client, org, {"purchasing": True, "sales": True}, reason="Contract signed")
        history = client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()["items"]
        newest = [h for h in history if h["action"] == "enabled"]
        assert {h["module"] for h in newest} == {"purchasing", "sales"}
        for h in newest:
            assert h["changed_by_name"] == "Sam Super" and h["changed_by_email"] == "sam@impex.example" and h["reason"] == "Contract signed"
            assert h["old_enabled"] is False and h["new_enabled"] is True and h["created_at"]
        assert len({h["batch_id"] for h in newest}) == 1  # confirmed together
        data = state(client, org)
        assert next(m for m in data["modules"] if m["key"] == "sales")["updated_by_name"] == "Sam Super"

    def test_history_is_newest_first_and_paged(self, client):
        org = make_org(client)
        apply(client, org, {"sales": True})
        apply(client, org, {"sales": False})
        page = client.get(f"{ORGS}/{org}/modules/history?limit=2", headers=bearer("super")).json()
        assert page["total"] == 6 and [h["action"] for h in page["items"]] == ["disabled", "enabled"]
        rest = client.get(f"{ORGS}/{org}/modules/history?limit=10&offset=2", headers=bearer("super")).json()
        assert len(rest["items"]) == 4

    def test_a_change_that_changes_nothing_is_not_recorded(self, client):
        org = make_org(client)
        before = state(client, org)["revision"]
        response = apply(client, org, {"inventory": True, "sales": False})
        assert response.status_code == 200 and response.json()["revision"] == before
        preview = client.post(f"{ORGS}/{org}/modules/preview", json={"changes": {"inventory": True}}, headers=bearer("super")).json()
        assert preview["changes"] == [] and preview["can_apply"] is False

    def test_disabling_keeps_the_row_and_enabling_again_restores_access(self, client, tokens, session_factory):
        org = make_org(client)
        who = admin_for(tokens, org)
        apply(client, org, {"sales": True})
        apply(client, org, {"sales": False})
        with session_factory() as db:
            row = db.get(OrganizationModule, (uuid.UUID(org), "sales"))
            assert row is not None and row.enabled is False  # kept, not deleted
        assert "sales" not in client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"]
        apply(client, org, {"sales": True})
        assert "sales" in client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"]

    def test_the_change_is_confirmed_as_one_unit_or_not_at_all(self, client):
        org = make_org(client)
        before = state(client, org)
        response = apply(client, org, {"sales": True, "inventory": False})  # the second part is not allowed (Sales needs Inventory)
        assert response.status_code == 409 and response.json()["detail"]["code"] == "blocked"
        after = state(client, org)
        assert enabled(after) == enabled(before) and after["revision"] == before["revision"]


# ----------------------------------------------------------------------------------------------------- dependencies
class TestDependencies:
    def test_inventory_cannot_be_disabled_while_a_dependent_module_is_enabled(self, client):
        org = make_org(client)
        apply(client, org, {"sales": True})
        response = apply(client, org, {"inventory": False})
        assert response.status_code == 409
        blocker = response.json()["detail"]["blockers"][0]
        assert blocker["code"] == "required_by" and blocker["module"] == "inventory" and "Sales" in blocker["message"]
        assert enabled(state(client, org))["inventory"] is True

    def test_inventory_can_go_when_the_dependents_go_in_the_same_change(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        apply(client, org, {"sales": True, "purchasing": True})
        response = apply(client, org, {"inventory": False, "sales": False, "purchasing": False})
        assert response.status_code == 200, response.text
        assert client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"] == []

    def test_purchasing_and_sales_need_inventory(self, client):
        org = make_org(client)
        apply(client, org, {"inventory": False})
        for module in ("purchasing", "sales"):
            response = apply(client, org, {module: True})
            assert response.status_code == 409 and response.json()["detail"]["blockers"][0]["code"] == "requires"
        assert apply(client, org, {"inventory": True, "sales": True}).status_code == 200  # together is fine

    def test_finance_is_enabled_only_by_the_super_admin_and_is_off_by_default(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        assert enabled(state(client, org))["finance"] is False
        assert "finance" not in client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"]
        assert apply(client, org, {"finance": True}, token=who).status_code == 403  # an organization administrator cannot
        response = apply(client, org, {"finance": True}, reason="Finance Service is ready")
        assert response.status_code == 200 and enabled(response.json())["finance"] is True
        assert client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"] == ["finance", "inventory"]
        assert client.get(TENANT_ORG, headers=bearer(who)).json()["modules"] == ["finance", "inventory"]
        history = client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()["items"]
        assert any(h["module"] == "finance" and h["action"] == "enabled" and h["changed_by_name"] == "Sam Super" for h in history)
        assert apply(client, org, {"finance": False}).status_code == 200  # and switched off again; nothing else depends on it

    def test_permanent_capabilities_and_unknown_modules_cannot_be_touched(self, client):
        org = make_org(client)
        for key in ("support", "authentication", "onboarding", "organization", "banana"):
            response = apply(client, org, {key: False})
            assert response.status_code == 422 and response.json()["detail"]["code"] == "unknown_module", key
            preview = client.post(f"{ORGS}/{org}/modules/preview", json={"changes": {key: False}}, headers=bearer("super"))
            assert preview.status_code == 422
        assert client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()["total"] == 4  # nothing recorded

    def test_bad_requests_are_refused(self, client):
        org = make_org(client)
        for body in ({}, {"changes": {}}, {"changes": {"sales": "yes"}, "expected_revision": 0}, {"changes": {"sales": True}}, {"changes": {"sales": True}, "expected_revision": -1},
                     {"changes": {"sales": True}, "expected_revision": 0, "organization_id": "x"}, {"changes": {"sales": True}, "expected_revision": 0, "reason": "x" * 501}):
            assert client.put(f"{ORGS}/{org}/modules", json=body, headers=bearer("super")).status_code == 422, body
        assert client.get(f"{ORGS}/{uuid.uuid4()}/modules", headers=bearer("super")).status_code == 404


# ----------------------------------------------------------------------------------------------------- review and safe deactivation
class TestReviewAndPendingOperations:
    def test_preview_changes_nothing_and_shows_the_result(self, client):
        org = make_org(client)
        before = state(client, org)
        preview = client.post(f"{ORGS}/{org}/modules/preview", json={"changes": {"sales": True, "purchasing": True}}, headers=bearer("super")).json()
        assert preview["can_apply"] is True and preview["blockers"] == []
        assert [(c["module"], c["from_enabled"], c["to_enabled"]) for c in preview["changes"]] == [("sales", False, True), ("purchasing", False, True)]
        assert preview["revision"] == before["revision"]
        assert state(client, org) == before

    def test_operations_in_progress_block_switching_a_module_off(self, client, usage):
        org = make_org(client)
        apply(client, org, {"sales": True, "purchasing": True})
        usage.answers["sales"] = {"module": "sales", "blocking": [{"code": "dispatches_posting", "label": "Dispatches being posted to stock", "count": 2}], "warnings": []}
        response = apply(client, org, {"sales": False})
        assert response.status_code == 409
        blocker = response.json()["detail"]["blockers"][0]
        assert blocker["code"] == "pending_operations" and blocker["counts"] == [{"code": "dispatches_posting", "label": "Dispatches being posted to stock", "count": 2}]
        assert enabled(state(client, org))["sales"] is True  # nothing stranded
        usage.answers["sales"] = {"module": "sales", "blocking": [{"code": "dispatches_posting", "label": "x", "count": 0}], "warnings": []}
        assert apply(client, org, {"sales": False}).status_code == 200  # nothing pending any more

    def test_a_service_that_cannot_be_asked_blocks_it_too(self, client, usage):
        org = make_org(client)
        apply(client, org, {"purchasing": True})
        usage.answers["purchasing"] = None
        response = apply(client, org, {"purchasing": False})
        assert response.status_code == 409 and response.json()["detail"]["blockers"][0]["code"] == "usage_unavailable"
        assert enabled(state(client, org))["purchasing"] is True

    def test_open_records_are_warnings_not_blockers(self, client, usage):
        org = make_org(client)
        apply(client, org, {"sales": True})
        usage.answers["sales"] = {"module": "sales", "blocking": [], "warnings": [{"code": "invoices_open", "label": "Invoices not fully paid", "count": 3}, {"code": "x", "label": "none", "count": 0}]}
        preview = client.post(f"{ORGS}/{org}/modules/preview", json={"changes": {"sales": False}}, headers=bearer("super")).json()
        assert preview["can_apply"] is True
        assert preview["warnings"] == [{"module": "sales", "code": "invoices_open", "label": "Invoices not fully paid", "count": 3}]
        assert apply(client, org, {"sales": False}).status_code == 200

    def test_enabling_never_asks_the_services(self, client, usage):
        org = make_org(client)
        apply(client, org, {"sales": True})
        assert usage.asked == []

    def test_switching_inventory_off_also_looks_at_purchasing_and_sales(self, client, usage):
        org = make_org(client)
        apply(client, org, {"sales": True})
        apply(client, org, {"sales": False})  # sales is off, but ...
        usage.asked.clear()
        usage.answers["sales"] = {"module": "sales", "blocking": [{"code": "dispatches_posting", "label": "Dispatches being posted to stock", "count": 1}], "warnings": []}
        response = apply(client, org, {"inventory": False})  # ... a dispatch is still posting through Inventory
        assert response.status_code == 409 and response.json()["detail"]["blockers"][0]["code"] == "pending_operations"
        assert {m for m, _o in usage.asked} == {"purchasing", "sales"}
        assert all(o == org for _m, o in usage.asked)  # only this organization is ever asked about


# ----------------------------------------------------------------------------------------------------- concurrency
class TestConcurrentChanges:
    def test_a_review_that_is_out_of_date_is_refused(self, client):
        org = make_org(client)
        reviewed = state(client, org)["revision"]
        assert apply(client, org, {"purchasing": True}, revision=reviewed).status_code == 200
        stale = apply(client, org, {"sales": True}, revision=reviewed)
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
        assert enabled(state(client, org))["sales"] is False

    def test_two_super_admins_confirming_the_same_review_at_once_only_one_wins(self, tokens, usage, session_factory):
        auth = fake_auth_client(tokens)
        app.dependency_overrides[get_auth_client] = lambda: auth
        app.dependency_overrides[get_usage_client] = lambda: usage
        try:
            with TestClient(app) as test_client:
                org = make_org(test_client)
                revision = state(test_client, org)["revision"]
                barrier = threading.Barrier(2)

                def confirm(changes):
                    barrier.wait()
                    return apply(test_client, org, changes, revision=revision).status_code

                with ThreadPoolExecutor(max_workers=2) as pool:
                    outcomes = list(pool.map(confirm, [{"purchasing": True}, {"sales": True}]))
                assert sorted(outcomes) == [200, 409]
                final = enabled(state(test_client, org))
                assert [final["purchasing"], final["sales"]].count(True) == 1  # exactly one of the two was applied
                history = test_client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()
                assert len([h for h in history["items"] if h["action"] == "enabled"]) == 1
        finally:
            app.dependency_overrides.pop(get_auth_client, None)
            app.dependency_overrides.pop(get_usage_client, None)

    def test_many_identical_confirmations_record_one_change(self, tokens, usage):
        auth = fake_auth_client(tokens)
        app.dependency_overrides[get_auth_client] = lambda: auth
        app.dependency_overrides[get_usage_client] = lambda: usage
        try:
            with TestClient(app) as test_client:
                org = make_org(test_client)
                revision = state(test_client, org)["revision"]
                barrier = threading.Barrier(6)

                def confirm(_):
                    barrier.wait()
                    return apply(test_client, org, {"sales": True}, revision=revision).status_code

                with ThreadPoolExecutor(max_workers=6) as pool:
                    outcomes = list(pool.map(confirm, range(6)))
                # the winner applies it; a request that arrives after it has nothing left to change (200, nothing recorded) or is stale (409)
                assert set(outcomes) <= {200, 409} and outcomes.count(200) >= 1
                history = test_client.get(f"{ORGS}/{org}/modules/history", headers=bearer("super")).json()
                assert len([h for h in history["items"] if h["module"] == "sales" and h["action"] == "enabled"]) == 1
        finally:
            app.dependency_overrides.pop(get_auth_client, None)
            app.dependency_overrides.pop(get_usage_client, None)


# ----------------------------------------------------------------------------------------------------- the history cannot be rewritten
class TestHistoryIsAppendOnly:
    def test_update_and_delete_are_refused_by_the_database(self, client, session_factory):
        org = make_org(client)
        apply(client, org, {"sales": True})
        with session_factory() as db:
            for sql in ("UPDATE organization_module_history SET new_enabled = NOT new_enabled", "DELETE FROM organization_module_history", "UPDATE organization_module_history SET changed_by_name = 'x'"):
                with pytest.raises(DBAPIError) as caught:
                    db.execute(text(sql))
                assert "append-only" in str(caught.value)
                db.rollback()
            count = db.execute(text("SELECT count(*) FROM organization_module_history WHERE organization_id = :o"), {"o": org}).scalar()
            assert count == 5

    def test_the_maintenance_switch_lets_a_throwaway_organization_be_removed(self, client, session_factory):
        org = make_org(client)
        with session_factory() as db:
            db.execute(text("BEGIN"))
            db.execute(text("SET LOCAL app.allow_ledger_maintenance = 'on'"))
            db.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org})
            db.commit()
            assert db.execute(text("SELECT count(*) FROM organization_module_history WHERE organization_id = :o"), {"o": org}).scalar() == 0
            assert db.execute(text("SELECT count(*) FROM organization_modules WHERE organization_id = :o"), {"o": org}).scalar() == 0


# ----------------------------------------------------------------------------------------------------- who may do what
class TestAuthorization:
    def test_only_a_super_admin_manages_modules(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        for token in (who, "regular"):
            assert client.get(f"{ORGS}/{org}/modules", headers=bearer(token)).status_code == 403
            assert client.get(f"{ORGS}/{org}/modules/history", headers=bearer(token)).status_code == 403
            assert client.post(f"{ORGS}/{org}/modules/preview", json={"changes": {"sales": True}}, headers=bearer(token)).status_code == 403
            assert apply(client, org, {"sales": True}, revision=0, token=token).status_code == 403
        for token in ("expired", "nobody"):
            assert client.get(f"{ORGS}/{org}/modules", headers=bearer(token)).status_code == 401
            assert apply(client, org, {"sales": True}, revision=0, token=token).status_code == 401
        assert client.get(f"{ORGS}/{org}/modules").status_code == 401
        assert client.put(f"{ORGS}/{org}/modules", json={"changes": {"sales": True}, "expected_revision": 0}).status_code == 401
        assert enabled(state(client, org))["sales"] is False

    def test_an_inactive_super_admin_is_refused(self, client, tokens):
        org = make_org(client)
        tokens["gone"] = (200, account("super-admin", None, is_active=False))
        assert client.get(f"{ORGS}/{org}/modules", headers=bearer("gone")).status_code == 403
        assert apply(client, org, {"sales": True}, revision=0, token="gone").status_code == 403

    def test_a_super_admin_has_no_tenant_view(self, client):
        assert client.get(TENANT_MODULES, headers=bearer("super")).status_code == 403
        assert client.get(TENANT_ORG, headers=bearer("super")).status_code == 403

    def test_an_organization_administrator_cannot_change_their_own_modules(self, client, tokens):
        org = make_org(client)
        who = admin_for(tokens, org)
        for method in ("put", "post", "patch"):
            response = getattr(client, method)(TENANT_MODULES, headers=bearer(who), json={"modules": ["sales"]})
            assert response.status_code in (404, 405)
        assert client.delete(TENANT_MODULES, headers=bearer(who)).status_code in (404, 405)
        assert client.get(TENANT_MODULES, headers=bearer(who)).json()["modules"] == ["inventory"]


# ----------------------------------------------------------------------------------------------------- tenants stay apart
class TestIsolation:
    def test_each_organization_has_its_own_modules(self, client, tokens):
        alpha, beta = make_org(client, "Alpha", "alpha"), make_org(client, "Beta", "beta")
        a, b = admin_for(tokens, alpha, "admin-alpha"), admin_for(tokens, beta, "admin-beta")
        apply(client, alpha, {"sales": True})
        assert client.get(TENANT_MODULES, headers=bearer(a)).json()["modules"] == ["inventory", "sales"]
        assert client.get(TENANT_MODULES, headers=bearer(b)).json()["modules"] == ["inventory"]
        apply(client, beta, {"purchasing": True})
        assert client.get(TENANT_MODULES, headers=bearer(a)).json()["modules"] == ["inventory", "sales"]
        assert enabled(state(client, alpha))["purchasing"] is False

    def test_no_request_input_can_name_another_organization(self, client, tokens):
        alpha, beta = make_org(client, "Alpha", "alpha"), make_org(client, "Beta", "beta")
        a = admin_for(tokens, alpha, "admin-alpha")
        apply(client, beta, {"sales": True})
        for url in (f"{TENANT_MODULES}?organization_id={beta}", f"{TENANT_ORG}?organization_id={beta}"):
            body = client.get(url, headers={**bearer(a), "X-Organization-Id": beta}).json()
            assert body["modules"] == ["inventory"]
        assert body["id"] == alpha

    def test_an_inactive_organization_has_no_tenant_view(self, client, tokens, session_factory):
        org = make_org(client)
        who = admin_for(tokens, org)
        with session_factory() as db:
            db.execute(text("UPDATE organizations SET is_active = false WHERE id = :o"), {"o": org})
            db.commit()
        assert client.get(TENANT_MODULES, headers=bearer(who)).status_code == 403
        assert client.get(TENANT_ORG, headers=bearer(who)).status_code == 403
        assert client.get(f"{ORGS}/{org}/modules", headers=bearer("super")).status_code == 200  # the Super Admin can still manage it


# ----------------------------------------------------------------------------------------------------- the migration
class TestMigrationOfExistingOrganizations:
    NAME = "impex_organizations_modules_migration_test"

    def test_existing_organizations_keep_everything_they_could_use(self):
        admin = create_engine(get_database_url().set(database="postgres"), isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {self.NAME} WITH (FORCE)"))
            conn.execute(text(f"CREATE DATABASE {self.NAME}"))
        try:
            import os

            previous = os.environ.get("DB_NAME")
            os.environ["DB_NAME"] = self.NAME
            try:
                command.upgrade(alembic_config(), "0004")  # the schema as it was before this release
                engine = create_engine(get_database_url().set(database=self.NAME))
                with engine.begin() as conn:
                    for slug in ("old-one", "old-two"):
                        conn.execute(text("INSERT INTO organizations (name, slug, country_code, contact_email) VALUES (:n, :s, 'DE', 'x@y.example')"), {"n": slug, "s": slug})
                    conn.execute(text("UPDATE organizations SET is_active = false WHERE slug = 'old-two'"))  # inactive ones are migrated too
                command.upgrade(alembic_config(), "head")
                with engine.connect() as conn:
                    rows = conn.execute(text("SELECT o.slug, m.module_key, m.enabled, m.updated_by FROM organizations o JOIN organization_modules m ON m.organization_id = o.id ORDER BY 1, 2")).all()
                    by_org = {}
                    for slug, key, on, by in rows:
                        by_org.setdefault(slug, {})[key] = on
                        assert by is None
                    expected = {"inventory": True, "purchasing": True, "sales": True, "finance": False}
                    assert by_org == {"old-one": expected, "old-two": expected}
                    history = conn.execute(text("SELECT action, changed_by_name, count(*) FROM organization_module_history GROUP BY 1, 2")).all()
                    assert history == [("migrated", "System", 8)]
                    # the organizations' own rows were not touched
                    assert conn.execute(text("SELECT count(*) FROM organizations")).scalar() == 2
                engine.dispose()
                command.downgrade(alembic_config(), "0004")  # reversible
                engine = create_engine(get_database_url().set(database=self.NAME))
                with engine.connect() as conn:
                    assert conn.execute(text("SELECT count(*) FROM organizations")).scalar() == 2
                    assert conn.execute(text("SELECT to_regclass('organization_modules')")).scalar() is None
                engine.dispose()
            finally:
                if previous is None:
                    os.environ.pop("DB_NAME", None)
                else:
                    os.environ["DB_NAME"] = previous
        finally:
            with admin.connect() as conn:
                conn.execute(text(f"DROP DATABASE IF EXISTS {self.NAME} WITH (FORCE)"))
            admin.dispose()

    def test_models_and_migrations_agree(self):
        from alembic.autogenerate import compare_metadata
        from alembic.migration import MigrationContext

        from app.database import Base

        with targeting_test_database():
            engine = create_engine(get_database_url())
            with engine.connect() as conn:
                diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
            engine.dispose()
        assert diff == []


# ----------------------------------------------------------------------------------------------------- what a background worker may ask
class TestInternalEntitlements:
    URL = "/internal/v1/organizations/{}/entitlements"

    def test_it_answers_with_the_secret_only(self, client, tokens, monkeypatch):
        org = make_org(client)
        apply(client, org, {"finance": True})
        monkeypatch.setenv("MODULE_INTERNAL_API_KEY", "worker-secret")
        body = client.get(self.URL.format(org), headers={"X-Internal-Key": "worker-secret"}).json()
        assert body == {"organization_id": org, "is_active": False or body["is_active"], "setup_completed": False, "modules": ["finance", "inventory"], "default_currency": "USD"}
        assert body["is_active"] is True
        for headers in ({}, {"X-Internal-Key": "wrong"}, bearer("super")):
            assert client.get(self.URL.format(org), headers=headers).status_code == 401
        who = admin_for(tokens, org)
        assert client.get(self.URL.format(org), headers=bearer(who)).status_code == 401  # an administrator's token is not a service credential

    def test_it_is_never_open_when_no_secret_is_configured_and_is_not_public(self, client, monkeypatch):
        org = make_org(client)
        monkeypatch.delenv("MODULE_INTERNAL_API_KEY", raising=False)
        assert client.get(self.URL.format(org), headers={"X-Internal-Key": "anything"}).status_code == 503
        monkeypatch.setenv("MODULE_INTERNAL_API_KEY", "k")
        assert client.get(self.URL.format(uuid.uuid4()), headers={"X-Internal-Key": "k"}).status_code == 404
        assert client.get(self.URL.format("not-a-uuid"), headers={"X-Internal-Key": "k"}).status_code == 422
        assert "/internal/v1" not in client.get("/openapi.json").text

    def test_organizations_using_a_module_are_listed_only_when_active_set_up_and_switched_on(self, client, tokens, session_factory, monkeypatch):
        monkeypatch.setenv("MODULE_INTERNAL_API_KEY", "k")
        url, headers = "/internal/v1/modules/finance/organizations", {"X-Internal-Key": "k"}
        on, not_set_up, off, inactive = (make_org(client, name=f"Org {n}", slug=f"org-{n}") for n in range(4))
        for org in (on, not_set_up, inactive):
            apply(client, org, {"finance": True})
        with session_factory() as db:
            db.execute(text("UPDATE organizations SET setup_status = 'completed', setup_completed_at = now() WHERE id IN (:a, :b, :c)"), {"a": on, "b": off, "c": inactive})
            db.execute(text("UPDATE organizations SET is_active = false WHERE id = :o"), {"o": inactive})
            db.commit()
        listed = client.get(url, headers=headers).json()
        assert [row["organization_id"] for row in listed] == [on]
        assert listed[0]["default_currency"] == "USD" and listed[0]["enabled_at"]
        apply(client, on, {"finance": False})
        assert client.get(url, headers=headers).json() == []  # switched off: the worker stops synchronising it
        assert client.get(url).status_code == 401 and client.get(url, headers={"X-Internal-Key": "wrong"}).status_code == 401
