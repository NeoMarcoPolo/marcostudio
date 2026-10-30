import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1]
NODES = ROOT / "src/marcostudio/comfy_nodes"
package = ModuleType("resolve_test_nodes")
package.__path__ = [str(NODES)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("resolve_test_nodes.integrity_resolution", NODES / "integrity_resolution.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_trusted_catalog_matches_frontend_by_deep_equality():
    catalog = json.loads((ROOT / "frontend/src/browser/catalog.json").read_text(encoding="utf-8"))
    expected = {}
    for feature in catalog["features"]:
        for models in feature["models"].values():
            for model in models:
                entry = (model["filename"], model["category"], model["size"])
                assert model["sha256"] not in expected or expected[model["sha256"]] == entry
                expected[model["sha256"]] = entry
    assert module.MODELS == expected


def test_resolve_tracks_loader_choice_and_blocks_ambiguous_and_invalid(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MODELS", {"id": ("model.bin", "test", 10)})
    class Paths:
        choices = ["sub/model.bin"]
        def get_filename_list(self, category):
            assert category == "test"
            return self.choices[:]
        def get_full_path(self, category, choice):
            return str(tmp_path / choice)
    paths = Paths()
    got = module.resolve("id", paths)
    assert got.status == "resolved" and got.choice == "sub/model.bin" and got.size == 10
    paths.choices = ["a/model.bin", "b/model.bin"]
    assert module.resolve("id", paths).status == "ambiguous"
    paths.choices = ["../model.bin"]
    assert module.resolve("id", paths).status == "unavailable"
    assert module.resolve("unknown", paths).status == "unavailable"


def test_resolve_rejects_changed_lookup(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MODELS", {"id": ("model.bin", "test", 10)})
    class Paths:
        count = 0
        def get_filename_list(self, category):
            self.count += 1
            return ["model.bin"] if self.count == 1 else []
        def get_full_path(self, category, choice):
            return str(tmp_path / choice)
    assert module.resolve("id", Paths()).status == "changed"
