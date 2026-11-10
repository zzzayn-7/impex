"""Each person's own home-page widget arrangement: widget identifiers only, saved against the authenticated user, in a namespace per role.

Covers: nothing saved reads as null (every widget, default order); a valid arrangement saves and reads back with a rising revision; repeating a save changes
nothing else; unknown, duplicate, wrongly typed and cross-role identifiers (and HTML/CSS) are refused with nothing stored; a widget cannot be both shown and
hidden; no other field is accepted; a token is required; people only ever change their own record, and an organization administrator can hold only "org."
widgets while a Super Admin can hold only "admin." ones; retired identifiers in an old document are dropped on read; the migration only adds a nullable
column, so every existing account is unchanged and the theme is untouched.
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.dashboard_layout import ADMIN_WIDGET_IDS, ORG_WIDGET_IDS, layout_of
from app.main import app
from app.models import User
from app.security import hash_password

PASSWORD = "Str0ng!Passphrase"
ORG = str(uuid.uuid4())
LAYOUT = "/api/v1/auth/me/dashboard-layout"
THEME = "/api/v1/auth/me/theme"
ME = "/api/v1/auth/me"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def add_user(session_factory, email, role="organization-admin", organization_id=ORG):
    with session_factory() as db:
        user = User(full_name="Olivia Owner", email=email, password_hash=hash_password(PASSWORD), role=role,
                    organization_id=uuid.UUID(organization_id) if organization_id else None, is_active=True)
        db.add(user)
        db.commit()
        return str(user.id)


def token(client, email):
    return {"Authorization": "Bearer " + client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()["access_token"]}


def stored(session_factory, user_id):
    with session_factory() as db:
        return db.get(User, uuid.UUID(user_id)).dashboard_layout


def test_the_identifier_lists_are_the_portals_registries_in_default_order():
    assert ORG_WIDGET_IDS[0] == "org.overview" and len(ORG_WIDGET_IDS) == 15 and len(set(ORG_WIDGET_IDS)) == 15
    assert ADMIN_WIDGET_IDS == (
        "admin.kpi.active-tenants", "admin.kpi.system-uptime", "admin.kpi.api-gateway-requests", "admin.kpi.pending-approvals",
        "admin.panel.microservice-registry", "admin.panel.docker-compose", "admin.panel.api-documentation",
    )
    # a KPI and the list of the same records are different widgets
    assert "org.kpi.open-purchase-orders" in ORG_WIDGET_IDS and "org.list.open-purchase-orders" in ORG_WIDGET_IDS


def test_nothing_saved_reads_as_null_so_the_portal_shows_every_widget(client, session_factory):
    add_user(session_factory, "a@example.org")
    assert client.get(ME, headers=token(client, "a@example.org")).json()["dashboard_layout"] is None


def test_a_valid_arrangement_saves_and_reads_back_with_a_rising_revision(client, session_factory):
    user_id = add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    first = client.put(LAYOUT, json={"order": ["org.kpi.active-products", "org.overview"], "hidden": ["org.panel.organization"]}, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["dashboard_layout"] == {"version": 1, "revision": 1, "order": ["org.kpi.active-products", "org.overview"], "hidden": ["org.panel.organization"]}
    second = client.put(LAYOUT, json={"order": ["org.overview"], "hidden": []}, headers=headers)
    assert second.json()["dashboard_layout"]["revision"] == 2
    assert client.get(ME, headers=headers).json()["dashboard_layout"] == {"version": 1, "revision": 2, "order": ["org.overview"], "hidden": []}
    assert stored(session_factory, user_id)["order"] == ["org.overview"]


def test_every_known_widget_can_be_saved_in_any_order(client, session_factory):
    add_user(session_factory, "a@example.org")
    order = list(reversed(ORG_WIDGET_IDS))
    response = client.put(LAYOUT, json={"order": order, "hidden": []}, headers=token(client, "a@example.org"))
    assert response.status_code == 200 and response.json()["dashboard_layout"]["order"] == order


def test_an_empty_dashboard_is_a_valid_choice(client, session_factory):
    add_user(session_factory, "a@example.org")
    response = client.put(LAYOUT, json={"order": [], "hidden": list(ORG_WIDGET_IDS)}, headers=token(client, "a@example.org"))
    assert response.status_code == 200 and response.json()["dashboard_layout"]["order"] == []


def test_saving_the_layout_leaves_the_theme_alone(client, session_factory):
    add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    client.put(THEME, json={"background": "ice", "accent": "frost-blue"}, headers=headers)
    client.put(LAYOUT, json={"order": ["org.overview"], "hidden": []}, headers=headers)
    me = client.get(ME, headers=headers).json()
    assert (me["theme_background"], me["theme_accent"]) == ("ice", "frost-blue")
    client.put(THEME, json={"background": "graphite", "accent": "frost-blue"}, headers=headers)
    assert client.get(ME, headers=headers).json()["dashboard_layout"]["order"] == ["org.overview"]


@pytest.mark.parametrize("body", [
    {"order": ["org.nope"], "hidden": []},  # unknown
    {"order": ["org.overview", "org.overview"], "hidden": []},  # repeated
    {"order": [], "hidden": ["org.overview", "org.overview"]},
    {"order": ["org.overview"], "hidden": ["org.overview"]},  # shown and hidden
    {"order": ["admin.kpi.active-tenants"], "hidden": []},  # another role's widget
    {"order": [], "hidden": ["admin.panel.docker-compose"]},
    {"order": ["<script>alert(1)</script>"], "hidden": []},  # markup
    {"order": ["org.overview;background:url(//evil.example)"], "hidden": []},  # CSS
    {"order": ["ORG.OVERVIEW"], "hidden": []},  # exact identifiers only
    {"order": ["org.overview "], "hidden": []},
    {"order": [1], "hidden": []},  # wrong types
    {"order": [None], "hidden": []},
    {"order": [["org.overview"]], "hidden": []},
    {"order": "org.overview", "hidden": []},
    {"order": [], "hidden": "org.overview"},
    {"order": {"0": "org.overview"}, "hidden": []},
    {"order": ["org.overview"] * 65, "hidden": []},  # absurd size
    {"order": ["org.overview"]},  # missing field
    {"hidden": []},
    {},
])
def test_anything_that_is_not_an_approved_arrangement_is_refused_and_nothing_changes(client, session_factory, body):
    user_id = add_user(session_factory, "a@example.org")
    headers = token(client, "a@example.org")
    assert client.put(LAYOUT, json={"order": ["org.kpi.active-products"], "hidden": []}, headers=headers).status_code == 200
    before = stored(session_factory, user_id)
    response = client.put(LAYOUT, json=body, headers=headers)
    assert response.status_code == 422, response.text
    assert stored(session_factory, user_id) == before


@pytest.mark.parametrize("extra", [{"user_id": str(uuid.uuid4())}, {"role": "super-admin"}, {"organization_id": str(uuid.uuid4())}, {"html": "<b>x</b>"}, {"css": "body{display:none}"}, {"revision": 99}])
def test_no_other_field_is_accepted(client, session_factory, extra):
    user_id = add_user(session_factory, "a@example.org")
    response = client.put(LAYOUT, json={"order": ["org.overview"], "hidden": [], **extra}, headers=token(client, "a@example.org"))
    assert response.status_code == 422
    assert stored(session_factory, user_id) is None


def test_a_token_is_required(client):
    body = {"order": [], "hidden": []}
    assert client.put(LAYOUT, json=body).status_code == 401
    assert client.put(LAYOUT, json=body, headers={"Authorization": "Bearer not-a-token"}).status_code == 401


def test_each_person_has_their_own_arrangement_and_cannot_touch_anothers(client, session_factory):
    a = add_user(session_factory, "a@example.org")
    b = add_user(session_factory, "b@example.org", organization_id=str(uuid.uuid4()))
    sa = add_user(session_factory, "root@example.org", role="super-admin", organization_id=None)
    client.put(LAYOUT, json={"order": ["org.panel.modules"], "hidden": []}, headers=token(client, "a@example.org"))
    client.put(LAYOUT, json={"order": ["admin.panel.docker-compose"], "hidden": ["admin.kpi.system-uptime"]}, headers=token(client, "root@example.org"))
    assert stored(session_factory, a)["order"] == ["org.panel.modules"]
    assert stored(session_factory, b) is None  # a colleague in another organization is untouched
    assert stored(session_factory, sa)["order"] == ["admin.panel.docker-compose"]
    assert client.get(ME, headers=token(client, "b@example.org")).json()["dashboard_layout"] is None


def test_super_admins_hold_only_admin_widgets_and_org_admins_only_org_widgets(client, session_factory):
    add_user(session_factory, "root@example.org", role="super-admin", organization_id=None)
    add_user(session_factory, "a@example.org")
    root, org = token(client, "root@example.org"), token(client, "a@example.org")
    assert client.put(LAYOUT, json={"order": list(ADMIN_WIDGET_IDS), "hidden": []}, headers=root).status_code == 200
    assert client.put(LAYOUT, json={"order": ["org.overview"], "hidden": []}, headers=root).status_code == 422
    assert client.put(LAYOUT, json={"order": list(ADMIN_WIDGET_IDS), "hidden": []}, headers=org).status_code == 422


def test_a_role_without_a_dashboard_cannot_save(client, session_factory):
    add_user(session_factory, "u@example.org", role="user", organization_id=None)
    assert client.put(LAYOUT, json={"order": [], "hidden": []}, headers=token(client, "u@example.org")).status_code == 403


def test_a_disabled_account_cannot_save(client, session_factory):
    add_user(session_factory, "off@example.org")
    headers = token(client, "off@example.org")
    with session_factory() as db:
        db.execute(text("UPDATE users SET is_active = false WHERE email = 'off@example.org'"))
        db.commit()
    assert client.put(LAYOUT, json={"order": [], "hidden": []}, headers=headers).status_code == 401


def test_retired_or_corrupt_stored_identifiers_are_dropped_on_read_never_an_error(client, session_factory):
    user_id = add_user(session_factory, "a@example.org")
    with session_factory() as db:
        user = db.get(User, uuid.UUID(user_id))
        user.dashboard_layout = {"version": 0, "revision": 3, "order": ["org.old-widget", "org.overview", "org.overview", 5, "admin.panel.docker-compose"], "hidden": ["org.panel.modules", "org.overview"]}
        db.commit()
    me = client.get(ME, headers=token(client, "a@example.org")).json()
    assert me["dashboard_layout"] == {"version": 1, "revision": 3, "order": [], "hidden": ["org.panel.modules", "org.overview"]}
    for junk in ("text", ["list"], 7):
        with session_factory() as db:
            user = db.get(User, uuid.UUID(user_id))
            user.dashboard_layout = junk
            db.commit()
            assert layout_of(user) is None
    assert client.get(ME, headers=token(client, "a@example.org")).status_code == 200


def test_the_migration_only_adds_a_nullable_column(session_factory):
    with session_factory() as db:
        row = db.execute(text("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'dashboard_layout'")).one()
    assert (row[0], row[1]) == ("jsonb", "YES")
