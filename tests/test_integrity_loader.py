import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1]
NODES = ROOT / "src/marcostudio/comfy_nodes"
package = ModuleType("loader_test_nodes")
package.__path__ = [str(NODES)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("loader_test_nodes.integrity_loader", NODES / "integrity_loader.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_loader_catalog_matches_frontend():
    catalog = json.loads((ROOT / "frontend/src/browser/catalog.json").read_text(encoding="utf-8"))
    expected = {}
    for feature in catalog["features"]:
        for models in feature["models"].values():
            for model in models:
                entry = (model["loader"], model["field"])
                assert model["sha256"] not in expected or expected[model["sha256"]] == entry
                expected[model["sha256"]] = entry
    assert module.LOADERS == expected


def test_loader_selection_must_match_resolver(tmp_path, monkeypatch):
    identity = next(iter(module.MODELS))
    name = module.MODELS[identity][0]
    loader, field = module.LOADERS[identity]
    class Paths:
        def get_filename_list(self, _category):
            return ["sub/" + name]
        def get_full_path(self, _category, choice):
            return str(tmp_path / choice)
    class Loader:
        choices = ["sub/" + name]
        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {field: (cls.choices,)}}
    assert module.resolve_loader_choice(identity, Paths(), {loader: Loader}).status == "resolved"
    Loader.choices = [name]
    assert module.resolve_loader_choice(identity, Paths(), {loader: Loader}).status == "changed"
    Loader.choices = ["a/" + name, "b/" + name]
    assert module.resolve_loader_choice(identity, Paths(), {loader: Loader}).status == "ambiguous"
    assert module.resolve_loader_choice(identity, Paths(), {}).status == "unavailable"
