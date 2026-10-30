import importlib.util
import sys
import threading
import time
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
package = ModuleType("worker_test_nodes")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("worker_test_nodes.verification_worker", ROOT / "verification_worker.py")
worker_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker_module
spec.loader.exec_module(worker_module)
Verification = sys.modules["worker_test_nodes.model_verify"].Verification


def wait_until(predicate):
    limit = time.monotonic() + 3
    while not predicate():
        if time.monotonic() > limit:
            raise AssertionError("worker did not reach expected state")
        time.sleep(.01)


def test_bounded_queue_deduplicates_and_cancellation_waits_for_worker_exit(tmp_path):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def verifier(path, size, digest, *, cancelled):
        calls.append(path)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
        return Verification("verified")

    worker = worker_module.VerificationWorker(verifier)
    first = worker.submit("a", tmp_path / "a", 1, "x")
    assert entered.wait(3)
    assert worker.submit("a", tmp_path / "a", 1, "x") == first
    second = worker.submit("b", tmp_path / "b", 1, "y")
    assert worker.submit("c", tmp_path / "c", 1, "z") == ("busy", None)
    assert worker.cancel(first[1])
    assert worker.status(first[1]) == "running"
    assert worker.status(second[1]) == "queued"
    release.set()
    wait_until(lambda: worker.status(second[1]) == "verified")
    assert worker.status(first[1]) == "cancelled"
    assert calls == [tmp_path / "a", tmp_path / "b"]


def test_cancel_queued_work_does_not_execute(tmp_path):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def verifier(path, size, digest, *, cancelled):
        calls.append(path)
        entered.set()
        assert release.wait(3)
        return Verification("verified")
    worker = worker_module.VerificationWorker(verifier)
    first = worker.submit("a", tmp_path / "a", 1, "x")
    assert entered.wait(3)
    second = worker.submit("b", tmp_path / "b", 1, "y")
    assert worker.cancel(second[1])
    release.set()
    wait_until(lambda: worker.status(first[1]) == "verified")
    assert calls == [tmp_path / "a"]
    assert worker.status(second[1]) == "cancelled"
