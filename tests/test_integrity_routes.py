import asyncio
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

ROOT = Path(__file__).parents[1] / "src/marcostudio/comfy_nodes"
package = ModuleType("route_test_nodes")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location("route_test_nodes.integrity_routes", ROOT / "integrity_routes.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_authentication_catalog_and_status():
    identity = next(iter(module.MODELS))
    token = "correct"
    pairing = SimpleNamespace(accepts=lambda value: value == token)
    job = "a" * 24
    calls = []
    class Service:
        def submit(self, ident):
            calls.append(ident)
            return "accepted", job
        def status(self, value):
            return "snapshot_verified" if value == job else None
        def cancel(self, value):
            return value == job
    async def run():
        app = web.Application()
        start, status, cancel = module.handlers(pairing, Service)
        app.router.add_post("/start", start)
        app.router.add_get("/status/{job}", status)
        app.router.add_post("/cancel/{job}", cancel)
        async with TestServer(app) as server, ClientSession() as client:
            payload = {"id": identity, "catalog": module.catalog_digest()}
            for headers in ({}, {"Authorization": "Bearer wrong"}):
                async with client.post(server.make_url("/start"), json=payload, headers=headers) as response:
                    assert response.status == 401
            assert calls == []
            auth = {"Authorization": "Bearer correct"}
            async with client.post(server.make_url("/start"), json={**payload, "catalog": "wrong"}, headers=auth) as response:
                assert response.status == 409
            async with client.post(server.make_url("/start"), json={**payload, "id": "../secret"}, headers=auth) as response:
                assert response.status == 400
            async with client.post(server.make_url("/start"), json=payload, headers=auth) as response:
                assert response.status == 200
                assert await response.json() == {"state": "accepted", "job": job}
            assert calls == [identity]
            async with client.get(server.make_url("/status/" + job), headers=auth) as response:
                assert await response.json() == {"state": "snapshot_verified"}
            async with client.post(server.make_url("/cancel/" + job), headers=auth) as response:
                assert await response.json() == {"cancelled": True}
            async with client.get(server.make_url("/status/" + job)) as response:
                assert response.status == 401
    asyncio.run(run())


def test_real_worker_small_fixture_detects_later_change(tmp_path, monkeypatch):
    import hashlib

    content = b"small synthetic model fixture"
    path = tmp_path / "model.bin"
    path.write_bytes(content)
    identity = hashlib.sha256(content).hexdigest()
    model = ("model.bin", "test", len(content))
    resolution = sys.modules["route_test_nodes.integrity_resolution"]
    loader = sys.modules["route_test_nodes.integrity_loader"]
    monkeypatch.setattr(module, "MODELS", {identity: model})
    monkeypatch.setattr(module, "LOADERS", {identity: ("Loader", "name")})
    monkeypatch.setattr(resolution, "MODELS", {identity: model})
    monkeypatch.setattr(loader, "MODELS", {identity: model})
    monkeypatch.setattr(loader, "LOADERS", {identity: ("Loader", "name")})

    class Paths:
        def get_filename_list(self, _category):
            return ["model.bin"]
        def get_full_path(self, _category, _choice):
            return str(path)
    class Loader:
        @staticmethod
        def INPUT_TYPES():
            return {"required": {"name": (["model.bin"],)}}

    service = module.IntegrityService(Paths(), {"Loader": Loader}, lambda: "idle")
    pairing = SimpleNamespace(accepts=lambda value: value == "correct")
    async def run():
        app = web.Application()
        start, status, _cancel = module.handlers(pairing, lambda: service)
        app.router.add_post("/start", start)
        app.router.add_get("/status/{job}", status)
        async with TestServer(app) as server, ClientSession() as client:
            auth = {"Authorization": "Bearer correct"}
            async with client.post(server.make_url("/start"), json={"id": identity, "catalog": module.catalog_digest()}, headers=auth) as response:
                assert response.status == 200
                job = (await response.json())["job"]
            for _ in range(100):
                async with client.get(server.make_url("/status/" + job), headers=auth) as response:
                    state = (await response.json())["state"]
                if state not in {"running", "queued"}:
                    break
                await asyncio.sleep(.01)
            assert state == "snapshot_verified"
            path.write_bytes(b"modified fixture")
            async with client.get(server.make_url("/status/" + job), headers=auth) as response:
                assert (await response.json())["state"] == "changed"
    asyncio.run(run())


def test_cancelled_status_does_not_block_loop_or_release_worker_early():
    import threading

    identity = next(iter(module.MODELS))
    job = "a" * 24
    entered, release = threading.Event(), threading.Event()
    calls = []
    class Service:
        def submit(self, _identity):
            return "accepted", job
        def status(self, _job):
            calls.append(1)
            if len(calls) == 1:
                entered.set()
                assert release.wait(3)
            return "snapshot_verified"
    class Content:
        async def read(self, _n):
            import json
            return json.dumps({"id": identity, "catalog": module.catalog_digest()}).encode()
        def at_eof(self):
            return True
    auth = {"Authorization": "Bearer correct"}
    request = SimpleNamespace(scheme="http", host="127.0.0.1:8188", remote="127.0.0.1", headers=auth,
                              content_type="application/json", content=Content(), match_info={"job": job})
    async def run():
        start, status, _cancel = module.handlers(SimpleNamespace(accepts=lambda token: token == "correct"), Service)
        assert (await start(request)).status == 200
        first = asyncio.create_task(status(request))
        assert await asyncio.to_thread(entered.wait, 1)
        first.cancel()
        try:
            await first
        except asyncio.CancelledError:
            pass
        second = asyncio.create_task(status(request))
        # The loop continues to run, but the cancelled background thread keeps
        # its permit until it really exits.
        await asyncio.sleep(.05)
        assert len(calls) == 1
        release.set()
        assert (await asyncio.wait_for(second, 2)).status == 200
        assert len(calls) == 2
    asyncio.run(run())
