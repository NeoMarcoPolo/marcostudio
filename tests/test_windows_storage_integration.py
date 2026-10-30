"""Exercise the disconnected Windows prototype as one authenticated flow."""
import asyncio
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

ROOT = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes"
PACKAGE = "marcostudio_windows_integration_test"
pkg = ModuleType(PACKAGE)
pkg.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = pkg


def load(name):
    spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(os.name != "nt", reason="requires an actual Windows runner")
def test_windows_owner_pairing_authenticates_real_destination_space(tmp_path, monkeypatch):
    pairing_module = load("storage_pairing_windows")
    storage_module = load("model_storage_windows")
    routes = load("storage_routes")
    destination = tmp_path / "models"
    destination.mkdir()
    identity = "c" * 64
    monkeypatch.setattr(routes, "MODELS", {identity: ("model.safetensors", "vae")})

    def probe(_filename, _model_type):
        result = storage_module.available_windows(destination)
        assert result is not None
        free, device = result
        return SimpleNamespace(status="available", available_bytes=free, device=device)

    monkeypatch.setattr(routes, "manager_default_space", probe)
    owner = pairing_module.WindowsOwnerPairing()
    try:
        token = pairing_module.read_owner_token(owner.target)

        async def run():
            app = web.Application()
            app.router.add_get("/marcostudio/storage", routes.storage_handler(owner))
            async with TestServer(app) as server, ClientSession() as client:
                url = server.make_url("/marcostudio/storage?catalog=" + routes.catalog_digest() + "&ids=" + identity)
                async with client.get(url) as response:
                    assert response.status == 401
                async with client.get(url, headers={"Authorization": "Bearer invalid"}) as response:
                    assert response.status == 401
                async with client.get(url, headers={"Authorization": "Bearer " + token}) as response:
                    assert response.status == 200
                    model = (await response.json())["models"][0]
                    assert model["id"] == identity
                    assert model["status"] == "available"
                    assert isinstance(model["available_bytes"], int)
                    assert model["available_bytes"] >= 0
                    assert len(model["volume"]) == 24
                    assert str(destination) not in str(model)

        asyncio.run(run())
    finally:
        owner.close()
