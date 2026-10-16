from __future__ import annotations

from dataclasses import asdict, is_dataclass
from uuid import UUID

import httpx
from comfy_low.transport import AsyncComfyLow
from comfy_sdk.assets import AsyncAssetFactory

from ..config import Settings

MAX_OUTPUT_BYTES = 64 * 1024 * 1024


class ComfyTransport:
    """Official SDK protocol bindings with explicit local endpoints and one submit attempt."""

    def __init__(self, config: Settings, client: httpx.AsyncClient | None = None):
        self.config = config
        self.owned = client is None
        self.http = client or httpx.AsyncClient(
            timeout=config.request_timeout, trust_env=False, follow_redirects=False
        )
        if not config.proxy_url:
            raise ValueError("Configure the local Comfy API proxy URL")
        # Explicit endpoint and no credentials: never inherit cloud settings or ambient proxies.
        self.sdk = AsyncComfyLow(
            config.proxy_url, None, client=self.http, router_base_url=config.proxy_url
        )
        self.assets = AsyncAssetFactory(self.sdk)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        if self.owned:
            await self.http.aclose()

    async def upload(self, data: bytes, filename: str) -> dict:
        asset = self.assets.from_bytes(data, filename=filename, content_type="image/png")
        await asset.commit()
        return await asset.as_reference()

    async def submit(self, graph: dict, key: str) -> str:
        job = await self.sdk.post_jobs(graph, idempotency_key=key)
        return str(UUID(job.id))

    async def native_json(self, path: str):
        response = await self.http.get(self.config.comfy_url + path)
        response.raise_for_status()
        return response.json()

    async def state(self, job_id: str) -> dict:
        job_id = str(UUID(job_id))
        job = await self.sdk.get_job(job_id)
        history = (await self.native_json(f"/history/{job_id}")).get(job_id)
        status = job.status.value
        # In native history, completed means SUCCESS, not terminal. Error and
        # interruption records have completed=False. The history entry is the
        # authoritative terminal evidence; proxy state alone is insufficient.
        if history:
            native = history.get("status", {})
            events = [
                m[0]
                for m in native.get("messages", [])
                if isinstance(m, (list, tuple)) and len(m) == 2
            ]
            if "execution_interrupted" in events:
                status = "canceled"
            elif native.get("status_str") == "error":
                status = "failed"
            elif native.get("completed") is True and native.get("status_str") == "success":
                status = "succeeded"
            else:
                status = "unknown"
        elif status in {"succeeded", "failed", "canceled"}:
            status = "unknown"
        error = asdict(job.error) if is_dataclass(job.error) else job.error
        outputs = [asdict(o) if is_dataclass(o) else dict(o) for o in job.outputs]
        return {"status": status, "outputs": outputs, "error": error, "history": history}

    async def output(self, output: dict, job_id: str) -> bytes:
        if output.get("job_id") != job_id or output.get("node_id") != "12":
            raise ValueError("Output does not belong to this job and its expected save node")
        asset_id = str(output["id"])
        if any(c in asset_id for c in "/\\?#"):
            raise ValueError("Invalid output asset identity")
        content = bytearray()
        async with self.sdk.get_asset_content(asset_id) as response:
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > MAX_OUTPUT_BYTES:
                    raise ValueError("Output exceeds the supported image size")
        return bytes(content)

    async def cancel(self, job_id: str) -> bool:
        job_id = str(UUID(job_id))
        # Proxy 0.1.6 ignores upstream cancellation status. Use the native scoped route
        # and confirm its result; never substitute /interrupt or global queue operations.
        response = await self.http.post(self.config.comfy_url + f"/api/jobs/{job_id}/cancel")
        if response.status_code != 200:
            raise ValueError("Scoped cancellation is unavailable or was rejected by ComfyUI")
        body = response.json()
        if type(body.get("cancelled")) is not bool:
            raise ValueError("Scoped cancellation returned an invalid response")
        return body["cancelled"]

    async def find(self, output_prefix: str) -> str | None:
        queue = await self.native_json("/queue")
        history = await self.native_json("/history?max_items=200")
        candidates = list(queue.get("queue_running", [])) + list(queue.get("queue_pending", []))
        candidates += [v.get("prompt", []) for v in history.values()]
        matches = set()
        for entry in candidates:
            if len(entry) < 3 or not isinstance(entry[2], dict):
                continue
            node = entry[2].get("12", {})
            if (
                node.get("class_type") == "SaveImage"
                and node.get("inputs", {}).get("filename_prefix") == output_prefix
            ):
                matches.add(str(UUID(entry[1])))
        return next(iter(matches)) if len(matches) == 1 else None
