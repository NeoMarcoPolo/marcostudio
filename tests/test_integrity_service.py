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
    monkeypatch.setattr(module, "supports_identity_cache", lambda: True)
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
    # Positive control models a separately proven filesystem; production
    # currently has no such implementation and fails closed.
    monkeypatch.setattr(module, "supports_identity_cache", lambda: True)
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    resolved.path.write_bytes(b"data")
    file_identity = module._identity(resolved.path.stat())
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified", file_identity))
    service = module.IntegrityService(None, None, lambda: "idle")
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "snapshot_verified"
    resolved.path.write_bytes(b"changed")
    assert service.status(job) == "changed"
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("hash_mismatch"))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "hash_mismatch"
    assert service.submit("a") == ("cooldown", None)


def test_unproven_filesystem_never_reuses_hash_or_starts_work(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    monkeypatch.setattr(module, "supports_identity_cache", lambda: False)
    calls = []
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: calls.append(1))
    service = module.IntegrityService(None, None, lambda: "idle")
    assert service.submit("a") == ("unavailable", None)
    assert calls == []
    # A previously produced success cannot be replayed after the filesystem
    # capability becomes unknown or unsupported.
    monkeypatch.setattr(service._worker, "status", lambda _job: "snapshot_verified")
    assert service.status("old-job") == "unavailable"
