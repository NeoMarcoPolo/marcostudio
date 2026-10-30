"""Opt-in, bearer-protected storage observation for trusted catalog models."""

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
from urllib.parse import urlsplit

from aiohttp import web

from .model_storage import manager_default_space
from .storage_catalog import MODELS


def catalog_digest():
    payload = json.dumps([[key, *value] for key, value in sorted(MODELS.items())],
                         separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _safe_transport(request):
    if request.scheme == "https":
        return True
    try:
        host = urlsplit("http://" + request.host).hostname
        return bool(host and request.remote and ipaddress.ip_address(host).is_loopback
                    and ipaddress.ip_address(request.remote).is_loopback)
    except ValueError:
        return False


def storage_handler(pairing):
    worker = asyncio.Semaphore(1)

    async def storage(request):
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        auth = request.headers.get("Authorization", "")
        if not _safe_transport(request) or not auth.startswith("Bearer ") or not pairing.accepts(auth[7:]):
            return web.json_response({"error": "unauthorized"}, status=401, headers=headers)
        if request.query.get("catalog") != catalog_digest():
            return web.json_response({"error": "catalog mismatch"}, status=409, headers=headers)
        raw = request.query.get("ids", "")
        ids = raw.split(",") if raw else []
        if not 1 <= len(ids) <= 32 or len(set(ids)) != len(ids) or any(not re.fullmatch("[0-9a-f]{64}", x) for x in ids):
            return web.json_response({"error": "invalid request"}, status=400, headers=headers)
        models = []
        for identity in ids:
            model = MODELS.get(identity)
            observation = None
            if model:
                await worker.acquire()
                try:
                    probe = asyncio.create_task(asyncio.to_thread(manager_default_space, *model))
                except BaseException:
                    worker.release()
                    raise
                # Cancellation cannot stop a running thread. Release only when
                # that thread exits, even if its HTTP client has disconnected.
                def release_probe(task):
                    worker.release()
                    if not task.cancelled() and task.exception() is not None:
                        logging.warning("MarcoStudio storage observation failed")

                probe.add_done_callback(release_probe)
                observation = await asyncio.shield(probe)
            item = {"id": identity, "status": "unavailable"}
            if observation and observation.status == "available" and observation.device is not None:
                item.update(status="available", available_bytes=observation.available_bytes,
                            volume=pairing.volume(observation.device))
            models.append(item)
        return web.json_response({"version": 1, "models": models}, headers=headers)
    return storage
