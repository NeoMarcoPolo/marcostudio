from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, nullcontext, suppress
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .comfy.doctor import diagnose
from .comfy.transport import ComfyTransport
from .config import Settings, local_url, save_settings
from .core.jobs import JobService
from .core.lock import RuntimeLock
from .core.store import TERMINAL, Store
from .core.video import MAX_VIDEO_BYTES
from .features import FEATURES, get_feature


class NewJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str | None = None
    inputs: dict[str, str] = Field(default_factory=dict, max_length=12)
    feature: str = "relight"
    settings: dict
    request_id: str = Field(min_length=1, max_length=128)


class Regenerate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)


class ResolveJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_not_running: Literal[True]


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    comfy_url: str | None = None
    proxy_url: str | None = None
    comfy_dir: str | None = None


def create_app(config: Settings, *, config_file: Path | None = None, run_worker=True):
    @asynccontextmanager
    async def lifespan(app):
        with RuntimeLock(config.data_dir) if run_worker else nullcontext():
            app.state.config = config
            app.state.store = Store(config.data_dir)
            app.state.service = JobService(config, app.state.store, ComfyTransport(config))
            task = asyncio.create_task(app.state.service.run()) if run_worker else None
            try:
                yield
            finally:
                if task:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                await app.state.service.transport.__aexit__()

    app = FastAPI(title="MarcoStudio", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        try:
            authority = request.headers.get("host", "")
            expected = local_url(f"{request.url.scheme}://{authority}")
            origin = request.headers.get("origin")
            if origin and (local_url(origin) != expected or urlsplit(origin).path):
                raise ValueError("Origin mismatch")
            if request.headers.get("sec-fetch-site") == "cross-site":
                raise ValueError("Cross-site request")
        except ValueError:
            return JSONResponse(
                {"detail": "Only same-origin local requests are accepted"}, status_code=403
            )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc).strip("'")}, status_code=404)

    def service():
        return app.state.service

    def restorable_connection(jobs=None):
        if jobs is None:
            jobs = [j for j in app.state.store.jobs() if j["status"] not in TERMINAL]
        submitted = [j for j in jobs if j["status"] != "preparing"]
        targets = {
            ((j.get("backend") or {}).get("comfy_url"), (j.get("backend") or {}).get("proxy_url"))
            for j in submitted
        }
        if len(targets) != 1:
            return None
        comfy_url, proxy_url = targets.pop()
        if (
            not comfy_url
            or not proxy_url
            or (comfy_url == app.state.config.comfy_url and proxy_url == app.state.config.proxy_url)
        ):
            return None
        return {"comfy_url": comfy_url, "proxy_url": proxy_url}

    def current_settings():
        conf = app.state.config.model_dump(mode="json")
        return {k: conf[k] for k in ("comfy_url", "proxy_url", "comfy_dir", "data_dir")} | {
            "transport": "Comfy SDK + local API proxy",
            "restore_connection": restorable_connection(),
        }

    @app.get("/api/features")
    async def features():
        return [
            {
                "id": feature.id,
                "name": feature.name,
                "supported_modes": feature.modes,
                "defaults": feature.settings().model_dump(),
                "source_kind": feature.source_kind,
                "source_label": feature.source_label,
                "output_kind": feature.output_kind,
                "input_slots": feature.input_slots,
            }
            for feature in FEATURES.values()
        ]

    @app.get("/api/settings")
    async def settings():
        return current_settings()

    @app.put("/api/settings")
    async def settings_update(patch: SettingsPatch):
        try:
            updated = Settings(
                **(app.state.config.model_dump() | patch.model_dump(exclude_unset=True))
            )
            if not updated.proxy_url:
                raise ValueError("A local proxy URL is required")
        except (ValueError, ValidationError) as exc:
            raise HTTPException(422, str(exc)) from exc
        async with service().lock:
            active_jobs = [j for j in app.state.store.jobs() if j["status"] not in TERMINAL]
            if active_jobs:
                restore = restorable_connection(active_jobs)
                if not restore or updated.model_dump() != (app.state.config.model_dump() | restore):
                    raise HTTPException(
                        409, "Finish or reconcile active jobs before changing runtime settings"
                    )
            save_settings(updated, config_file)
            old_transport = service().transport
            service().transport = ComfyTransport(updated)
            service().config = app.state.config = updated
            await old_transport.__aexit__()
        return current_settings()

    @app.get("/api/doctor")
    async def doctor(mode: str | None = None, feature: str = "relight"):
        if mode is not None and mode not in {"flash", "standard"}:
            raise HTTPException(422, "Unknown mode")
        try:
            get_feature(feature)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return await diagnose(app.state.config, mode, feature=feature)

    @app.post("/api/assets", status_code=201)
    async def upload(file: UploadFile):
        try:
            data = await file.read(MAX_VIDEO_BYTES + 1)
            return await asyncio.to_thread(service().assets.add, data, file.filename or "image.png")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            await file.close()

    @app.get("/api/assets/{asset_id}/meta")
    async def asset_meta(asset_id: str):
        return app.state.store.asset(asset_id)

    @app.get("/api/assets/{asset_id}")
    async def asset_bytes(asset_id: str):
        asset = app.state.store.asset(asset_id)
        return FileResponse(
            service().assets.path(asset_id),
            media_type=asset["media_type"],
            filename=asset["filename"],
            content_disposition_type="inline",
        )

    @app.get("/api/jobs")
    async def jobs():
        return app.state.store.jobs()

    async def enqueue(source_id, settings, request_id, feature_id="relight", inputs=None):
        inputs = inputs or {}
        try:
            feature = get_feature(feature_id)
            settings = feature.parse_settings(settings)
            source = (
                await asyncio.to_thread(service().assets.metadata, source_id)
                if source_id is not None
                else None
            )
            feature.validate_assets(
                source,
                {key: app.state.store.asset(value) for key, value in inputs.items()},
                settings,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        try:
            return app.state.store.create_job(
                source_id, settings.model_dump(), request_id, feature=feature_id, inputs=inputs
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/jobs", status_code=201)
    async def submit(body: NewJob):
        async with service().lock:
            return await enqueue(
                body.source_id, body.settings, body.request_id, body.feature, body.inputs
            )

    @app.get("/api/jobs/{job_id}")
    async def job(job_id: str):
        return app.state.store.job(job_id)

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        try:
            return await service().cancel(job_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/jobs/{job_id}/regenerate", status_code=201)
    async def regenerate(job_id: str, body: Regenerate):
        async with service().lock:
            recorded = app.state.store.job(job_id)
            return await enqueue(
                recorded["source_id"],
                recorded["settings"],
                body.request_id,
                recorded["feature"],
                recorded.get("inputs", {}),
            )

    @app.post("/api/jobs/{job_id}/resolve")
    async def resolve(job_id: str, body: ResolveJob):
        try:
            return await service().resolve(job_id)
        except Exception as exc:
            if isinstance(exc, KeyError):
                raise
            raise HTTPException(409, f"Cannot resolve this run: {exc}") from exc

    web = Path(__file__).parent / "web"
    app.mount("/assets", StaticFiles(directory=web / "assets", check_dir=False), name="static")

    @app.get("/")
    async def index():
        if not (web / "index.html").is_file():
            raise HTTPException(503, "Build the frontend before starting MarcoStudio")
        return FileResponse(web / "index.html", media_type="text/html")

    return app
