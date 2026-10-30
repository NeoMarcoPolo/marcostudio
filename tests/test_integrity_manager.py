import hashlib
import importlib.util
import sys
import threading
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
spec = importlib.util.spec_from_file_location("integrity_manager_test", ROOT / "integrity_manager.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_manager_queue_observer_rejects_unknown_versions_and_changed_semantics(monkeypatch):
    key = "comfyui_manager.glob.manager_server"
    monkeypatch.delitem(sys.modules, key, raising=False)
    assert module.manager_queue_state() == "unknown"
    fake = ModuleType(key)
    class Queue:
        __module__ = key
        def __init__(self):
            self.mutex = threading.RLock()
            self.pending_tasks = []
            self.running_tasks = {}
            self.current_index = 0
            self.task_counter = 0
        def is_processing(self):
            return False
    queue = Queue()
    fake.TaskQueue = Queue
    fake.task_queue = queue
    monkeypatch.setitem(sys.modules, key, fake)
    source = ["vetted manager queue source"]
    monkeypatch.setattr(module.metadata, "version", lambda _name: "4.2.2")
    monkeypatch.setattr(module.inspect, "getsource", lambda _cls: source[0])
    monkeypatch.setattr(module, "_QUEUE_SOURCE_SHA256", hashlib.sha256(source[0].encode()).hexdigest())
    assert module.manager_queue_state() == "idle"
    first = module.manager_queue_epoch()
    assert first is not None
    queue.current_index += 1
    assert module.manager_queue_epoch() != first
    queue.pending_tasks = [object()]
    assert module.manager_queue_state() == "active"
    assert module.manager_queue_epoch() is None
    queue.pending_tasks = []
    queue.running_tasks = {1: object()}
    assert module.manager_queue_state() == "active"
    queue.running_tasks = {}
    queue.is_processing = lambda: True
    assert module.manager_queue_state() == "active"
    queue.is_processing = lambda: None
    assert module.manager_queue_state() == "unknown"
    queue.is_processing = lambda: False
    # A queue from the same package version whose put/get semantics differ is
    # untrusted even if it exposes the same counters and appears idle.
    source[0] = "incompatible queue that never increments counters"
    assert module.manager_queue_state() == "unknown"
    assert module.manager_queue_epoch() is None
    source[0] = "vetted manager queue source"
    monkeypatch.setattr(module.metadata, "version", lambda _name: "4.2.3")
    assert module.manager_queue_state() == "unknown"
    assert module.manager_queue_epoch() is None
