import json
import re
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
            "marcostudio/__init__.py", "marcostudio/h3.py", "marcostudio/LICENSE",
            "marcostudio/.marcostudio-nodes",
        }
        assert b"source_fps" in bundle.read("marcostudio/h3.py")
