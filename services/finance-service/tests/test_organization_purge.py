"""Deleting an organization from the CRM: this service's part (POST /internal/v1/organizations/{id}/purge).

Covers: the route needs the shared secret (401 without it, 503 when none is configured) and is not in the public API document; every table of the schema is covered by the
purge (a new table without `organization_id` makes this test fail until it is handled); deleting organization Alpha removes EVERY row it owned here (checked table by
table, ledgers included) and leaves organization Beta's rows exactly as they were; repeating it deletes nothing and succeeds; and Beta can still use the service afterwards.
"""
import uuid

import pytest
from sqlalchemy import text

from app import purge_api
from app.database import Base

URL = "/internal/v1/organizations/{}/purge"
KEY = {"X-Internal-Key": "purge-test-key"}


@pytest.fixture(autouse=True)
def purge_key(monkeypatch):
    monkeypatch.setenv("PURGE_API_KEY", "purge-test-key")


def owned_counts(engine, organization_id):
    """{table: number of rows the organization owns}, for every table of the schema that can hold its data."""
    counts = {}
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name in purge_api.GLOBAL_TABLES:
                continue
            if "organization_id" in table.c:
                sql = f'SELECT count(*) FROM "{table.name}" WHERE organization_id = :org'
            else:
                sql = f'SELECT count(*) FROM "{table.name}" WHERE {purge_api.DERIVED[table.name]}'
            counts[table.name] = conn.execute(text(sql), {"org": str(organization_id)}).scalar()
    return counts


def seed(request, fx):
    for key in ("alpha", "beta"):
        fx[key].expense(post=True)  # a posted expense: journal entry and lines (append-only), accounts, counters


def still_works(fx):
    assert fx["beta"].entries()["items"]


def test_every_table_of_the_schema_is_covered_by_the_purge():
    assert purge_api.uncovered_tables() == []  # a new table without an organization_id must be added to DERIVED (or GLOBAL_TABLES) on purpose


def test_the_route_needs_the_shared_secret_and_is_not_public(client, monkeypatch):
    org = uuid.uuid4()
    assert client.post(URL.format(org)).status_code == 401
    assert client.post(URL.format(org), headers={"X-Internal-Key": "wrong"}).status_code == 401
    monkeypatch.delenv("PURGE_API_KEY")
    assert client.post(URL.format(org), headers=KEY).status_code == 503  # fails closed
    assert not any("purge" in path for path in client.get("/openapi.json").json()["paths"])
    assert client.get(URL.format(org), headers=KEY).status_code == 405  # a purge is never a GET


def test_a_malformed_organization_id_is_refused(client):
    assert client.post("/internal/v1/organizations/not-a-uuid/purge", headers=KEY).status_code == 422


def test_an_organization_with_nothing_here_is_a_successful_no_op(client):
    response = client.post(URL.format(uuid.uuid4()), headers=KEY)
    assert response.status_code == 200 and response.json()["total"] == 0 and response.json()["service"] == purge_api.SERVICE


def test_purging_one_organization_deletes_all_of_its_data_and_nothing_of_anyone_elses(request, client, engine):
    fixture = request.getfixturevalue("two_orgs")
    seed(request, fixture)
    alpha, beta = fixture["alpha_id"], fixture["beta_id"]
    alpha_before, beta_before = owned_counts(engine, alpha), owned_counts(engine, beta)
    assert sum(alpha_before.values()) > 0 and sum(beta_before.values()) > 0  # both really have data
    response = client.post(URL.format(alpha), headers=KEY)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == sum(alpha_before.values())
    assert body["deleted"] == {table: n for table, n in alpha_before.items() if n}  # exactly what it owned, table by table
    assert sum(owned_counts(engine, alpha).values()) == 0  # nothing of Alpha is left, in any table
    assert owned_counts(engine, beta) == beta_before  # Beta is untouched
    again = client.post(URL.format(alpha), headers=KEY)
    assert again.status_code == 200 and again.json()["total"] == 0  # repeating it (a retried deletion) is harmless
    still_works(fixture)  # and the service keeps serving the organization that remains
