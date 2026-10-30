import importlib.util
import sys
import threading
from pathlib import Path
from types import ModuleType, SimpleNamespace

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
spec = importlib.util.spec_from_file_location("integrity_manager_test", ROOT / "integrity_manager.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_manager_queue_observer_requires_known_idle_queue(monkeypatch):
    key = "comfyui_manager.glob.manager_server"
    monkeypatch.delitem(sys.modules, key, raising=False)
    assert module.manager_queue_state() == "unknown"
    fake = ModuleType(key)
    queue = SimpleNamespace(mutex=threading.RLock(), pending_tasks=[], running_tasks={}, is_processing=lambda: False)
    fake.task_queue = queue
    monkeypatch.setitem(sys.modules, key, fake)
    assert module.manager_queue_state() == "idle"
    queue.pending_tasks = [object()]
    assert module.manager_queue_state() == "active"
    queue.pending_tasks = []
    queue.running_tasks = {1: object()}
    assert module.manager_queue_state() == "active"
    queue.running_tasks = {}
    queue.is_processing = lambda: True
    assert module.manager_queue_state() == "active"
    queue.is_processing = lambda: None
    assert module.manager_queue_state() == "unknown"
