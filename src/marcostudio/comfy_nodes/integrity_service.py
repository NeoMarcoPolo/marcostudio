"""Offline bounded integrity service; no network endpoint or readiness claim."""

import logging
import threading
import time
from pathlib import Path

from .integrity_check import verify_identity
from .integrity_loader import resolve_loader_choice
from .model_verify import Verification
from .verification_worker import VerificationWorker


class IntegrityService:
    """Coordinate trusted resolution, queue observations and bounded hashing.

    The queue observer must return exactly ``idle`` when it has authoritatively
    checked the manager; any other value fails closed. Observations at two
    instants cannot prove the queue was idle in between. The result is therefore
    named snapshot_verified and must not be presented as Ready.
    """
    def __init__(self, folder_paths, node_mapping, queue_observer, *, cooldown=300, clock=time.monotonic):
        self._folder_paths = folder_paths
        self._node_mapping = node_mapping
        self._queue_observer = queue_observer
        self._clock = clock
        self._cooldown = cooldown
        self._failed = {}
        self._lock = threading.Lock()
        self._worker = VerificationWorker(self._verify)

    def _idle(self):
        try:
            return self._queue_observer() == "idle"
        except Exception:
            logging.warning("MarcoStudio could not check the Manager queue")
            return False

    def submit(self, identity):
        if not self._idle():
            return "unavailable", None
        result = resolve_loader_choice(identity, self._folder_paths, self._node_mapping)
        if result.status != "resolved":
            return result.status, None
        with self._lock:
            failed_at = self._failed.get(identity)
            if failed_at is not None and self._clock() - failed_at < self._cooldown:
                return "cooldown", None
        return self._worker.submit(identity, result.path, result.size, result.digest)

    def status(self, job_id):
        return self._worker.status(job_id)

    def cancel(self, job_id):
        return self._worker.cancel(job_id)

    def _verify(self, path: Path, size: int, digest: str, *, cancelled):
        before = resolve_loader_choice(digest, self._folder_paths, self._node_mapping)
        if not self._idle() or before.status != "resolved" or (before.path, before.size, before.digest) != (path, size, digest):
            return Verification("unavailable")
        result = verify_identity(digest, self._folder_paths, cancelled=cancelled)
        after = resolve_loader_choice(digest, self._folder_paths, self._node_mapping)
        if cancelled():
            return Verification("cancelled")
        if result.status == "verified" and after == before and self._idle():
            return Verification("snapshot_verified")
        if result.status in {"size_mismatch", "hash_mismatch", "changed"}:
            with self._lock:
                self._failed[digest] = self._clock()
        return Verification(result.status if result.status != "verified" else "unavailable")
