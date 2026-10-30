"""Fail-closed observer for an already-imported ComfyUI Manager 4 queue."""

import logging
import sys


def manager_queue_state():
    # Never import Manager here: importing can initialize it or terminate the
    # host process. Unknown versions/absent Manager remain unverified.
    module = sys.modules.get("comfyui_manager.glob.manager_server")
    queue = getattr(module, "task_queue", None)
    if queue is None:
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
