from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

TERMINAL = {"succeeded", "failed", "cancelled", "abandoned"}


def now() -> str:
    return datetime.now(UTC).isoformat()


def atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Store:
    def __init__(self, data_dir: Path):
        self.root = data_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("assets", "originals", "receipts"):
            (self.root / name).mkdir(exist_ok=True)
        self.database = self.root / "studio.sqlite3"
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(
                    id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
            """)

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.database, timeout=30)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def asset(self, asset_id: str) -> dict:
        with self.connection() as conn:
            row = conn.execute("SELECT body FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not row:
            raise KeyError("Asset not found")
        return json.loads(row[0])

    def add_asset(self, body: dict) -> dict:
        with self.connection() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO assets VALUES (?,?)", (body["id"], json.dumps(body))
            )
        return self.asset(body["id"])

    def job(self, job_id: str) -> dict:
        with self.connection() as conn:
            row = conn.execute("SELECT body FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise KeyError("Job not found")
        return json.loads(row[0])

    def jobs(self) -> list[dict]:
        with self.connection() as conn:
            rows = conn.execute("SELECT body FROM jobs ORDER BY rowid DESC").fetchall()
        return [json.loads(row[0]) for row in rows]

    def create_job(self, source_id: str, settings: dict, request_id: str) -> dict:
        self.asset(source_id)
        if (
            not 1 <= len(request_id) <= 128
            or not request_id.isascii()
            or not request_id.isprintable()
        ):
            raise ValueError("request_id must be 1–128 printable ASCII characters")
        fingerprint = hashlib.sha256(
            json.dumps([source_id, settings], sort_keys=True).encode()
        ).hexdigest()
        stamp, job_id = now(), str(uuid.uuid4())
        body = {
            "id": job_id,
            "feature": "relight",
            "request_id": request_id,
            "settings": settings,
            "source_id": source_id,
            "status": "preparing",
            "outputs": [],
            "error": None,
            "created_at": stamp,
            "updated_at": stamp,
            "progress": None,
            "elapsed_seconds": None,
            "queue_seconds": None,
            "upstream_id": None,
            "output_prefix": f"marcostudio/{job_id}",
            "idempotency_key": job_id,
            "receipt": None,
        }
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT fingerprint,body FROM jobs WHERE request_id=?", (request_id,)
            ).fetchone()
            if existing:
                if existing[0] != fingerprint:
                    raise ValueError(
                        "This request_id was already used with different settings or input"
                    )
                return json.loads(existing[1])
            conn.execute(
                "INSERT INTO jobs VALUES (?,?,?,?,?)",
                (job_id, request_id, fingerprint, "preparing", json.dumps(body)),
            )
        return body

    def update_job(self, job_id: str, **changes) -> dict:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT body FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError("Job not found")
            body = json.loads(row[0]) | changes | {"updated_at": now()}
            conn.execute(
                "UPDATE jobs SET status=?,body=? WHERE id=?",
                (body["status"], json.dumps(body), job_id),
            )
        return body

    def write_receipt(self, job_id: str, receipt: dict):
        UUID = uuid.UUID(job_id)
        atomic_write(
            self.root / "receipts" / f"{UUID}.json", json.dumps(receipt, indent=2).encode()
        )
