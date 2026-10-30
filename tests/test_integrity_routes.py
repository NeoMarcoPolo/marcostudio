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
