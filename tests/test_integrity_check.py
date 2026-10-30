import hashlib
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
package = ModuleType("check_test_nodes")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("check_test_nodes.integrity_check", ROOT / "integrity_check.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
resolution = sys.modules["check_test_nodes.integrity_resolution"]


class Paths:
    def __init__(self, path):
        self.path = path
    def get_filename_list(self, _category):
        return ["model.bin"]
    def get_full_path(self, _category, _choice):
        return str(self.path)


@pytest.mark.skipif(os.name == "nt", reason="Windows identity guard is not yet supported")
def test_verify_bytes_and_detect_content_mismatch(tmp_path, monkeypatch):
    path = tmp_path / "model.bin"
    path.write_bytes(b"small fixture")
    identity = hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(resolution, "MODELS", {identity: ("model.bin", "test", path.stat().st_size)})
    paths = Paths(path)
    assert module.verify_identity(identity, paths).status == "verified"
    path.write_bytes(b"small fixturf")
    assert module.verify_identity(identity, paths).status == "hash_mismatch"


@pytest.mark.skipif(os.name == "nt", reason="Windows identity guard is not yet supported")
def test_reresolve_detects_path_replacement_after_verification(tmp_path, monkeypatch):
    path = tmp_path / "model.bin"
    path.write_bytes(b"fixture")
    identity = hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(resolution, "MODELS", {identity: ("model.bin", "test", path.stat().st_size)})
    paths = Paths(path)
    original = module.verify_file
    def replacement(*args, **kwargs):
        result = original(*args, **kwargs)
        other = tmp_path / "replacement"
        other.write_bytes(b"fixture")
        paths.path = other
        return result
    monkeypatch.setattr(module, "verify_file", replacement)
    assert module.verify_identity(identity, paths).status == "changed"
