import json
import re
from pathlib import Path
from zipfile import ZipFile

from marcostudio.browser_export import CATALOG, NODE_BUNDLE, build_catalog, export_nodes
from marcostudio.features import FEATURES


def resolve(value, context):
    if isinstance(value, dict):
        if "$param" in value:
            result = context
            for key in value["$param"].split("."):
                result = result[int(key)] if isinstance(result, list) else result[key]
            return result
        return {key: resolve(item, context) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, context) for item in value]
    return value


def test_catalog_matches_compilers_and_contains_no_machine_paths():
    catalog = build_catalog()
    assert json.loads(CATALOG.read_text(encoding="utf-8")) == catalog
    assert not re.search(r"[A-Za-z]:[\\/](?!/)|/Users/|/home/", json.dumps(catalog))
    for item in catalog["features"]:
        feature = FEATURES[item["id"]]
        for variant in item["variants"]:
            values = {"mode": variant["mode"], "seed": 173}
            fields = feature.settings.model_fields
            if "instruction" in fields:
                values.update(instruction="A river beneath a blue sky.", width=640, height=384)
            if "duration" in fields:
                values["duration"] = 3
            if "guide_frames" in fields:
                values["guide_frames"] = [12 * (i + 1) for i in range(len(variant["slots"]))]
            if "control_type" in fields:
                values.update(control_type=variant["control"], strength=0.7)
            settings = feature.settings(**values)
            models = {model.key: f"shared/{model.filename}" for model in feature.models_for(settings.mode)}
            inputs = {key: f"{key}.png" for key in variant["slots"]}
            source = None if feature.source_kind == "none" else "source.mp4" if feature.source_kind == "video" else "source.png"
            parameters = settings.model_dump()
            if "duration" in fields:
                parameters.update(frames=settings.frames, actual_duration=settings.actual_duration)
            actual = resolve(variant["graph"], {
                "settings": parameters, "source": source, "inputs": inputs,
                "prefix": "MarcoStudio/test", "models": models, "prompt": settings.prompt(),
            })
            expected = feature.compile(settings, source, "MarcoStudio/test", models, inputs=inputs)
            assert actual == expected, (feature.id, variant["mode"], variant["slots"])
            assert all(not model["url"].endswith("/main") for model in item["models"][settings.mode])


def test_manual_node_bundle_matches_source_and_is_reproducible(tmp_path):
    expected = tmp_path / "nodes.zip"
    export_nodes(expected)
    assert expected.read_bytes() == NODE_BUNDLE.read_bytes()
    with ZipFile(expected) as bundle:
        assert set(bundle.namelist()) == {
            "marcostudio/__init__.py", "marcostudio/h3.py", "marcostudio/LICENSE", "marcostudio/README.md",
            "marcostudio/model_storage.py", "marcostudio/model_verify.py", "marcostudio/storage_catalog.py",
            "marcostudio/integrity_catalog.py", "marcostudio/integrity_check.py", "marcostudio/integrity_loader.py",
            "marcostudio/integrity_manager.py", "marcostudio/integrity_resolution.py", "marcostudio/integrity_routes.py",
            "marcostudio/integrity_service.py", "marcostudio/verification_worker.py",
            "marcostudio/storage_pairing.py", "marcostudio/storage_routes.py",
            "marcostudio/model_storage_windows.py", "marcostudio/storage_pairing_windows.py",
            "marcostudio/.marcostudio-nodes",
        }
        assert b"source_fps" in bundle.read("marcostudio/h3.py")


def test_local_node_installer_includes_pairing_components(tmp_path):
    from marcostudio.comfy.install import install_nodes

    (tmp_path / "main.py").write_text("# test ComfyUI\n")
    destination = install_nodes(tmp_path)
    for name in ("storage_pairing.py", "storage_routes.py", "storage_catalog.py", "model_storage.py", "README.md"):
        source = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes" / name
        assert (destination / name).read_bytes() == source.read_bytes()
