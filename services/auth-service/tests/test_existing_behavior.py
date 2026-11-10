"""Existing Auth behaviour that must keep working: public registration, login, /me, Super Admin, migrations."""
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.models import User
from app.scripts import create_super_admin
from app.security import hash_password, password_problems

from conftest import alembic_config, targeting_test_database

PASSWORD = "Str0ng!Passphrase"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def login(client, email, password=PASSWORD):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password})


def test_super_admin_login_and_me_still_work(client, session_factory):
    with session_factory() as db:
        db.add(User(full_name="Root", email="root@example.org", password_hash=hash_password(PASSWORD), role="super-admin"))
        db.commit()
    token = login(client, "root@example.org").json()["access_token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert (me.json()["role"], me.json()["is_active"], me.json()["organization_id"]) == ("super-admin", True, None)
    assert login(client, "root@example.org", "wrong-password").status_code == 401


def test_public_registration_login_and_me(client):
    created = client.post("/api/v1/auth/register", json={"email": "u@example.org", "password": "password123", "full_name": "U"})
    assert created.status_code == 201 and created.json()["role"] == "user"
    token = login(client, "u@example.org", "password123").json()["access_token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["email"] == "u@example.org"
    duplicate = client.post("/api/v1/auth/register", json={"email": "u@example.org", "password": "password123", "full_name": "U"})
    assert duplicate.status_code == 409


def test_bootstrap_script_uses_the_shared_password_policy():
    assert create_super_admin.password_problems is password_problems
    assert password_problems("Str0ng!Passphrase", "a@b.org") == []
    assert password_problems("weak", "a@b.org")


def test_migrations_are_at_head_and_match_the_models(engine):
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0005"
        columns = {r.column_name: r.is_nullable for r in conn.execute(text(
            "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'users'"))}
    assert columns["organization_id"] == "YES"
    assert columns["dashboard_layout"] == "YES"
    with targeting_test_database():
        command.check(alembic_config())
