from __future__ import annotations

import asyncio
import os
import shutil
import sys
from importlib.metadata import version

import httpx
import yaml

from ..config import Settings
from ..features import FEATURES, get_feature
from .model_paths import inspect_model, model_roots, resolve_model, select_loader


def validate_inputs(node: dict, definition: dict):
    inputs = definition.get("input", {})
    fields = inputs.get("required", {}) | inputs.get("optional", {})
    required = set(inputs.get("required", {}))
    # V3 autogrow sockets are serialized as dotted inputs in API workflows.
    pending = list(fields)
    while pending:
        field = pending.pop()
        spec = fields[field]
        if spec[0] == "COMFY_AUTOGROW_V3":
            template = spec[1]["template"]
            child = next(iter(template["input"]["required"].values()))
            names = template.get("names") or [
                f"{template['prefix']}{i}" for i in range(template["max"])
            ]
            names = [f"{field}.{name}" for name in names]
            fields.pop(field)
            required.discard(field)
            fields.update(dict.fromkeys(names, child))
            if sum(name in node["inputs"] for name in names) < template.get("min", 0):
                raise ValueError(f"Too few inputs for {field}")
        elif spec[0] == "COMFY_DYNAMICCOMBO_V3":
            options = {o["key"]: o.get("inputs", {}) for o in spec[1]["options"]}
            fields[field] = ["COMBO", {"options": list(options)}]
            selected = node["inputs"].get(field)
            if selected is None:
                continue
            if not isinstance(selected, str) or selected not in options:
                raise ValueError(f"Unsupported {field}: {selected}")
            selected_inputs = options[selected]
            for group in ("required", "optional"):
                for key, value in selected_inputs.get(group, {}).items():
                    name = f"{field}.{key}"
                    fields[name] = value
                    pending.append(name)
                    if group == "required":
                        required.add(name)
    for field in required:
        if field not in node["inputs"]:
            raise ValueError(f"Required input {field} is absent from the supported workflow")
    dynamic = {
        (m.loader, m.field) for feature in FEATURES.values() for m in feature.manifest.MODELS
    } | {("LoadImage", "image"), ("LoadVideo", "file")}
    for field, value in node["inputs"].items():
        if field not in fields:
            raise ValueError(f"Workflow input {field} is not supported")
        spec = fields[field]
        if not isinstance(spec, list) or not spec:
            raise ValueError(f"Invalid input definition for {field}")
        if isinstance(value, list) or (node["class_type"], field) in dynamic:
            continue
        kind = spec[0]
        if isinstance(kind, list) and value not in kind:
            raise ValueError(f"Unsupported {field}: {value}")
        if kind == "INT" and type(value) is not int:
            raise ValueError(f"Invalid integer for {field}")
        if kind == "FLOAT" and type(value) not in {int, float}:
            raise ValueError(f"Invalid number for {field}")
        if kind == "STRING" and not isinstance(value, str):
            raise ValueError(f"Invalid text for {field}")
        limits = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        if kind == "COMBO" and value not in limits.get("options", []):
            raise ValueError(f"Unsupported {field}: {value}")
        if type(value) in {int, float}:
            if value < limits.get("min", float("-inf")) or value > limits.get("max", float("inf")):
                raise ValueError(f"Value for {field} is outside the runtime's bounds")


async def diagnose(
    config: Settings,
    mode: str | None = None,
    verify_hashes: bool = False,
    client: httpx.AsyncClient | None = None,
    *,
    feature: str = "relight",
) -> dict:
    if client is None:
        async with httpx.AsyncClient(timeout=config.request_timeout, trust_env=False) as owned:
            return await diagnose(config, mode, verify_hashes, owned, feature=feature)
    tool = get_feature(feature)
    mode = mode or tool.settings().mode
    checks, models, runtime, identities = [], {}, {}, {}

    def record(name, status, message):
        checks.append({"name": name, "status": status, "message": str(message)})

    record("python", "pass" if sys.version_info >= (3, 12) else "fail", sys.version.split()[0])
    if mode not in tool.modes:
        record("mode", "fail", f"{tool.name} supports {', '.join(tool.modes)} mode")
    try:
        roots = model_roots(config)
        record("model_paths", "pass", "Configured model paths resolved")
    except (OSError, ValueError, yaml.YAMLError) as exc:
        roots = {}
        record("model_paths", "fail", exc)
    if not config.comfy_dir:
        record(
            "installation", "fail", "Set your ComfyUI directory in Settings to verify model files"
        )
    elif not (config.comfy_dir / "main.py").is_file():
        record("installation", "fail", "ComfyUI main.py is missing from the configured directory")
    else:
        record("installation", "pass", "ComfyUI installation found")
    try:
        result = await client.get(f"{config.comfy_url}/system_stats")
        result.raise_for_status()
        runtime = result.json()
        record("runtime", "pass", "ComfyUI is reachable")
    except (httpx.HTTPError, ValueError) as exc:
        record("runtime", "fail", f"ComfyUI unreachable or response invalid: {type(exc).__name__}")

    if feature == "restyle-video" and mode == "flash":
        try:
            response = await client.get(f"{config.comfy_url}/marcostudio/capabilities")
            response.raise_for_status()
            capabilities = response.json()
            if capabilities.get("version") != 1 or capabilities.get("h3_pdd") is not True:
                raise ValueError("Update ComfyUI to a revision with MiniMax H3 PDD support, then restart it")
            record("h3_pdd", "pass", "Running ComfyUI supports FastH3 OmniRef prediction heads")
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            record(
                "h3_pdd", "fail",
                str(exc) if isinstance(exc, ValueError) else
                "Cannot verify FastH3 support. Run marcostudio install-nodes, then restart ComfyUI",
            )

    record(
        "sdk",
        "pass",
        f"comfy-sdk {version('comfy-sdk')}; comfy-api-proxy {version('comfy-api-proxy')}",
    )
    try:
        if not config.proxy_url:
            raise ValueError("Configure the local API proxy URL")
        result = await client.get(f"{config.proxy_url}/api/v2/health")
        result.raise_for_status()
        health = result.json()
        if health.get("status") != "healthy":
            raise ValueError("Proxy did not report healthy")
        if str(health.get("upstream", "")).rstrip("/") != config.comfy_url:
            raise ValueError("Proxy upstream differs from the configured ComfyUI URL")
        record("proxy", "pass", "Local proxy reachable and upstream matches")
    except (httpx.HTTPError, ValueError) as exc:
        record("proxy", "fail", f"Proxy unavailable or incompatible: {exc}")

    selected_mode = mode if mode in tool.modes else tool.modes[0]
    sample_inputs = {s["key"]: "reference.png" for s in tool.input_slots}
    sample_settings = {"mode": selected_mode}
    if "guide_frames" in tool.settings.model_fields:
        sample_settings["guide_frames"] = [24 * (index + 1) for index in range(len(sample_inputs))]
    graph = tool.compile(
        tool.settings(**sample_settings),
        None
        if tool.source_kind == "none"
        else "source.mp4"
        if tool.source_kind == "video"
        else "source.png",
        "readiness",
        {},
        inputs=sample_inputs,
    )
    nodes = list(graph.values())
    if feature == "motion-control":
        # Masked edits and edge-guided motion require different native nodes.
        unmasked = tool.compile(
            tool.settings(**sample_settings), "source.mp4", "readiness", {}, inputs={}
        )
        nodes.extend(unmasked.values())
    if tool.output_kind == "video":
        for command in ("ffmpeg", "ffprobe"):
            record(
                command,
                "pass" if shutil.which(command) else "fail",
                f"{command} is available"
                if shutil.which(command)
                else f"Add {command} to PATH for video tools",
            )
    classes = sorted({n["class_type"] for n in nodes})
    definitions = {}
    semaphore = asyncio.Semaphore(4)

    async def inspect_node(kind):
        async with semaphore:
            try:
                response = await client.get(f"{config.comfy_url}/object_info/{kind}")
                response.raise_for_status()
                definition = response.json().get(kind)
                if not definition:
                    hint = "; run marcostudio install-nodes and restart ComfyUI" if kind.startswith("MarcoStudio") else ""
                    record(f"node:{kind}", "fail", f"Required node is not registered: {kind}{hint}")
                    return
                definitions[kind] = definition
                for node in (n for n in nodes if n["class_type"] == kind):
                    validate_inputs(node, definition)
                record(f"node:{kind}", "pass", f"{kind} registered and input contract compatible")
            except (httpx.HTTPError, ValueError) as exc:
                record(
                    f"node:{kind}",
                    "fail",
                    f"Node check indeterminate or incompatible: {kind}: {exc}",
                )

    if runtime:
        await asyncio.gather(*(inspect_node(kind) for kind in classes))
    requirements = []
    for model in tool.models_for(selected_mode):
        available = False
        try:
            inputs = definitions.get(model.loader, {}).get("input", {})
            fields = inputs.get("required", {}) | inputs.get("optional", {})
            spec = fields.get(model.field, [[]])
            choices = spec[1].get("options", []) if spec[0] == "COMBO" else spec[0]
            if not isinstance(choices, list):
                raise ValueError("Loader model choices are unavailable")
            if definitions:
                name = select_loader(choices, model.filename, config.model_aliases.get(model.key))
                models[model.key] = name
            else:
                name = config.model_aliases.get(model.key, model.filename)
            path = resolve_model(roots.get(model.category, []), name)
            identity = await asyncio.to_thread(inspect_model, path, model, verify_hashes)
            identities[model.key] = identity | {"loader_name": name}
            available = True
            record(
                f"model:{model.key}",
                "pass",
                f"{name}: size and header verified"
                + (", SHA256 verified" if verify_hashes else "; SHA256 unverified"),
            )
        except (OSError, ValueError) as exc:
            record(f"model:{model.key}", "fail", exc)
        requirements.append(
            {
                "filename": model.filename,
                "category": model.category,
                "url": model.url,
                "size": model.size,
                "available": available,
            }
        )
    ancestor = config.data_dir
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    accessible = ancestor.is_dir() and os.access(ancestor, os.W_OK)
    record(
        "storage",
        "pass" if accessible else "fail",
        "Data directory parent is writable" if accessible else "Data directory is not writable",
    )
    if not verify_hashes:
        record(
            "hashes",
            "warn",
            "Exact checkpoint identities are unverified; run doctor --verify-hashes",
        )
    return {
        "ready": not any(c["status"] == "fail" for c in checks),
        "checks": checks,
        "models": models,
        "runtime": runtime,
        "identities": identities,
        "mode": mode,
        "feature": feature,
        "model_requirements": requirements,
    }
