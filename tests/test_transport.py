import io
from contextlib import asynccontextmanager

import httpx
import pytest
from aiohttp import web
from PIL import Image


@asynccontextmanager
async def serve(app):
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_released_sdk_proxy_upload_submit_recover_and_download(tmp_path):
    from comfy_api_proxy.app import make_app

    from marcostudio.comfy.transport import ComfyTransport
    from marcostudio.config import Settings

    picture = io.BytesIO()
    Image.new("RGB", (32, 48), "red").save(picture, format="PNG")
    data = picture.getvalue()
    history = {}
    received = []

    async def upload(request):
        form = await request.post()
        assert form["image"].file.read() == data
        return web.json_response({"name": "source.png", "subfolder": "", "type": "input"})

    async def submit(request):
        body = await request.json()
        received.append(body)
        job_id = body["prompt_id"]
        history[job_id] = {
            "prompt": [1, job_id, body["prompt"], {}, ["12"]],
            "status": {"status_str": "success", "completed": True, "messages": []},
            "outputs": {
                "12": {"images": [{"filename": "result.png", "subfolder": "", "type": "output"}]}
            },
        }
        return web.json_response({"prompt_id": job_id, "number": 1, "node_errors": {}})

    async def get_history(request):
        jid = request.match_info["id"]
        return web.json_response({jid: history[jid]} if jid in history else {})

    async def queue(request):
        return web.json_response({"queue_running": [], "queue_pending": []})

    async def view(request):
        return web.Response(body=data, content_type="image/png")

    upstream = web.Application()
    upstream.router.add_post("/upload/image", upload)
    upstream.router.add_post("/prompt", submit)
    upstream.router.add_get("/history/{id}", get_history)
    upstream.router.add_get("/queue", queue)
    upstream.router.add_get("/view", view)
    async with serve(upstream) as native:
        async with serve(make_app(native, state_dir=tmp_path / "proxy")) as proxy:
            config = Settings(comfy_url=native, proxy_url=proxy, data_dir=tmp_path)
            async with ComfyTransport(config) as transport:
                reference = await transport.upload(data, "source.png")
                graph = {
                    "11": {"class_type": "LoadImage", "inputs": {"image": reference}},
                    "12": {
                        "class_type": "SaveImage",
                        "inputs": {"images": ["11", 0], "filename_prefix": "result"},
                    },
                }
                jid = await transport.submit(graph, "once-only")
            async with ComfyTransport(config) as recovered:
                state = await recovered.state(jid)
                assert state["status"] == "succeeded"
                assert await recovered.output(state["outputs"][0], jid) == data
                with pytest.raises(Exception):
                    await recovered.submit(graph, "once-only")
            assert len(received) == 1
            assert received[0]["prompt"]["11"]["inputs"]["image"] == "source.png"


@pytest.mark.asyncio
async def test_cancel_rejects_upstream_failure_and_never_uses_global_interrupt(tmp_path):
    from marcostudio.comfy.transport import ComfyTransport
    from marcostudio.config import Settings

    seen = []

    def response(request):
        seen.append(request.url.path)
        return httpx.Response(404, json={"error": "unsupported"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
        async with ComfyTransport(Settings(data_dir=tmp_path), client=client) as transport:
            with pytest.raises(ValueError, match="cancellation"):
                await transport.cancel("12345678-1234-1234-1234-123456789abc")
    assert seen == ["/api/jobs/12345678-1234-1234-1234-123456789abc/cancel"]


@pytest.mark.parametrize(
    "event,expected", [("execution_error", "failed"), ("execution_interrupted", "canceled")]
)
async def test_native_error_history_is_terminal_even_when_completed_false(
    tmp_path, event, expected
):
    from comfy_api_proxy.app import make_app

    from marcostudio.comfy.transport import ComfyTransport
    from marcostudio.config import Settings

    jid = "12345678-1234-1234-1234-123456789abc"

    async def history(request):
        return web.json_response(
            {
                jid: {
                    "status": {
                        "status_str": "error",
                        "completed": False,
                        "messages": [
                            [event, {"prompt_id": jid, "exception_message": "test failure"}]
                        ],
                    },
                    "outputs": {},
                }
            }
        )

    upstream = web.Application()
    upstream.router.add_get("/history/{id}", history)
    async with serve(upstream) as native:
        async with serve(make_app(native, state_dir=tmp_path / "proxy")) as proxy:
            async with ComfyTransport(
                Settings(comfy_url=native, proxy_url=proxy, data_dir=tmp_path)
            ) as transport:
                assert (await transport.state(jid))["status"] == expected
