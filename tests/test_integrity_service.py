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
    service = module.IntegrityService(None, None, lambda: "unknown", queue_epoch=lambda: ("queue", 0))
    assert service.submit("a") == ("unavailable", None)
    states = iter(["idle", "idle", "active"])
    service = module.IntegrityService(None, None, lambda: next(states), queue_epoch=lambda: ("queue", 0))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "unavailable"


def test_snapshot_is_not_ready_and_failure_enforces_cooldown(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    resolved.path.write_bytes(b"data")
    file_identity = module._identity(resolved.path.stat())
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified", file_identity))
    service = module.IntegrityService(None, None, lambda: "idle", queue_epoch=lambda: ("queue", 0))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "checksum_matched"
    resolved.path.write_bytes(b"changed")
    assert service.status(job) == "changed"
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("hash_mismatch"))
    status, job = service.submit("a")
    assert status == "accepted"
    assert wait_terminal(service, job) == "hash_mismatch"
    assert service.submit("a") == ("cooldown", None)



def test_absent_or_changed_manager_epoch_blocks_historical_match(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    resolved.path.write_bytes(b"data")
    file_identity = module._identity(resolved.path.stat())
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified", file_identity))
    service = module.IntegrityService(None, None, lambda: "idle")
    assert service.submit("a") == ("unavailable", None)
    epoch = [0]
    service = module.IntegrityService(None, None, lambda: "idle", queue_epoch=lambda: ("queue", epoch[0]))
    accepted, job = service.submit("a")
    assert accepted == "accepted"
    assert wait_terminal(service, job) == "checksum_matched"
    assert service.status_detail(job)["checked_at"]
    epoch[0] += 1
    assert service.status(job) == "changed"
    # In-memory records are not restored by a new helper instance.
    fresh = module.IntegrityService(None, None, lambda: "idle", queue_epoch=lambda: ("queue", epoch[0]))
    assert fresh.status(job) is None


def test_manager_activity_during_hash_cannot_publish_a_match(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    resolved.path.write_bytes(b"data")
    identity = module._identity(resolved.path.stat())
    epoch = [0]
    def changed_during_hash(*_args, **_kwargs):
        # Models an install that starts and finishes between two idle reads.
        epoch[0] += 1
        return Verification("verified", identity)
    monkeypatch.setattr(module, "verify_identity", changed_during_hash)
    service = module.IntegrityService(None, None, lambda: "idle", queue_epoch=lambda: ("queue", epoch[0]))
    accepted, job = service.submit("a")
    assert accepted == "accepted"
    assert wait_terminal(service, job) == "unavailable"


def test_equal_metadata_does_not_change_historical_wording(tmp_path, monkeypatch):
    resolved = Resolved("resolved", tmp_path / "model", 4, "a", "model")
    monkeypatch.setattr(module, "resolve_loader_choice", lambda *_: resolved)
    resolved.path.write_bytes(b"data")
    original_identity = module._identity(resolved.path.stat())
    monkeypatch.setattr(module, "verify_identity", lambda *_, **__: Verification("verified", original_identity))
    service = module.IntegrityService(None, None, lambda: "idle", queue_epoch=lambda: ("queue", 0))
    accepted, job = service.submit("a")
    assert accepted == "accepted"
    assert wait_terminal(service, job) == "checksum_matched"
    # Demonstrate the documented coarse-metadata limitation: the response
    # describes a past check and never claims the current bytes are verified.
    resolved.path.write_bytes(b"evil")
    monkeypatch.setattr(module, "_identity", lambda _info: original_identity)
    result = service.status_detail(job)
    assert result["state"] == "checksum_matched"
    assert "checked_at" in result
    assert "current_verified" not in result
