"""Offline bounded integrity service; no network endpoint or readiness claim."""

import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .integrity_check import verify_identity
from .integrity_loader import resolve_loader_choice
from .model_verify import Verification, _identity
from .verification_worker import VerificationWorker


class IntegrityService:
    """Coordinate trusted resolution, queue observations and bounded hashing.

    The queue observer must return exactly ``idle`` when it has authoritatively
    checked the manager; any other value fails closed. Observations at two
    instants cannot prove the queue was idle in between. The result is therefore
    named checksum_matched. It reports a historical check only; consumers must
    not describe it as proof that the current bytes are unchanged.
    """
    def __init__(self, folder_paths, node_mapping, queue_observer, *, queue_epoch=None, cooldown=300, clock=time.monotonic):
        self._folder_paths = folder_paths
        self._node_mapping = node_mapping
        self._queue_observer = queue_observer
        self._queue_epoch = queue_epoch
        self._evidence = {}
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
        if not self._idle() or self._epoch() is None:
            return "unavailable", None
        result = resolve_loader_choice(identity, self._folder_paths, self._node_mapping)
        if result.status != "resolved":
            return result.status, None
        with self._lock:
            failed_at = self._failed.get(identity)
            if failed_at is not None and self._clock() - failed_at < self._cooldown:
                return "cooldown", None
        with self._lock:
            self._evidence.pop(identity, None)
        return self._worker.submit(identity, result.path, result.size, result.digest)

    def _epoch(self):
        if self._queue_epoch is None:
            return None
        try:
            return self._queue_epoch()
        except Exception:
            logging.warning("MarcoStudio could not check Manager queue history")
            return None

    def status(self, job_id):
        return self.status_detail(job_id)["state"]

    def status_detail(self, job_id):
        state = self._worker.status(job_id)
        if state != "checksum_matched":
            return {"state": state}
        observation = self._worker.observation(job_id)
        if observation is None or not self._idle():
            return {"state": "unavailable"}
        identity, path, size, digest, result = observation
        with self._lock:
            evidence = self._evidence.get(identity)
        epoch = self._epoch()
        if evidence is None or epoch is None or evidence[0] != epoch or evidence[1] != result.identity:
            return {"state": "changed"}
        resolved = resolve_loader_choice(identity, self._folder_paths, self._node_mapping)
        if resolved.status != "resolved" or (resolved.path, resolved.size, resolved.digest) != (path, size, digest):
            return {"state": "changed"}
        try:
            # Metadata mismatch invalidates historical evidence. A match is
            # NOT treated as proof of what bytes are present now.
            if result.identity is None or _identity(path.stat()) != result.identity:
                return {"state": "changed"}
        except OSError:
            return {"state": "changed"}
        if self._epoch() != epoch:
            return {"state": "changed"}
        return {"state": "checksum_matched", "checked_at": evidence[2]}

    def is_busy(self):
        return self._worker.is_busy()

    def cancel(self, job_id):
        return self._worker.cancel(job_id)

    def _verify(self, path: Path, size: int, digest: str, *, cancelled):
        epoch = self._epoch()
        before = resolve_loader_choice(digest, self._folder_paths, self._node_mapping)
        if epoch is None or not self._idle() or before.status != "resolved" or (before.path, before.size, before.digest) != (path, size, digest):
            return Verification("unavailable")
        result = verify_identity(digest, self._folder_paths, cancelled=cancelled)
        after = resolve_loader_choice(digest, self._folder_paths, self._node_mapping)
        if cancelled():
            return Verification("cancelled")
        if result.status == "verified" and after == before and self._idle() and self._epoch() == epoch:
            checked_at = datetime.now(timezone.utc).isoformat()
            with self._lock:
                self._evidence[digest] = (epoch, result.identity, checked_at)
            return Verification("checksum_matched", result.identity)
        if result.status in {"size_mismatch", "hash_mismatch", "changed"}:
            with self._lock:
                self._failed[digest] = self._clock()
        return Verification(result.status if result.status != "verified" else "unavailable")
