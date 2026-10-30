"""Exercise authenticated route with a real aiohttp server."""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

ROOT = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes"
pkg = ModuleType("marcostudio_storage_test")
pkg.__path__ = [str(ROOT)]
sys.modules[pkg.__name__] = pkg
spec = importlib.util.spec_from_file_location(pkg.__name__ + ".storage_routes", ROOT / "storage_routes.py")
routes = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = routes
spec.loader.exec_module(routes)


def test_bundled_catalog_matches_frontend_source():
    catalog = json.loads((ROOT.parents[2] / "frontend/src/browser/catalog.json").read_text())
    categories = {"diffusion_models": "diffusion_model", "text_encoders": "text_encoders", "vae": "vae", "loras": "lora", "controlnet": "controlnet"}
    identities = {}
    for feature in catalog["features"]:
        for models in feature["models"].values():
            for model in models:
                if model["category"] in categories:
                    value = (model["filename"], categories[model["category"]])
                    assert identities.setdefault(model["sha256"], value) == value
    assert identities == routes.MODELS


def test_spoofed_host_is_not_loopback_transport():
    assert not routes._safe_transport(SimpleNamespace(scheme="http", host="127.0.0.1:8195", remote="192.0.2.1"))
    assert routes._safe_transport(SimpleNamespace(scheme="http", host="127.0.0.1:8195", remote="127.0.0.1"))


def test_authorization_and_bounded_catalog(monkeypatch):
    identity = "a" * 64
    monkeypatch.setattr(routes, "MODELS", {identity: ("a.safetensors", "vae")})
    calls = []
    monkeypatch.setattr(routes, "manager_default_space", lambda *args: calls.append(args) or
                        SimpleNamespace(status="available", available_bytes=42, device=7))
    pairing = SimpleNamespace(accepts=lambda token: token == "correct", volume=lambda device: "opaque7")

    async def run():
        app = web.Application()
        app.router.add_get("/marcostudio/storage", routes.storage_handler(pairing))
        async with TestServer(app) as server, ClientSession() as client:
            url = server.make_url("/marcostudio/storage?catalog=" + routes.catalog_digest() + "&ids=" + identity)
            for headers in ({}, {"Origin": "https://evil.example"}, {"Authorization": "Bearer incorrect"}):
                async with client.get(url, headers=headers) as resp:
                    assert resp.status == 401
                    assert resp.headers["Cache-Control"] == "no-store"
            assert not calls
            async with client.get(url, headers={"Authorization": "Bearer correct"}) as resp:
                assert resp.status == 200
                assert await resp.json() == {"version": 1, "models": [{"id": identity, "status": "available", "available_bytes": 42, "volume": "opaque7"}]}
            assert calls == [("a.safetensors", "vae")]
            async with client.get(server.make_url("/marcostudio/storage?ids=" + identity), headers={"Authorization": "Bearer correct"}) as resp:
                assert resp.status == 409
            assert calls == [("a.safetensors", "vae")]
            async with client.get(server.make_url("/marcostudio/storage?catalog=" + routes.catalog_digest() + "&ids=not-an-id"), headers={"Authorization": "Bearer correct"}) as resp:
                assert resp.status == 400
            async with client.get(url, headers={"Authorization": "Bearer correct", "Host": "remote.example"}) as resp:
                assert resp.status == 401
    asyncio.run(run())
