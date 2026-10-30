"""Portable MarcoStudio ComfyUI custom nodes; requires native MiniMax H3 support."""

import atexit
import logging
import os
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

    pairing = None
    integrity = False
    if os.environ.get("MARCOSTUDIO_ENABLE_STORAGE_PAIRING") == "1":
        try:
            from .storage_routes import storage_handler

            if os.name == "nt":
                if os.environ.get("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE") != "1":
                    raise RuntimeError("Windows storage pairing requires experimental opt-in")
                from .storage_pairing_windows import WindowsOwnerPairing

                pairing = WindowsOwnerPairing()
                location = pairing.target
                label = "credential target"
            else:
                from .integrity_routes import handlers as integrity_handlers
                from .storage_pairing import OwnerPairing

                pairing = OwnerPairing()
                location = pairing.path
                label = "socket"
                start, status, cancel = integrity_handlers(pairing)
                instance.routes.post("/marcostudio/integrity")(start)
                instance.routes.get("/marcostudio/integrity/{job}")(status)
                instance.routes.post("/marcostudio/integrity/{job}/cancel")(cancel)
                integrity = True
            instance.routes.get("/marcostudio/storage")(storage_handler(pairing))
            atexit.register(pairing.close)
            # The socket path or credential target is not the pairing secret.
            logging.info("MarcoStudio storage pairing %s: %s", label, location)
        except (ImportError, OSError, RuntimeError):
            if pairing is not None:
                try:
                    pairing.close()
                except OSError:
                    logging.warning("MarcoStudio pairing credential cleanup failed")
                pairing = None
            integrity = False
            logging.warning("MarcoStudio storage pairing unavailable")

    @instance.routes.get(path)
    async def capabilities(request):
        return web.json_response({"version": 1, "h3_pdd": _h3_pdd_capable(),
                                  "storage_pairing": 1 if pairing else 0,
                                  "integrity_verification": 1 if integrity else 0})


_register_routes()
