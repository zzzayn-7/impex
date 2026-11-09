import pytest
from fastapi.testclient import TestClient

from app.main import app

# A scheduler (on Vercel, where a background thread cannot run) triggers ONE synchronisation pass through an internal route. It must be reachable only with the
# shared secret, do exactly what one turn of the loop does, and never be part of the public API.

URL = "/internal/v1/finance/sync-cycle"
KEY = "test-internal-key"


@pytest.fixture(autouse=True)
def internal_key(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)
    monkeypatch.setenv("FINANCE_SYNC_ENABLED", "false")  # these tests call the route; no background thread of their own


def test_it_needs_the_shared_secret(client):
    assert client.post(URL).status_code == 401
    assert client.post(URL, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.post(URL, headers={"Authorization": "Bearer admin-alpha"}).status_code == 401  # a user's token is not the secret


def test_it_refuses_to_run_when_the_secret_is_not_configured(client, monkeypatch):
    monkeypatch.delenv("MODULE_INTERNAL_API_KEY")
    assert client.post(URL, headers={"X-Internal-Key": ""}).status_code == 503
    assert client.post(URL, headers={"X-Internal-Key": KEY}).status_code == 503  # never "open when unset"


def test_it_answers_503_when_synchronisation_is_not_configured(client):
    app.state.feed_client = None
    response = client.post(URL, headers={"X-Internal-Key": KEY})
    assert response.status_code == 503 and "not configured" in response.json()["detail"]


def test_one_call_is_one_cycle_over_every_organization_that_has_finance(client, directory, feeds):
    alpha, beta = directory.add_organization("Alpha Trading"), directory.add_organization("Beta Logistics")
    response = client.post(URL, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200
    assert response.json() == {"organizations": len(feeds.organizations())} and response.json()["organizations"] >= 2
    seen = {call[1] for call in feeds.calls}
    assert {str(alpha), str(beta)} <= {str(o) for o in seen}  # both organizations' feeds were pulled


def test_it_is_safe_to_repeat_and_reports_an_unreachable_source_as_zero_organizations(client, directory, feeds):
    directory.add_organization("Alpha Trading")
    assert client.post(URL, headers={"X-Internal-Key": KEY}).status_code == 200
    assert client.post(URL, headers={"X-Internal-Key": KEY}).status_code == 200  # again: nothing is posted twice (idempotent), no error
    feeds.down.add("organizations")
    response = client.post(URL, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200 and response.json() == {"organizations": 0}  # run_cycle never raises: it tries again next time


def test_it_is_not_part_of_the_public_api_document(client):
    assert URL not in client.get("/openapi.json").json()["paths"]


class TestStartup:
    """The background thread is for servers that stay up. On Vercel a schedule does its work instead."""

    @pytest.fixture
    def started(self, monkeypatch):
        calls = []

        class FakeWorker:
            def __init__(self, *args):
                pass

            def start(self):
                calls.append("start")

            def stop(self):
                calls.append("stop")

        monkeypatch.setattr("app.main.Worker", FakeWorker)
        monkeypatch.setenv("FINANCE_SYNC_ENABLED", "true")
        return calls

    def test_the_thread_starts_where_the_server_stays_up(self, started, monkeypatch):
        monkeypatch.delenv("VERCEL", raising=False)
        with TestClient(app):
            pass
        assert started == ["start", "stop"]

    def test_there_is_no_thread_on_vercel(self, started, monkeypatch):
        monkeypatch.setenv("VERCEL", "1")
        with TestClient(app):
            pass
        assert started == []

    def test_the_existing_off_switch_still_works(self, started, monkeypatch):
        monkeypatch.delenv("VERCEL", raising=False)
        monkeypatch.setenv("FINANCE_SYNC_ENABLED", "false")
        with TestClient(app):
            pass
        assert started == []
