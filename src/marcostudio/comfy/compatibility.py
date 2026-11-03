from __future__ import annotations

import re

RELIGHT_PROFILE = "qwen2509-relight-flash-v1"


def device_compatibility(feature: str, profile: str | None, runtime: object) -> dict | None:
    """Preflight for this Relight profile, not an inference or memory guarantee."""
    if feature != "relight":
        return None
    result = {"name": "device:relight", "status": "fail", "message": ""}
    devices = runtime.get("devices") if isinstance(runtime, dict) else None
    primary = devices[0] if isinstance(devices, list) and devices else None
    kind = primary.get("type") if isinstance(primary, dict) else None
    kind = kind.strip().lower() if isinstance(kind, str) else None
    if kind in {"cpu", "cuda"}:
        return result | {"status": "pass", "message": f"Selected ComfyUI device: {kind}."}
    if kind != "mps":
        return result | {
            "message": "Couldn't verify ComfyUI's selected device for Relight. Check the connected runtime's device metadata before generating."
        }
    if profile != RELIGHT_PROFILE:
        return result | {
            "message": "This Relight workflow's MPS compatibility has not been validated. Review its runtime profile before generating."
        }
    system = runtime.get("system")
    version = system.get("pytorch_version") if isinstance(system, dict) else None
    if (
        not isinstance(version, str)
        or len(version) > 64
        or not re.fullmatch(r"[A-Za-z0-9.+_-]+", version)
    ):
        version = None
    match = re.fullmatch(
        r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:(?:a|b|rc)\d+|(?:\.dev|\.post)\d+)?(?:\+[A-Za-z0-9._-]+)?",
        version or "",
    )
    if not match:
        message = "Relight's current FP8 models and LoRAs are not validated on MPS, and its PyTorch version could not be verified. Choose a compatible runtime before generating."
    elif tuple(map(int, match.group(1, 2))) >= (2, 15):
        message = f"PyTorch 2.15 added MPS FP8 support (detected {version}), but this Relight profile and its memory use remain unvalidated on MPS. MarcoStudio cannot mark it Ready."
    else:
        message = f"Relight's current FP8 models and LoRAs have known MPS failures with older PyTorch (detected {version}). A validated Mac profile is not available yet. Choose a compatible runtime before generating."
    return result | {"message": message}
