"""Portable MarcoStudio ComfyUI custom nodes; requires native MiniMax H3 support."""

import sys

from .h3 import MarcoStudioH3InpaintLatent, MarcoStudioH3Window

NODE_CLASS_MAPPINGS = {
    "MarcoStudioH3Window": MarcoStudioH3Window,
    "MarcoStudioH3InpaintLatent": MarcoStudioH3InpaintLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MarcoStudioH3Window": "MarcoStudio H3 Source Window",
    "MarcoStudioH3InpaintLatent": "MarcoStudio H3 Inpaint Latent",
}


def _h3_pdd_capable():
    """Inspect the actual imported implementations, including an already running core."""
    try:
        from comfy.ldm.minimax.model import FinalLayer
        from comfy.model_detection import detect_unet_config

        return (
            "pdd_steps" in detect_unet_config.__code__.co_varnames
            and "pdd_steps" in FinalLayer.__init__.__code__.co_varnames
            and "_pdd_head" in FinalLayer.forward.__code__.co_names
        )
    except (ImportError, AttributeError):
        return False


def _register_routes():
    # ComfyUI creates PromptServer before loading custom nodes. Do not import or
    # start a server when the package is used by standalone CPU tests or tooling.
    server = sys.modules.get("server")
    instance = getattr(getattr(server, "PromptServer", None), "instance", None)
    if instance is None:
        return
    from aiohttp import web

    path = "/marcostudio/capabilities"
    if any(getattr(route, "path", None) == path for route in instance.routes):
        return

    @instance.routes.get(path)
    async def capabilities(request):
        return web.json_response({"version": 1, "h3_pdd": _h3_pdd_capable()})


_register_routes()
