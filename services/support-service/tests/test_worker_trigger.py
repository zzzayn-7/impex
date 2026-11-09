import pytest

from app import worker_api

# A scheduler (on Vercel, where a background task cannot run) triggers ONE outbox pass through an internal route. It must be reachable only with the shared
# secret, do exactly what one turn of the loop does, and never be part of the public API.

URL = "/internal/v1/support/outbox-run"
KEY = "test-internal-key"


@pytest.fixture(autouse=True)
def internal_key(monkeypatch):
    monkeypatch.setenv("MODULE_INTERNAL_API_KEY", KEY)


def test_it_needs_the_shared_secret(client):
    assert client.post(URL).status_code == 401
    assert client.post(URL, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.post(URL, headers={"Authorization": "Bearer admin-alpha"}).status_code == 401  # a user's token is not the secret


def test_it_refuses_to_run_when_the_secret_is_not_configured(client, monkeypatch):
    monkeypatch.delenv("MODULE_INTERNAL_API_KEY")
    assert client.post(URL, headers={"X-Internal-Key": ""}).status_code == 503
    assert client.post(URL, headers={"X-Internal-Key": KEY}).status_code == 503  # never "open when unset"


def test_one_call_is_one_batch_and_reports_what_happened(client, monkeypatch):
    seen = []

    def fake_batch(factory, limit):
        seen.append(limit)
        return {"sent": 2, "retry": 1, "failed": 0}

    monkeypatch.setattr(worker_api.outbox, "process_batch", fake_batch)
    response = client.post(URL, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200 and response.json() == {"sent": 2, "retry": 1, "failed": 0}
    assert seen == [25]
    assert client.post(URL + "?limit=100", headers={"X-Internal-Key": KEY}).status_code == 200 and seen[-1] == 100


@pytest.mark.parametrize("limit", ["0", "101", "-1", "many"])
def test_the_batch_size_is_bounded(client, limit):
    assert client.post(f"{URL}?limit={limit}", headers={"X-Internal-Key": KEY}).status_code == 422


def test_an_empty_outbox_is_a_quiet_no_op(client):
    response = client.post(URL, headers={"X-Internal-Key": KEY})
    assert response.status_code == 200 and response.json() == {"sent": 0, "retry": 0, "failed": 0}


def test_it_is_not_part_of_the_public_api_document(client):
    assert URL not in client.get("/openapi.json").json()["paths"]


class TestStartup:
    """The outbox task is for servers that stay up. On Vercel a schedule does its work instead."""

    @pytest.fixture
    def started(self, monkeypatch):
        calls = []

        async def fake_worker(factory, stop):
            calls.append("start")
            await stop.wait()
            calls.append("stop")

        monkeypatch.setattr("app.main.run_worker", fake_worker)
        monkeypatch.setenv("SUPPORT_OUTBOX_WORKER", "on")
        return calls

    def test_the_task_starts_where_the_server_stays_up(self, started, monkeypatch):
        from fastapi.testclient import TestClient

        from app.main import app

        monkeypatch.delenv("VERCEL", raising=False)
        with TestClient(app):
            pass
        assert started == ["start", "stop"]

    def test_there_is_no_task_on_vercel(self, started, monkeypatch):
        from fastapi.testclient import TestClient

        from app.main import app

        monkeypatch.setenv("VERCEL", "1")
        with TestClient(app):
            pass
        assert started == []
