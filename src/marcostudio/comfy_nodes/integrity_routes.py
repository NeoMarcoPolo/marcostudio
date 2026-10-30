"""Authenticated, opt-in routes for bounded integrity observations.

Responses describe verification snapshots and never claim a model is ready.
"""
import asyncio
import hashlib
import json
import logging
import re
import sys

from aiohttp import web

from .integrity_catalog import LOADERS, MODELS
from .integrity_manager import manager_queue_state
from .integrity_service import IntegrityService
from .storage_routes import _safe_transport


def catalog_digest():
    payload = json.dumps([[key, *MODELS[key], *LOADERS[key]] for key in sorted(MODELS)],
                         separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def handlers(pairing, service_factory=None):
    """Return handlers using a single bounded service for this pairing instance."""
    service = None
    admission = asyncio.Lock()
    status_lock = asyncio.Lock()
    status_pending = 0
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}

    def authorize(request):
        auth = request.headers.get("Authorization", "")
        return _safe_transport(request) and auth.startswith("Bearer ") and pairing.accepts(auth[7:])

    def make_service():
        if service_factory:
            return service_factory()
        paths, nodes = sys.modules.get("folder_paths"), sys.modules.get("nodes")
        mapping = getattr(nodes, "NODE_CLASS_MAPPINGS", None)
        if paths is None or not isinstance(mapping, dict):
            return None
        return IntegrityService(paths, mapping, manager_queue_state)

    async def body(request):
        if request.content_type != "application/json":
            return None
        try:
            raw = bytearray()
            async with asyncio.timeout(5):
                while not request.content.at_eof():
                    chunk = await request.content.read(2049 - len(raw))
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > 2048:
                        return None
            if not request.content.at_eof():
                return None
            value = json.loads(raw)
            return value if isinstance(value, dict) else None
        except (TimeoutError, UnicodeDecodeError, ValueError):
            return None

    async def start(request):
        nonlocal service
        if not authorize(request):
            return web.json_response({"error": "unauthorized"}, status=401, headers=headers)
        data = await body(request)
        if not data or set(data) != {"id", "catalog"}:
            return web.json_response({"error": "invalid request"}, status=400, headers=headers)
        if data["catalog"] != catalog_digest():
            return web.json_response({"error": "catalog mismatch"}, status=409, headers=headers)
        identity = data["id"]
        if not isinstance(identity, str) or not re.fullmatch("[0-9a-f]{64}", identity) or identity not in MODELS:
            return web.json_response({"error": "invalid request"}, status=400, headers=headers)
        if admission.locked():
            return web.json_response({"state": "busy"}, status=429, headers=headers)
        await admission.acquire()
        try:
            if service is None:
                service = make_service()
            if service is None:
                admission.release()
                return web.json_response({"state": "unavailable"}, status=503, headers=headers)
            pending = asyncio.create_task(asyncio.to_thread(service.submit, identity))
        except BaseException:
            admission.release()
            raise
        def finished(task):
            admission.release()
            if not task.cancelled() and task.exception() is not None:
                logging.warning("MarcoStudio integrity admission failed")
        pending.add_done_callback(finished)
        try:
            state, job = await asyncio.shield(pending)
        except Exception:
            logging.warning("MarcoStudio integrity admission unavailable")
            return web.json_response({"state": "unavailable"}, status=503, headers=headers)
        if state == "accepted":
            return web.json_response({"state": state, "job": job}, headers=headers)
        return web.json_response({"state": state}, status=429 if state in {"busy", "cooldown"} else 503, headers=headers)

    async def status(request):
        nonlocal status_pending
        if not authorize(request):
            return web.json_response({"error": "unauthorized"}, status=401, headers=headers)
        job = request.match_info.get("job", "")
        if not re.fullmatch("[A-Za-z0-9_-]{24}", job) or service is None:
            return web.json_response({"state": "unavailable"}, status=404, headers=headers)
        # Node definitions and filesystem stat may block. Limit running and
        # waiting status work, and keep the permit until a cancelled thread exits.
        if status_pending >= 32:
            return web.json_response({"state": "busy"}, status=429, headers=headers)
        status_pending += 1
        try:
            await status_lock.acquire()
        except BaseException:
            status_pending -= 1
            raise
        try:
            pending = asyncio.create_task(asyncio.to_thread(service.status, job))
        except BaseException:
            status_lock.release()
            status_pending -= 1
            raise
        def finished(task):
            nonlocal status_pending
            status_lock.release()
            status_pending -= 1
            if not task.cancelled() and task.exception() is not None:
                logging.warning("MarcoStudio integrity status unavailable")
        pending.add_done_callback(finished)
        try:
            state = await asyncio.shield(pending)
        except Exception:
            return web.json_response({"state": "unavailable"}, status=503, headers=headers)
        return web.json_response({"state": state or "unavailable"}, status=200 if state else 404, headers=headers)

    async def cancel(request):
        if not authorize(request):
            return web.json_response({"error": "unauthorized"}, status=401, headers=headers)
        job = request.match_info.get("job", "")
        if not re.fullmatch("[A-Za-z0-9_-]{24}", job) or service is None:
            return web.json_response({"state": "unavailable"}, status=404, headers=headers)
        return web.json_response({"cancelled": service.cancel(job)}, headers=headers)

    return start, status, cancel
