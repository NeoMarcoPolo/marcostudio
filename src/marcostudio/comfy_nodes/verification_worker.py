"""Bounded offline scheduling for already-authorized model verification.

This is not an HTTP endpoint or a readiness decision. A completed verification
is a point-in-time observation, not proof the loader will use unchanged bytes.
The caller is responsible for trusted metadata and exact path resolution.
"""

import logging
import secrets
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .model_verify import Verification, verify_file


@dataclass
class _Job:
    identity: str
    path: Path
    size: int
    digest: str
    id: str = field(default_factory=lambda: secrets.token_urlsafe(18))
    state: str = "queued"
    observation: Verification | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)


class VerificationWorker:
    """One active hash and at most one queued hash, with cooperative cancel."""

    def __init__(self, verifier: Callable = verify_file):
        self._lock = threading.Lock()
        self._verifier = verifier
        self._active: _Job | None = None
        self._pending: _Job | None = None
        self._results: dict[str, _Job] = {}

    def submit(self, identity: str, path: Path, size: int, digest: str) -> tuple[str, str | None]:
        # Dedup only byte-identical work. Caller must establish authorization.
        with self._lock:
            for job in (self._active, self._pending):
                if job and not job.cancelled.is_set() and (job.identity, job.path, job.size, job.digest) == (identity, path, size, digest):
                    return "accepted", job.id
            if self._active and self._pending:
                return "busy", None
            job = _Job(identity, path, size, digest)
            # Bounded history lets a caller observe multiple models while
            # preventing unbounded growth. Live jobs are never evicted.
            while len(self._results) >= 32:
                oldest = next((key for key, value in self._results.items() if value is not self._active and value is not self._pending), None)
                if oldest is None:
                    return "busy", None
                self._results.pop(oldest)
            self._results[job.id] = job
            if self._active is None:
                self._active = job
                job.state = "running"
                threading.Thread(target=self._run, args=(job,), daemon=True).start()
            else:
                self._pending = job
            return "accepted", job.id

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._results.get(job_id)
            if not job or job.state not in {"running", "queued"}:
                return False
            job.cancelled.set()
            if job is self._pending:
                job.state = "cancelled"
                self._pending = None
            return True

    def status(self, job_id: str) -> str | None:
        with self._lock:
            job = self._results.get(job_id)
            return job.state if job else None

    def observation(self, job_id: str):
        """Internal snapshot only; do not expose paths or metadata to clients."""
        with self._lock:
            job = self._results.get(job_id)
            if not job or job.state != "checksum_matched" or job.observation is None:
                return None
            return job.identity, job.path, job.size, job.digest, job.observation

    def _run(self, job: _Job) -> None:
        try:
            result = self._verifier(job.path, job.size, job.digest, cancelled=job.cancelled.is_set)
            state = result.status if isinstance(result, Verification) else "unavailable"
        except (Exception, SystemExit):
            # A failed verifier must not become success or leak local paths.
            logging.warning("MarcoStudio model verification worker failed")
            state = "unavailable"
        with self._lock:
            # Publish and cancel synchronize under the same lock.
            job.state = "cancelled" if job.cancelled.is_set() else state
            job.observation = result if job.state == "checksum_matched" else None
            next_job = self._pending
            self._pending = None
            self._active = next_job
            if next_job:
                next_job.state = "running"
                threading.Thread(target=self._run, args=(next_job,), daemon=True).start()
