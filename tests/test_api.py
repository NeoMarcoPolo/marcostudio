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
