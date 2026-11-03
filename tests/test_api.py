import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture
def client(tmp_path):
    from marcostudio.api import create_app
    from marcostudio.config import Settings

    app = create_app(
        Settings(data_dir=tmp_path / "data"), config_file=tmp_path / "config.json", run_worker=False
    )
    with TestClient(app, base_url="http://127.0.0.1:7870") as client:
        yield client


def upload(client):
    stream = io.BytesIO()
    Image.new("RGB", (64, 64), "white").save(stream, format="PNG")
    response = client.post(
        "/api/assets", files={"file": ("source.png", stream.getvalue(), "image/png")}
    )
    assert response.status_code == 201
    return response.json()


def test_roundtrip_idempotency_history_regeneration_and_cancel(client):
    source = upload(client)
    assert client.get(source["url"]).headers["content-type"] == "image/png"
    settings = client.get("/api/features").json()[0]["defaults"]
    payload = {"source_id": source["id"], "settings": settings, "request_id": "once"}
    job = client.post("/api/jobs", json=payload).json()
    assert client.post("/api/jobs", json=payload).json()["id"] == job["id"]
    changed = payload | {"settings": settings | {"brightness": 20}}
    assert client.post("/api/jobs", json=changed).status_code == 409
    assert len(client.get("/api/jobs").json()) == 1
    assert (
        client.put("/api/settings", json={"comfy_url": "http://127.0.0.1:8187"}).status_code == 409
    )
    cancelled = client.post(f"/api/jobs/{job['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    regenerated = client.post(
        f"/api/jobs/{job['id']}/regenerate", json={"request_id": "new"}
    ).json()
    assert regenerated["id"] != job["id"]
    assert regenerated["settings"] == job["settings"]
    assert regenerated["source_id"] == source["id"]


def test_origin_and_host_guards(client):
    assert client.get("/api/jobs", headers={"Host": "attacker.example"}).status_code == 403
    assert (
        client.post(
            "/api/jobs", headers={"Origin": "https://attacker.example"}, json={}
        ).status_code
        == 403
    )
    assert (
        client.post("/api/jobs", headers={"Origin": "http://127.0.0.1:9999"}, json={}).status_code
        == 403
    )
    assert (
        client.post("/api/jobs", headers={"Sec-Fetch-Site": "cross-site"}, json={}).status_code
        == 403
    )
    assert (
        client.get("/api/features", headers={"Origin": "http://127.0.0.1:7870"}).status_code == 200
    )


def test_validation_and_settings_do_not_admit_unsupported_work(client):
    source = upload(client)
    assert (
        client.post(
            "/api/jobs",
            json={"source_id": source["id"], "settings": {"mode": "standard"}, "request_id": "no"},
        ).status_code
        == 422
    )
    assert client.post("/api/assets", files={"file": ("bad.png", b"broken")}).status_code == 422
    assert (
        client.put("/api/settings", json={"comfy_url": "https://remote.example"}).status_code == 422
    )
    assert client.put("/api/settings", json={"data_dir": "elsewhere"}).status_code == 422
    assert (
        client.put("/api/settings", json={"comfy_url": "http://127.0.0.1:8187"}).status_code == 200
    )
    assert client.get("/api/settings").json()["comfy_url"].endswith("8187")
    assert client.get("/api/jobs/missing").status_code == 404
    assert client.get("/").status_code == 200
    assert client.get("/api/unknown").status_code == 404


def test_runtime_lock_prevents_second_worker_and_releases(tmp_path):
    from marcostudio.core.lock import RuntimeLock

    with RuntimeLock(tmp_path), pytest.raises(RuntimeError, match="already"):
        with RuntimeLock(tmp_path):
            pass
    with RuntimeLock(tmp_path):
        pass


def test_settings_can_restore_recorded_endpoints_without_retargeting_jobs(client):
    source = upload(client)
    job = client.post(
        "/api/jobs", json={"source_id": source["id"], "settings": {}, "request_id": "restore"}
    ).json()
    original = {"comfy_url": "http://127.0.0.1:8288", "proxy_url": "http://127.0.0.1:8289"}
    store = client.app.state.store
    store.update_job(job["id"], status="needs_attention", backend=original)
    settings = client.get("/api/settings").json()
    assert settings["restore_connection"] == original
    assert client.put("/api/settings", json={"comfy_url": original["comfy_url"]}).status_code == 409
    assert (
        client.put("/api/settings", json=original | {"comfy_dir": "elsewhere"}).status_code == 409
    )
    # Conflicting unfinished jobs must not permit either target.
    other = store.create_job(source["id"], {}, "other")
    store.update_job(
        other["id"],
        status="needs_attention",
        backend={"comfy_url": "http://127.0.0.1:8388", "proxy_url": "http://127.0.0.1:8389"},
    )
    assert client.get("/api/settings").json()["restore_connection"] is None
    assert client.put("/api/settings", json=original).status_code == 409
    store.update_job(other["id"], status="abandoned")
    restored = client.put("/api/settings", json=original)
    assert restored.status_code == 200
    assert restored.json()["comfy_url"] == original["comfy_url"]
    assert restored.json()["proxy_url"] == original["proxy_url"]
    assert restored.json()["restore_connection"] is None
    assert store.job(job["id"])["status"] == "needs_attention"
    assert (
        client.put("/api/settings", json={"comfy_url": "http://127.0.0.1:8488"}).status_code == 409
    )


def test_resolution_requires_confirmation_and_retains_uncertainty_in_history(client):
    class MissingRun:
        async def find(self, prefix):
            return None

        async def native_json(self, path):
            return {"queue_running": [], "queue_pending": []}

        async def __aexit__(self, *args):
            pass

    source = upload(client)
    job = client.post(
        "/api/jobs", json={"source_id": source["id"], "settings": {}, "request_id": "uncertain"}
    ).json()
    store = client.app.state.store
    store.update_job(job["id"], status="needs_attention")
    client.app.state.service.transport = MissingRun()
    path = f"/api/jobs/{job['id']}/resolve"
    assert client.post(path, json={"confirm_not_running": False}).status_code == 422
    assert store.job(job["id"])["status"] == "needs_attention"
    response = client.post(path, json={"confirm_not_running": True})
    assert response.status_code == 200
    assert response.json()["status"] == "abandoned"
    assert "not verified" in response.json()["error"]
    assert len(client.get("/api/jobs").json()) == 1


def test_waiting_diagnostics_cover_reads_submission_regeneration_and_clearing(client):
    source = upload(client)
    store = client.app.state.store
    uncertain = store.create_job(source["id"], {}, "uncertain")
    healthy = store.create_job(source["id"], {}, "healthy")
    store.update_job(uncertain["id"], status="needs_attention")
    store.update_job(healthy["id"], status="running")
    payload = {"source_id": source["id"], "settings": {}, "request_id": "pending"}
    response = client.post("/api/jobs", json=payload)
    assert response.status_code == 201
    pending = response.json()
    before = store.jobs()
    expected = [
        {"id": healthy["id"], "status": "running"},
        {
            "id": uncertain["id"],
            "status": "needs_attention",
            "resolve_command": f"marcostudio jobs --server STUDIO_URL resolve {uncertain['id']} --confirm-not-running",
        },
    ]
    assert pending["waiting"]["blockers"] == expected
    assert client.get(f"/api/jobs/{pending['id']}").json() == pending
    assert next(j for j in client.get("/api/jobs").json() if j["id"] == pending["id"]) == pending
    assert client.post("/api/jobs", json=payload).json() == pending
    assert store.jobs() == before
    regenerated = client.post(
        f"/api/jobs/{pending['id']}/regenerate", json={"request_id": "regenerated"}
    )
    assert regenerated.status_code == 201
    assert regenerated.json()["waiting"]["blockers"] == expected
    assert client.get("/api/jobs/missing").status_code == 404
    store.update_job(uncertain["id"], status="abandoned")
    remaining = client.get(f"/api/jobs/{pending['id']}").json()["waiting"]["blockers"]
    assert remaining == [{"id": healthy["id"], "status": "running"}]
    store.update_job(healthy["id"], status="succeeded")
    assert "waiting" not in client.get(f"/api/jobs/{pending['id']}").json()
    assert all("waiting" not in j for j in store.jobs())


def test_detail_waiting_uses_one_snapshot_and_preserves_not_found(client, monkeypatch):
    store = client.app.state.store
    pending = store.create_job(None, {}, "snapshot")
    snapshot = store.jobs()
    reads = []

    def one_snapshot():
        reads.append(True)
        return snapshot

    def forbidden_second_read(*args):
        raise AssertionError("Detail target must come from the blocker snapshot")

    monkeypatch.setattr(store, "jobs", one_snapshot)
    monkeypatch.setattr(store, "job", forbidden_second_read)
    assert client.get(f"/api/jobs/{pending['id']}").json() == pending
    assert reads == [True]
    assert client.get("/api/jobs/missing").status_code == 404
    assert reads == [True, True]
