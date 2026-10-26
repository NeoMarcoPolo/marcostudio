import io
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from marcostudio.api import create_app
from marcostudio.config import Settings


def picture(color):
    data = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(data, "PNG")
    return data.getvalue()


def test_text_generation_and_reference_jobs_survive_restart(tmp_path):
    config = Settings(data_dir=tmp_path)
    with TestClient(create_app(config, run_worker=False), base_url="http://127.0.0.1") as c:
        first = c.post(
            "/api/jobs",
            json={
                "feature": "create-image",
                "settings": {"instruction": "A ceramic bowl on a table"},
                "request_id": "text",
            },
        )
        assert first.status_code == 201
        assert first.json()["source_id"] is None
        a, b = [
            c.post("/api/assets", files={"file": ("a.png", picture(color))}).json()
            for color in ("white", "black")
        ]
        payload = {
            "feature": "ai-stylist",
            "source_id": a["id"],
            "inputs": {"reference_1": b["id"]},
            "settings": {},
            "request_id": "outfit",
        }
        response = c.post("/api/jobs", json=payload)
        assert response.status_code == 201
        job = response.json()
        assert c.post("/api/jobs", json=payload).json()["id"] == job["id"]
        assert (
            c.post("/api/jobs", json=payload | {"inputs": {"reference_1": a["id"]}}).status_code
            == 409
        )
        assert c.post("/api/jobs", json=payload | {"inputs": {}}).status_code == 422
        assert (
            c.post("/api/jobs", json=payload | {"inputs": {"surprise": b["id"]}}).status_code == 422
        )
    with TestClient(create_app(config, run_worker=False), base_url="http://127.0.0.1") as c:
        again = c.post(f"/api/jobs/{job['id']}/regenerate", json={"request_id": "repeat"}).json()
        assert again["inputs"] == job["inputs"]
        assert again["source_id"] == job["source_id"]
        assert again["settings"] == job["settings"]
        text = c.post(
            f"/api/jobs/{first.json()['id']}/regenerate", json={"request_id": "text2"}
        ).json()
        assert text["source_id"] is None


def test_qwen_references_and_flash_use_the_official_conditioning_path():
    from marcostudio.features import get_feature

    tool = get_feature("edit-image")
    config = tool.parse_settings({"instruction": "Combine <image1> and <image2>", "mode": "flash"})
    graph = tool.compile(config, "subject.png", "test", {}, inputs={"reference_1": "outfit.png"})
    encode = next(n["inputs"] for n in graph.values() if n["class_type"] == "TextEncodeQwenImage21")
    for index, filename in enumerate(("subject.png", "outfit.png"), 1):
        rgba = graph[encode[f"images.image_{index}"][0]]
        assert rgba["class_type"] == "JoinImageWithAlpha"
        loader, output = rgba["inputs"]["image"]
        assert output == 0 and graph[loader]["inputs"]["image"] == filename
        assert rgba["inputs"]["alpha"] == [loader, 1]
    assert any("turbo" in m.filename for m in tool.models_for("flash"))
    assert not any("turbo" in m.filename for m in tool.models_for("standard"))
    assert graph["12"]["class_type"] == "SaveImage"


def test_qwen_rejects_ineffective_negative_prompts_before_queueing(tmp_path):
    with TestClient(
        create_app(Settings(data_dir=tmp_path), run_worker=False), base_url="http://127.0.0.1"
    ) as client:
        for mode in ("standard", "flash"):
            response = client.post(
                "/api/jobs",
                json={
                    "feature": "create-image",
                    "settings": {"instruction": "A bowl", "mode": mode, "negative_prompt": "red"},
                    "request_id": mode,
                },
            )
            assert response.status_code == 422
        assert client.get("/api/jobs").json() == []


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg needed"
)
@pytest.mark.parametrize("frames,expected", [(4, 422), (5, 201)])
def test_restyle_rejects_too_few_decoded_frames_before_queueing(tmp_path, frames, expected):
    path = tmp_path / "short.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x64:r=24",
            "-frames:v",
            str(frames),
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    with TestClient(
        create_app(Settings(data_dir=tmp_path / "data"), run_worker=False),
        base_url="http://127.0.0.1",
    ) as client:
        asset = client.post("/api/assets", files={"file": ("short.mp4", path.read_bytes())}).json()
        response = client.post(
            "/api/jobs",
            json={
                "feature": "restyle-video",
                "source_id": asset["id"],
                "settings": {"instruction": "Watercolor"},
                "request_id": "short",
            },
        )
        assert response.status_code == expected
        assert asset["frame_count"] == frames
        assert len(client.get("/api/jobs").json()) == (1 if expected == 201 else 0)
        # Legacy saved videos have no frame count. Re-check their bytes instead of
        # trusting a container duration or requiring a duplicate upload.
        import json

        legacy = {k: v for k, v in asset.items() if k != "frame_count"}
        legacy["duration"] = 10
        with client.app.state.store.connection() as conn:
            conn.execute("UPDATE assets SET body=? WHERE id=?", (json.dumps(legacy), asset["id"]))
        response = client.post(
            "/api/jobs",
            json={
                "feature": "restyle-video",
                "source_id": asset["id"],
                "settings": {"instruction": "Watercolor"},
                "request_id": "legacy",
            },
        )
        assert response.status_code == expected


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg needed"
)
def test_mp4_roundtrip_ranges_and_media_type_validation(tmp_path):
    path = tmp_path / "fixture.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x64:r=12:d=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        timeout=20,
        capture_output=True,
    )
    with TestClient(
        create_app(Settings(data_dir=tmp_path / "data"), run_worker=False),
        base_url="http://127.0.0.1",
    ) as c:
        response = c.post(
            "/api/assets", files={"file": ("movie.mp4", path.read_bytes(), "video/mp4")}
        )
        assert response.status_code == 201
        asset = response.json()
        assert asset["media_type"] == "video/mp4" and asset["fps"] == 24
        assert asset["duration"] == pytest.approx(2, abs=0.1)
        partial = c.get(asset["url"], headers={"Range": "bytes=0-99"})
        assert partial.status_code == 206 and len(partial.content) == 100
        assert partial.headers["content-type"] == "video/mp4"
        bad_job = c.post(
            "/api/jobs",
            json={
                "feature": "remove-background",
                "source_id": asset["id"],
                "settings": {},
                "request_id": "bad",
            },
        )
        assert bad_job.status_code == 422
        assert (
            c.post(
                "/api/assets", files={"file": ("fake.mp4", b"not a movie", "video/mp4")}
            ).status_code
            == 422
        )
