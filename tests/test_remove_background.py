import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from marcostudio.api import create_app
from marcostudio.config import Settings
from marcostudio.core.assets import Assets
from marcostudio.core.jobs import JobService
from marcostudio.core.store import Store


def cutout():
    image = Image.new("RGBA", (32, 32), (240, 90, 20, 0))
    image.putpixel((16, 16), (240, 90, 20, 127))
    image.putpixel((17, 16), (240, 90, 20, 255))
    stream = io.BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def test_transparent_asset_survives_download_and_reupload(tmp_path):
    app = create_app(Settings(data_dir=tmp_path), run_worker=False)
    with TestClient(app, base_url="http://127.0.0.1:7870") as client:
        asset = client.post("/api/assets", files={"file": ("cutout.png", cutout())}).json()
        data = client.get(asset["url"]).content
        with Image.open(io.BytesIO(data)) as image:
            assert image.mode == "RGBA"
            assert image.getpixel((0, 0))[3] == 0
            assert image.getpixel((16, 16))[3] == 127
            assert image.getpixel((17, 16))[3] == 255
        reused = client.post("/api/assets", files={"file": ("reuse.png", data)}).json()
        assert reused["id"] == asset["id"]


def test_background_job_restarts_and_regenerates_in_its_original_tool(tmp_path):
    config = Settings(data_dir=tmp_path)
    with TestClient(
        create_app(config, run_worker=False), base_url="http://127.0.0.1:7870"
    ) as client:
        source = client.post("/api/assets", files={"file": ("source.png", cutout())}).json()
        payload = {
            "feature": "remove-background",
            "source_id": source["id"],
            "settings": {"seed": 12},
            "request_id": "background-request",
        }
        response = client.post("/api/jobs", json=payload)
        assert response.status_code == 201
        job = response.json()
        assert job["feature"] == "remove-background"
        assert client.post("/api/jobs", json=payload).json()["id"] == job["id"]
        assert client.post("/api/jobs", json=payload | {"feature": "relight"}).status_code == 409
        assert (
            client.post(
                "/api/jobs", json=payload | {"settings": {"direction": "front"}}
            ).status_code
            == 422
        )
        assert client.post("/api/jobs", json=payload | {"feature": "unknown"}).status_code == 422
    with TestClient(
        create_app(config, run_worker=False), base_url="http://127.0.0.1:7870"
    ) as client:
        assert client.get("/api/jobs").json()[0]["feature"] == "remove-background"
        regenerated = client.post(
            f"/api/jobs/{job['id']}/regenerate", json={"request_id": "again"}
        ).json()
        assert regenerated["feature"] == job["feature"]
        assert regenerated["settings"] == job["settings"]
        assert regenerated["source_id"] == source["id"]


@pytest.mark.asyncio
async def test_background_worker_records_qwen_graph_and_retains_output_alpha(tmp_path):
    from marcostudio.features import get_feature

    class Completed:
        async def upload(self, *args):
            return "source.png"

        async def submit(self, graph, *args):
            self.graph = graph
            return "background-upstream"

        async def state(self, job_id):
            return {
                "status": "succeeded",
                "outputs": [{"node_id": "12", "id": "cutout"}],
                "history": {},
            }

        async def output(self, *args):
            return cutout()

    store = Store(tmp_path)
    assets = Assets(store)
    source = assets.add(cutout(), "source.png")
    feature = get_feature("remove-background")
    job = store.create_job(
        source["id"], feature.settings().model_dump(), "once", feature=feature.id
    )
    transport = Completed()
    service = JobService(Settings(data_dir=tmp_path), store, transport)
    await service.execute(job["id"], readiness={"ready": True, "models": {}, "identities": {}})
    submitted = store.job(job["id"])
    assert submitted["status"] == "queued"
    graph = transport.graph
    encode = next(n for n in graph.values() if n["class_type"] == "TextEncodeQwenImage21")
    assert encode["inputs"]["prompt"] == "Remove the background, and output a PNG image"
    assert encode["inputs"]["resolution"] == 1024
    assert "images.image_1" in encode["inputs"]
    rgba = graph[encode["inputs"]["images.image_1"][0]]
    assert rgba["class_type"] == "JoinImageWithAlpha"
    assert rgba["inputs"]["image"] == ["11", 0]
    assert rgba["inputs"]["alpha"] == ["11", 1]
    assert not any("Lora" in n["class_type"] for n in graph.values())
    assert submitted["receipt"]["feature"] == "remove-background"
    await service.reconcile(job["id"])
    finished = store.job(job["id"])
    assert finished["status"] == "succeeded"
    with Image.open(assets.path(finished["outputs"][0]["id"])) as image:
        assert image.getchannel("A").getextrema() == (0, 255)


def test_doctor_understands_v3_reference_sockets_and_cache_options():
    from marcostudio.comfy.doctor import validate_inputs

    definition = {
        "input": {
            "required": {
                "images": [
                    "COMFY_AUTOGROW_V3",
                    {
                        "template": {
                            "input": {"required": {"image": ["IMAGE", {}]}},
                            "names": ["image_1", "image_2"],
                            "min": 1,
                        }
                    },
                ],
                "device": ["COMBO", {"options": ["auto", "cpu"]}],
            }
        }
    }
    node = {
        "class_type": "ReferenceNode",
        "inputs": {"images.image_1": ["11", 0], "device": "auto"},
    }
    validate_inputs(node, definition)
    with pytest.raises(ValueError, match="device"):
        validate_inputs(node | {"inputs": node["inputs"] | {"device": "invalid"}}, definition)
    with pytest.raises(ValueError, match="Too few"):
        validate_inputs(
            node | {"inputs": {"images.image_3": ["11", 0], "device": "auto"}}, definition
        )
