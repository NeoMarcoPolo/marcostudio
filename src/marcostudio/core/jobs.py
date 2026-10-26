from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime

from comfy_low.errors import ApiError

from ..comfy.doctor import diagnose
from ..config import Settings
from ..features import get_feature
from .assets import Assets
from .store import TERMINAL, Store, now


class JobService:
    def __init__(self, config: Settings, store: Store, transport):
        self.config, self.store, self.transport = config, store, transport
        self.assets = Assets(store)
        self.stopping = asyncio.Event()
        self.lock = asyncio.Lock()

    async def execute(self, job_id: str, readiness: dict | None = None):
        async with self.lock:
            job = self.store.job(job_id)
            if job["status"] != "preparing":
                return
            submitted = False
            try:
                feature = get_feature(job["feature"])
                settings = feature.parse_settings(job["settings"])
                source = (
                    await asyncio.to_thread(self.assets.metadata, job["source_id"])
                    if job["source_id"]
                    else None
                )
                feature.validate_assets(
                    source,
                    {key: self.store.asset(value) for key, value in job.get("inputs", {}).items()},
                    settings,
                )
                report = readiness or await diagnose(self.config, settings.mode, feature=feature.id)
                if not report["ready"]:
                    failures = [c["message"] for c in report["checks"] if c["status"] == "fail"]
                    raise ValueError("Setup needs attention: " + "; ".join(failures))

                async def upload_asset(asset_id):
                    asset = self.store.asset(asset_id)
                    path = self.assets.path(asset_id)
                    content = await asyncio.to_thread(path.read_bytes)
                    return await self.transport.upload(content, path.name, asset["media_type"])

                reference = await upload_asset(job["source_id"]) if job["source_id"] else None
                inputs = {}
                for key, asset_id in job.get("inputs", {}).items():
                    inputs[key] = await upload_asset(asset_id)
                graph = feature.compile(
                    settings, reference, job["output_prefix"], report["models"], inputs=inputs
                )
                receipt = {
                    "feature": feature.id,
                    "workflow_version": feature.manifest.WORKFLOW_VERSION,
                    "source_revision": feature.manifest.SOURCE_REVISION,
                    "source_workflow_sha256": feature.manifest.SOURCE_SHA256,
                    "source_url": getattr(feature.manifest, "SOURCE_URL", None),
                    "variant_source": getattr(feature.manifest, "VARIANT_SOURCES", {}).get(
                        settings.mode
                    ),
                    "settings": settings.model_dump(),
                    "requested_mode": settings.mode,
                    "effective_mode": settings.mode,
                    "prompt": settings.prompt(),
                    "graph": graph,
                    "graph_sha256": hashlib.sha256(
                        json.dumps(graph, sort_keys=True).encode()
                    ).hexdigest(),
                    "models": {
                        m.key: {
                            "expected_sha256": m.sha256,
                            **report.get("identities", {}).get(m.key, {}),
                        }
                        for m in feature.models_for(settings.mode)
                    },
                    "source_id": job["source_id"],
                    "inputs": job.get("inputs", {}),
                    "created_at": job["created_at"],
                    "runtime": report.get("runtime", {}),
                }
                if feature.id == "relight":
                    receipt["vector"] = settings.vector()
                self.store.write_receipt(job_id, receipt)
                self.store.update_job(
                    job_id,
                    status="submitting",
                    receipt=receipt,
                    submitted_at=now(),
                    backend={
                        "comfy_url": self.config.comfy_url,
                        "proxy_url": self.config.proxy_url,
                    },
                )
                submitted = True
                upstream_id = await self.transport.submit(graph, job["idempotency_key"])
                self.store.update_job(job_id, upstream_id=upstream_id, status="queued", error=None)
            except asyncio.CancelledError:
                if submitted:
                    self.store.update_job(
                        job_id,
                        status="needs_attention",
                        error="Submission interrupted; reconciling without resubmitting.",
                    )
                raise
            except Exception as exc:
                definite = (
                    isinstance(exc, ApiError)
                    and exc.http_status in {400, 401, 403, 404, 422}
                    and exc.code != "idempotency_key_reuse"
                )
                self.store.update_job(
                    job_id,
                    status="needs_attention" if submitted and not definite else "failed",
                    error=f"{type(exc).__name__}: {exc}"[:2000],
                )

    async def reconcile(self, job_id: str):
        job = self.store.job(job_id)
        if job["status"] in TERMINAL or job["status"] == "preparing":
            return
        try:
            if not job.get("upstream_id"):
                found = await self.transport.find(job["output_prefix"])
                if not found:
                    self.store.update_job(
                        job_id,
                        status="needs_attention",
                        error="Submission outcome is uncertain. Check ComfyUI history; this run will not be submitted again.",
                    )
                    return
                job = self.store.update_job(job_id, upstream_id=found)
            state = await self.transport.state(job["upstream_id"])
            status = state["status"]
            if status == "succeeded":
                outputs = [o for o in state["outputs"] if o.get("node_id") == "12"]
                if not outputs:
                    raise ValueError("Completed execution has no expected media output")
                assets = []
                feature = get_feature(job["feature"])
                extension = ".mp4" if feature.output_kind == "video" else ".png"
                for output in outputs:
                    data = await self.transport.output(output, job["upstream_id"])
                    asset = await asyncio.to_thread(
                        self.assets.add,
                        data,
                        f"{job['feature']}-{job_id[:8]}{extension}",
                        output=True,
                    )
                    if not asset["media_type"].startswith(feature.output_kind + "/"):
                        raise ValueError("Completed execution returned an unexpected media type")
                    assets.append(asset)
                stamp = now()
                elapsed = (
                    datetime.fromisoformat(stamp)
                    - datetime.fromisoformat(job.get("submitted_at", job["created_at"]))
                ).total_seconds()
                receipt = (job.get("receipt") or {}) | {
                    "upstream_id": job["upstream_id"],
                    "outputs": assets,
                    "completed_at": stamp,
                    "elapsed_seconds": elapsed,
                    "terminal_history": state.get("history"),
                }
                self.store.write_receipt(job_id, receipt)
                self.store.update_job(
                    job_id,
                    status="succeeded",
                    outputs=assets,
                    receipt=receipt,
                    elapsed_seconds=elapsed,
                    error=None,
                    progress=1,
                )
            elif status in {"failed", "canceled"}:
                receipt = (job.get("receipt") or {}) | {
                    "upstream_id": job["upstream_id"],
                    "completed_at": now(),
                    "terminal_history": state.get("history"),
                    "status": status,
                }
                self.store.write_receipt(job_id, receipt)
                self.store.update_job(
                    job_id,
                    status="cancelled" if status == "canceled" else "failed",
                    receipt=receipt,
                    error=str(state.get("error") or "") or None,
                )
            elif status in {"queued", "running", "canceling"}:
                changes = {
                    "status": "cancel_requested"
                    if job["status"] == "cancel_requested" or status == "canceling"
                    else status,
                    "error": None,
                }
                if status == "running" and not job.get("started_at"):
                    changes["started_at"] = now()
                    changes["queue_seconds"] = (
                        datetime.fromisoformat(changes["started_at"])
                        - datetime.fromisoformat(job.get("submitted_at", job["created_at"]))
                    ).total_seconds()
                self.store.update_job(job_id, **changes)
            else:
                if job.get("cancel_acknowledged") and job.get("cancel_phase") == "queued":
                    queue = await self.transport.native_json("/queue")
                    present = {
                        e[1]
                        for e in queue.get("queue_running", []) + queue.get("queue_pending", [])
                    }
                    history = await self.transport.native_json(f"/history/{job['upstream_id']}")
                    if job["upstream_id"] not in present and not history:
                        receipt = (job.get("receipt") or {}) | {
                            "status": "cancelled",
                            "completed_at": now(),
                            "cancellation": "Scoped cancellation acknowledged and queue removal verified",
                        }
                        self.store.write_receipt(job_id, receipt)
                        self.store.update_job(
                            job_id, status="cancelled", receipt=receipt, error=None
                        )
                        return
                self.store.update_job(
                    job_id,
                    status="needs_attention",
                    error="The runtime cannot confirm this job. No new submission was made.",
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.store.update_job(
                job_id,
                status="needs_attention",
                error=f"Reconciliation pending: {type(exc).__name__}: {exc}"[:2000],
            )

    async def cancel(self, job_id: str) -> dict:
        async with self.lock:
            job = self.store.job(job_id)
            if job["status"] in TERMINAL:
                return job
            if job["status"] == "preparing":
                return self.store.update_job(job_id, status="cancelled")
            if not job.get("upstream_id"):
                raise ValueError("Cancellation needs a confirmed upstream job identity")
            queue = await self.transport.native_json("/queue")
            if not isinstance(queue.get("queue_running"), list) or not isinstance(
                queue.get("queue_pending"), list
            ):
                raise ValueError("The runtime cannot confirm its queue")
            # A transient polling failure can replace the local phase with needs_attention.
            # Use current native evidence, retaining an earlier acknowledgment on retries.
            phase = job.get("cancel_phase") if job.get("cancel_acknowledged") else None
            if any(e[1] == job["upstream_id"] for e in queue["queue_running"]):
                phase = "running"
            elif any(e[1] == job["upstream_id"] for e in queue["queue_pending"]):
                phase = "queued"
            accepted = await self.transport.cancel(job["upstream_id"])
            if not accepted:
                await self.reconcile(job_id)
                return self.store.job(job_id)
            self.store.update_job(
                job_id,
                status="cancel_requested",
                cancel_acknowledged=True,
                cancel_phase=phase,
            )
            await self.reconcile(job_id)
            return self.store.job(job_id)

    async def resolve(self, job_id: str):
        async with self.lock:
            job = self.store.job(job_id)
            if job["status"] != "needs_attention":
                raise ValueError("Only an uncertain job can be resolved manually")
            backend = job.get("backend")
            if backend and (
                backend["comfy_url"] != self.config.comfy_url
                or backend["proxy_url"] != self.config.proxy_url
            ):
                raise ValueError("Restore this job's original runtime settings before resolving")
            await self.reconcile(job_id)
            job = self.store.job(job_id)
            if job["status"] in TERMINAL:
                return job
            if job["status"] != "needs_attention":
                raise ValueError("This job is still active in ComfyUI")
            # These calls must succeed. An unavailable runtime is not an empty queue.
            queue = await self.transport.native_json("/queue")
            if not isinstance(queue.get("queue_running"), list) or not isinstance(
                queue.get("queue_pending"), list
            ):
                raise ValueError("The runtime cannot confirm its queue")
            ids = {e[1] for e in queue["queue_running"] + queue["queue_pending"]}
            found = await self.transport.find(job["output_prefix"])
            if job.get("upstream_id") in ids or found in ids:
                raise ValueError("This job is still queued or running in ComfyUI")
            if found and not job.get("upstream_id"):
                raise ValueError("A matching upstream run was found; wait for reconciliation")
            receipt = (job.get("receipt") or {}) | {
                "status": "abandoned",
                "resolved_at": now(),
                "resolution": "User confirmed the run is no longer running; stopped tracking without resubmitting or cancelling",
            }
            self.store.write_receipt(job_id, receipt)
            return self.store.update_job(
                job_id,
                status="abandoned",
                receipt=receipt,
                error="Stopped tracking after manual confirmation. Execution outcome was not verified.",
            )

    async def run(self):
        for job in self.store.jobs():
            if job["status"] == "submitting":
                self.store.update_job(
                    job["id"], status="needs_attention", error="Recovering interrupted submission"
                )
        while not self.stopping.is_set():
            jobs = list(reversed(self.store.jobs()))
            active = [j for j in jobs if j["status"] not in TERMINAL | {"preparing"}]
            for job in active:
                # Existing jobs retain the endpoints they were submitted to.
                backend = job.get("backend")
                if backend and (
                    backend["comfy_url"] != self.config.comfy_url
                    or backend["proxy_url"] != self.config.proxy_url
                ):
                    self.store.update_job(
                        job["id"],
                        status="needs_attention",
                        error="Restore this job's original runtime endpoints to reconcile it",
                    )
                    continue
                async with self.lock:
                    await self.reconcile(job["id"])
            if not active:
                pending = next((j for j in jobs if j["status"] == "preparing"), None)
                if pending:
                    await self.execute(pending["id"])
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=self.config.poll_interval)
            except TimeoutError:
                pass
