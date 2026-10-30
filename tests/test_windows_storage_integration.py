"""Exercise the opt-in Windows storage integration on a real Windows runner."""
import asyncio
import importlib.util
import json
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
    load("model_storage_windows")
    storage_module = load("model_storage")
    routes = load("storage_routes")
    destination = tmp_path / "models"
    destination.mkdir()
    identity = "c" * 64
    monkeypatch.setattr(routes, "MODELS", {identity: ("model.safetensors", "vae")})

    constants = ModuleType("comfyui_manager.glob.constants")
    constants.model_dir_name_map = {"vae": "vae"}
    resolver = ModuleType("comfyui_manager.glob.utils.model_utils")
    resolver.get_model_dir = lambda _data: str(destination)
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.constants", constants)
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.utils.model_utils", resolver)
    monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE", "1")
    monkeypatch.setattr(routes, "manager_default_space", storage_module.manager_default_space)
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


@pytest.mark.skipif(os.name != "nt", reason="requires an actual Windows runner")
def test_windows_storage_integration_requires_explicit_opt_in(tmp_path, monkeypatch):
    load("model_storage_windows")
    storage_module = load("model_storage")
    monkeypatch.delenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE", raising=False)
    assert storage_module.available_space(tmp_path).status == "unavailable"
    monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE", "1")
    assert storage_module.available_space(tmp_path).status == "available"


@pytest.mark.skipif(os.name != "nt", reason="requires an actual Windows runner")
def test_windows_capability_registers_only_after_explicit_opt_in(monkeypatch):
    package = "marcostudio_windows_registration_test"
    h3 = ModuleType(f"{package}.h3")
    h3.MarcoStudioH3Window = object
    h3.MarcoStudioH3InpaintLatent = object
    monkeypatch.setitem(sys.modules, h3.__name__, h3)
    owners = []
    route_table = []

    class Routes:
        def __iter__(self):
            return iter([])

        def get(self, path):
            def register(handler):
                route_table.append((path, handler))
                return handler
            return register

        post = get

    instance = SimpleNamespace(routes=Routes())
    server = SimpleNamespace(PromptServer=SimpleNamespace(instance=instance))
    monkeypatch.setitem(sys.modules, "server", server)
    monkeypatch.setenv("MARCOSTUDIO_ENABLE_STORAGE_PAIRING", "1")
    monkeypatch.delenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE", raising=False)
    monkeypatch.delenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM", raising=False)
    monkeypatch.setattr("atexit.register", lambda func: owners.append(func))
    spec = importlib.util.spec_from_file_location(package, ROOT / "__init__.py",
                                                  submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, package, module)
    spec.loader.exec_module(module)
    assert [path for path, _ in route_table] == ["/marcostudio/capabilities"]
    assert json.loads(asyncio.run(route_table[-1][1](None)).text)["storage_pairing"] == 0
    route_table.clear()
    monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE", "1")
    module._register_routes()
    try:
        assert [path for path, _ in route_table] == ["/marcostudio/storage", "/marcostudio/capabilities"]
        capabilities = json.loads(asyncio.run(route_table[-1][1](None)).text)
        assert capabilities["storage_pairing"] == 1
        assert capabilities["integrity_verification"] == 0
        route_table.clear()
        monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM", "1")
        module._register_routes()
        assert [path for path, _ in route_table] == [
            "/marcostudio/integrity", "/marcostudio/integrity/{job}",
            "/marcostudio/integrity/{job}/cancel", "/marcostudio/storage", "/marcostudio/capabilities",
        ]
        capabilities = json.loads(asyncio.run(route_table[-1][1](None)).text)
        assert capabilities["storage_pairing"] == 1
        assert capabilities["integrity_verification"] == 1
    finally:
        for close in owners:
            close()


@pytest.mark.skipif(os.name != "nt", reason="requires an actual Windows runner")
def test_windows_integrity_route_hashes_tiny_fixture_with_explicit_opt_in(tmp_path, monkeypatch):
    import hashlib

    contents = b"small Windows integrity fixture"
    path = tmp_path / "model.safetensors"
    path.write_bytes(contents)
    identity = hashlib.sha256(contents).hexdigest()
    data = (path.name, "vae", len(contents))
    pairing_module = load("storage_pairing_windows")
    routes = load("integrity_routes")
    resolver = sys.modules[f"{PACKAGE}.integrity_resolution"]
    loader = sys.modules[f"{PACKAGE}.integrity_loader"]
    monkeypatch.setattr(routes, "MODELS", {identity: data})
    monkeypatch.setattr(routes, "LOADERS", {identity: ("FixtureLoader", "name")})
    monkeypatch.setattr(resolver, "MODELS", {identity: data})
    monkeypatch.setattr(loader, "MODELS", {identity: data})
    monkeypatch.setattr(loader, "LOADERS", {identity: ("FixtureLoader", "name")})
    monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM", "1")

    class Paths:
        def get_filename_list(self, _category):
            return [path.name]
        def get_full_path(self, _category, _name):
            return str(path)
    class Loader:
        @staticmethod
        def INPUT_TYPES():
            return {"required": {"name": ([path.name],)}}

    # This is a native Windows file and Credential Manager test. The queue
    # observer is a controlled stand-in; real Windows ComfyUI Manager and the
    # Desktop/portable launch sessions still require independent testing.
    epoch = [0]
    service = routes.IntegrityService(Paths(), {"FixtureLoader": Loader}, lambda: "idle",
                                      queue_epoch=lambda: ("fixture-queue", epoch[0]))
    owner = pairing_module.WindowsOwnerPairing()
    try:
        token = pairing_module.read_owner_token(owner.target)
        async def run():
            app = web.Application()
            start, status, cancel = routes.handlers(owner, lambda: service)
            app.router.add_post("/integrity", start)
            app.router.add_get("/integrity/{job}", status)
            app.router.add_post("/integrity/{job}/cancel", cancel)
            async with TestServer(app) as server, ClientSession() as client:
                payload = {"id": identity, "catalog": routes.catalog_digest()}
                async with client.post(server.make_url("/integrity"), json=payload) as response:
                    assert response.status == 401
                auth = {"Authorization": "Bearer " + token}
                async with client.post(server.make_url("/integrity"), json=payload, headers=auth) as response:
                    assert response.status == 200
                    job = (await response.json())["job"]
                for _ in range(200):
                    async with client.get(server.make_url("/integrity/" + job), headers=auth) as response:
                        state = (await response.json())["state"]
                    if state not in {"queued", "running"}:
                        break
                    await asyncio.sleep(.01)
                assert state == "checksum_matched"
                epoch[0] += 1
                async with client.get(server.make_url("/integrity/" + job), headers=auth) as response:
                    assert (await response.json())["state"] == "changed"
        asyncio.run(run())
    finally:
        owner.close()
