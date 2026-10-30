import importlib.util
import sys
import time
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
package = ModuleType("service_test_nodes")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("service_test_nodes.integrity_service", ROOT / "integrity_service.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
Resolved = sys.modules["service_test_nodes.integrity_resolution"].Resolved
Verification = sys.modules["service_test_nodes.model_verify"].Verification


def wait_terminal(service, job):
    deadline = time.monotonic() + 3
    while service.status(job) in {"queued", "running"}:
        assert time.monotonic() < deadline
        time.sleep(.01)
    return service.status(job)


def test_queue_unknown_and_changed_fail_closed(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified"))
    service = module.IntegrityService(None, None, lambda: "unknown")
    assert service.submit("a") == ("unavailable", None)
    states = iter(["idle", "idle", "active"])
    service = module.IntegrityService(None, None, lambda: next(states))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "unavailable"


def test_snapshot_is_not_ready_and_failure_enforces_cooldown(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified"))
    service = module.IntegrityService(None, None, lambda: "idle")
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "snapshot_verified"
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("hash_mismatch"))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "hash_mismatch"
    assert service.submit("a") == ("cooldown", None)
