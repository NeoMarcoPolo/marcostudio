import json
import struct
from dataclasses import replace

import httpx
import pytest


def test_extra_model_paths_and_duplicate_basenames(tmp_path):
    from marcostudio.comfy.model_paths import model_roots, resolve_model
    from marcostudio.config import Settings

    comfy = tmp_path / "Comfy UI"
    (comfy / "models" / "loras").mkdir(parents=True)
    models = tmp_path / "モデル"
    (models / "loras" / "relight").mkdir(parents=True)
    target = models / "loras" / "relight" / "light.safetensors"
    target.write_bytes(b"x")
    extra = tmp_path / "paths.yaml"
    extra.write_text(
        "custom:\n  base_path: モデル\n  is_default: true\n  loras: loras\n", encoding="utf-8"
    )
    config = Settings(comfy_dir=comfy, data_dir=tmp_path / "data", extra_model_paths=[extra])
    roots = model_roots(config)
    assert resolve_model(roots["loras"], "relight/light.safetensors") == target.resolve()
    assert roots["loras"][0] == (models / "loras").resolve()


def test_loader_selection_requires_unambiguous_identity():
    from marcostudio.comfy.model_paths import select_loader

    with pytest.raises(ValueError, match="ambiguous"):
        select_loader(["one/a.safetensors", "two/a.safetensors"], "a.safetensors")
    assert select_loader(["one\\a.safetensors"], "a.safetensors") == "one\\a.safetensors"
    with pytest.raises(ValueError):
        select_loader(["a.safetensors"], "a.safetensors", "../a.safetensors")


def test_default_path_order_matches_native_insertion(tmp_path):
    from marcostudio.comfy.model_paths import model_roots
    from marcostudio.config import Settings

    file = tmp_path / "extra.yaml"
    file.write_text("custom:\n  is_default: true\n  loras: |\n    first\n    second\n")
    roots = model_roots(Settings(extra_model_paths=[file]))
    assert roots["loras"] == [tmp_path / "second", tmp_path / "first"]


@pytest.mark.parametrize("offsets", [None, 42, "00", [0]])
def test_malformed_tensor_metadata_is_a_named_validation_error(tmp_path, offsets):
    from marcostudio.comfy.model_paths import inspect_model
    from marcostudio.features.relight.manifest import MODELS

    path = tmp_path / "model.safetensors"
    header = json.dumps({"w": {"dtype": "F32", "shape": [1], "data_offsets": offsets}}).encode()
    path.write_bytes(struct.pack("<Q", len(header)) + header + b"\0" * 4)
    with pytest.raises(ValueError, match="offsets"):
        inspect_model(path, replace(MODELS[0], size=path.stat().st_size), False)


def test_node_validation_checks_enums_and_numeric_ranges():
    from marcostudio.comfy.doctor import validate_inputs

    node = {"class_type": "KSampler", "inputs": {"sampler_name": "euler", "steps": 4}}
    definition = {
        "input": {
            "required": {"sampler_name": [["heun"]], "steps": ["INT", {"min": 1, "max": 100}]}
        }
    }
    with pytest.raises(ValueError, match="sampler_name"):
        validate_inputs(node, definition)
    definition["input"]["required"]["sampler_name"] = [["euler"]]
    definition["input"]["required"]["steps"][1]["min"] = 8
    with pytest.raises(ValueError, match="steps"):
        validate_inputs(node, definition)


def test_header_size_and_digest_checks_detect_corruption(tmp_path):
    from marcostudio.comfy.model_paths import inspect_model
    from marcostudio.features.relight.manifest import MODELS

    file = tmp_path / "model.safetensors"
    header = json.dumps({"w": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    file.write_bytes(struct.pack("<Q", len(header)) + header + b"\0" * 4)
    model = replace(MODELS[0], size=file.stat().st_size, sha256="0" * 64)
    assert inspect_model(file, model, False)["hash_verified"] is False
    with pytest.raises(ValueError, match="SHA256"):
        inspect_model(file, model, True)
    file.write_bytes(struct.pack("<Q", 999999999))
    with pytest.raises(ValueError):
        inspect_model(file, replace(model, size=8), False)


@pytest.mark.asyncio
async def test_unreachable_runtime_is_not_ready_and_does_not_write(tmp_path):
    from marcostudio.comfy.doctor import diagnose
    from marcostudio.config import Settings

    def offline(request):
        raise httpx.ConnectError("offline", request=request)

    config = Settings(data_dir=tmp_path / "not-created")
    async with httpx.AsyncClient(transport=httpx.MockTransport(offline)) as client:
        report = await diagnose(config, client=client)
    assert not report["ready"]
    assert any("unreachable" in c["message"].lower() for c in report["checks"])
    assert not config.data_dir.exists()
