"""Fail-closed observer for an already-imported ComfyUI Manager 4 queue."""

import hashlib
import inspect
import logging
import sys
from importlib import metadata

# Manager 4.2.2's TaskQueue implementation was inspected: current_index
# increments on put and task_counter on retrieval, under the same mutex.
# Unknown versions or modified queue implementations cannot provide a witness.
_SUPPORTED_VERSION = "4.2.2"
_QUEUE_SOURCE_SHA256 = "64da8d4b5179dad94648d15fb285d73f8b9eb4d82be839b8c9d2ad977a33e9f1"


def _manager_supported(module, queue):
    try:
        cls = type(queue)
        if (metadata.version("comfyui-manager") != _SUPPORTED_VERSION
                or getattr(module, "TaskQueue", None) is not cls
                or cls.__module__ != "comfyui_manager.glob.manager_server"):
            return False
        source = inspect.getsource(cls).rstrip().encode("utf-8")
        return hashlib.sha256(source).hexdigest() == _QUEUE_SOURCE_SHA256
    except (metadata.PackageNotFoundError, OSError, TypeError, ValueError):
        return False


def manager_queue_state():
    # Never import Manager here: importing can initialize it or terminate the
    # host process. Unknown versions/absent Manager remain unverified.
    module = sys.modules.get("comfyui_manager.glob.manager_server")
    queue = getattr(module, "task_queue", None)
    if queue is None or not _manager_supported(module, queue):
        return "unknown"
    try:
        with queue.mutex:
            pending = queue.pending_tasks
            running = queue.running_tasks
            processing = queue.is_processing()
            if not isinstance(pending, list) or not isinstance(running, dict) or type(processing) is not bool:
                return "unknown"
            return "active" if pending or running or processing else "idle"
    except (AttributeError, TypeError, RuntimeError):
        logging.warning("MarcoStudio could not inspect the Manager queue")
        return "unknown"


def manager_queue_epoch():
    """Return a local Manager 4 activity witness only while its queue is idle.

    The manager's current_index increments on every put and task_counter on
    retrieval. Retain the queue object itself so a replaced instance cannot
    be mistaken for the previous queue even if allocator IDs are reused.
    """
    module = sys.modules.get("comfyui_manager.glob.manager_server")
    queue = getattr(module, "task_queue", None)
    if queue is None or not _manager_supported(module, queue):
        return None
    try:
        with queue.mutex:
            if (not isinstance(queue.pending_tasks, list) or not isinstance(queue.running_tasks, dict)
                    or type(queue.current_index) is not int or type(queue.task_counter) is not int
                    or queue.current_index < 0 or queue.task_counter < 0):
                return None
            processing = queue.is_processing()
            if type(processing) is not bool or queue.pending_tasks or queue.running_tasks or processing:
                return None
            return (queue, queue.current_index, queue.task_counter)
    except (AttributeError, TypeError, RuntimeError):
        logging.warning("MarcoStudio could not inspect Manager queue history")
        return None
