import dataclasses
import hashlib
import io
import json
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from marcostudio.comfy.doctor import diagnose
from marcostudio.config import Settings
from marcostudio.core.assets import Assets
from marcostudio.core.jobs import JobService
from marcostudio.core.store import Store
from marcostudio.features import get_feature


@pytest.fixture
def ready_runtime(tmp_path, monkeypatch):
    comfy = tmp_path / "ComfyUI"
    comfy.mkdir()
    (comfy / "main.py").write_text("# isolated fixture")
    original = get_feature("relight")
    models = []
    for model in original.models_for("flash"):
        folder = comfy / "models" / model.category
        folder.mkdir(parents=True, exist_ok=True)
        header = json.dumps(
            {"fixture": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
        ).encode()
        raw = len(header).to_bytes(8, "little") + header + b"\0" * 4
        (folder / model.filename).write_bytes(raw)
        models.append(
            dataclasses.replace(model, size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        )
    manifest = SimpleNamespace(
        **(
            {k: v for k, v in vars(original.manifest).items() if not k.startswith("__")}
            | {"MODELS": tuple(models)}
        )
    )
    tool = dataclasses.replace(original, manifest=manifest)
    monkeypatch.setattr(
        "marcostudio.comfy.doctor.get_feature",
        lambda feature: tool if feature == "relight" else get_feature(feature),
    )
    monkeypatch.setattr(
        "marcostudio.core.jobs.get_feature",
        lambda feature: tool if feature == "relight" else get_feature(feature),
    )
    graph = tool.compile(tool.settings(), "source.png", "readiness", {}, inputs={})
    definitions = {}
    for node in graph.values():
        fields = definitions.setdefault(node["class_type"], {"input": {"required": {}}})["input"][
            "required"
        ]
        for key, value in node["inputs"].items():
            fields[key] = [
                "INT" if type(value) is int else "FLOAT" if type(value) is float else "STRING",
                {},
            ]
    for model in models:
        fields = definitions[model.loader]["input"]["required"]
        choices = fields.get(model.field, [[]])[0]
        fields[model.field] = [
            [*(choices if isinstance(choices, list) else []), model.filename],
            {},
        ]
    state = {"device": "cpu", "version": "2.13.0"}
    requests = []

    def respond(request):
        requests.append(request.url.path)
        if request.url.path == "/system_stats":
            return httpx.Response(
                200,
                json={
                    "system": {"comfyui_version": "0.43.0", "pytorch_version": state["version"]},
                    "devices": [{"type": state["device"]}],
                },
            )
        if request.url.path == "/api/v2/health":
            return httpx.Response(
                200, json={"status": "healthy", "upstream": "http://127.0.0.1:8188"}
            )
        if request.url.path.startswith("/object_info/"):
            name = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={name: definitions[name]})
        raise AssertionError(request.url.path)

    original_client = httpx.AsyncClient

    def client(**kwargs):
        kwargs.setdefault("transport", httpx.MockTransport(respond))
        return original_client(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    config = Settings(comfy_dir=comfy, data_dir=tmp_path / "not-created")
    return SimpleNamespace(config=config, state=state, tool=tool, requests=requests)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "device,version,ready",
    [
        ("cpu", "2.13.0", True),
        ("cuda", "2.13.0", True),
        ("mps", "2.13.0", False),
        ("mps", "2.15.0", False),
        (None, "2.15.0", False),
    ],
)
async def test_complete_production_readiness_depends_on_selected_device(
    ready_runtime, device, version, ready
):
    env = ready_runtime
    env.state.update(device=device, version=version)
    report = await diagnose(env.config, "flash", verify_hashes=True)
    assert report["ready"] is ready
    assert len(report["identities"]) == 5
    assert {c["name"] for c in report["checks"] if c["status"] == "fail"} == (
        set() if ready else {"device:relight"}
    )
    assert all(c["status"] == "pass" for c in report["checks"] if c["name"] != "device:relight")
    assert not env.config.data_dir.exists()
    assert env.requests.count("/system_stats") == 1


class Transport:
    def __init__(self):
        self.calls = []

    async def upload(self, *args):
        self.calls.append("upload")
        return "source.png"

    async def submit(self, *args):
        self.calls.append("submit")
        return "upstream"

    async def __aexit__(self):
        pass


def picture():
    stream = io.BytesIO()
    Image.new("RGB", (64, 64), "white").save(stream, format="PNG")
    return stream.getvalue()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "device,version", [("cpu", "2.13.0"), ("cuda", "2.13.0"), ("mps", "2.13.0"), ("mps", "2.15.0")]
)
async def test_worker_uses_real_readiness_before_any_upstream_operation(
    ready_runtime, device, version
):
    env = ready_runtime
    env.state.update(device=device, version=version)
    store = Store(env.config.data_dir)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], env.tool.settings().model_dump(), "worker")
    transport = Transport()
    service = JobService(env.config, store, transport)
    await service.execute(job["id"])
    if device == "mps":
        assert transport.calls == []
        assert store.job(job["id"])["status"] == "failed"
        assert "MPS" in store.job(job["id"])["error"]
    else:
        assert transport.calls == ["upload", "submit"]
        assert store.job(job["id"])["status"] == "queued"
    assert env.requests.count("/system_stats") == 1


def test_api_regeneration_and_cli_doctor_use_real_compatibility_gate(
    ready_runtime, monkeypatch, tmp_path, capsys
):
    from fastapi.testclient import TestClient

    from marcostudio.api import create_app
    from marcostudio.cli import main

    env = ready_runtime
    env.state["device"] = "mps"
    config_file = tmp_path / "settings.json"
    config_file.write_text(env.config.model_dump_json())
    assert (
        main(
            [
                "--config",
                str(config_file),
                "doctor",
                "--feature",
                "relight",
                "--verify-hashes",
                "--json",
            ]
        )
        == 1
    )
    cli_report = json.loads(capsys.readouterr().out)
    assert not cli_report["ready"]
    assert {c["name"] for c in cli_report["checks"] if c["status"] == "fail"} == {"device:relight"}
    transport = Transport()
    monkeypatch.setattr("marcostudio.api.ComfyTransport", lambda config: transport)
    with TestClient(
        create_app(env.config, run_worker=False), base_url="http://127.0.0.1:7870"
    ) as client:
        source = client.post(
            "/api/assets", files={"file": ("source.png", picture(), "image/png")}
        ).json()
        first = client.post(
            "/api/jobs", json={"source_id": source["id"], "settings": {}, "request_id": "first"}
        )
        assert first.status_code == 201
        regenerated = client.post(
            f"/api/jobs/{first.json()['id']}/regenerate", json={"request_id": "again"}
        )
        assert regenerated.status_code == 201
        for job in [first.json(), regenerated.json()]:
            client.portal.call(client.app.state.service.execute, job["id"])
            observed = client.get(f"/api/jobs/{job['id']}").json()
            assert observed["status"] == "failed" and "MPS" in observed["error"]
        assert not client.get("/api/doctor?feature=relight").json()["ready"]
    assert transport.calls == []


@pytest.mark.asyncio
async def test_standard_relight_mode_remains_unsupported(ready_runtime):
    report = await diagnose(ready_runtime.config, "standard", verify_hashes=True)
    assert not report["ready"]
    assert {c["name"] for c in report["checks"] if c["status"] == "fail"} == {"mode"}
