from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from . import __version__
from .config import Settings, load_settings, local_url, save_settings
from .features import FEATURES, get_feature


def emit(value):
    print(json.dumps(value, indent=2, ensure_ascii=True, default=str))


def parser():
    root = argparse.ArgumentParser(prog="marcostudio", description="Local creative studio")
    root.add_argument("--version", action="version", version=__version__)
    root.add_argument("--config", type=Path, help="User configuration JSON file")
    commands = root.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Start the local studio")
    serve.add_argument("--port", type=int, default=7870)
    commands.add_parser("proxy", help="Run the local Comfy API proxy in the foreground")
    commands.add_parser("install-nodes", help="Install bundled video nodes in configured ComfyUI")
    configure = commands.add_parser("configure", help="Save local configuration")
    for flag in ("comfy-dir", "comfy-url", "proxy-url", "data-dir"):
        configure.add_argument(f"--{flag}")
    configure.add_argument("--extra-model-path", action="append", dest="extra_model_paths")
    doctor = commands.add_parser("doctor", help="Read-only dependency and model checks")
    doctor.add_argument("--feature", choices=list(FEATURES), default="relight")
    doctor.add_argument("--all", action="store_true")
    doctor.add_argument("--mode", choices=["flash", "standard"])
    doctor.add_argument("--json", action="store_true")
    doctor.add_argument("--verify-hashes", action="store_true")
    models = commands.add_parser("models", help="List pinned public model downloads")
    models.add_argument("--json", action="store_true")
    models.add_argument("--feature", choices=list(FEATURES), default="relight")
    models.add_argument("--mode", choices=["flash", "standard"])
    run = commands.add_parser("run", help="Submit to a running local studio")
    run.add_argument("feature", choices=list(FEATURES))
    run.add_argument("--server", default="http://127.0.0.1:7870")
    run.add_argument("--input", type=Path)
    run.add_argument(
        "--asset",
        action="append",
        default=[],
        metavar="NAME=PATH",
        help="Named reference input; repeat for additional references",
    )
    run.add_argument("--prompt", dest="instruction")
    for field in ("width", "height", "resolution", "duration"):
        run.add_argument(f"--{field}", type=int)
    run.add_argument("--guide-frames", type=int, nargs="+")
    run.add_argument("--control-type", choices=["canny", "preprocessed"])
    run.add_argument("--strength", type=float)
    run.add_argument("--direction", default="front")
    run.add_argument("--azimuth", type=float)
    run.add_argument("--elevation", type=float)
    run.add_argument("--softness", default="soft")
    run.add_argument("--brightness", type=int, default=50)
    run.add_argument("--color", default="#ffffff")
    run.add_argument("--mode", choices=["flash", "standard"])
    run.add_argument("--seed", type=int, default=0)
    run.add_argument(
        "--request-id", default=None, help="Reuse for an explicit retry of the same request"
    )
    run.add_argument(
        "--wait",
        type=float,
        default=0,
        help="Wait this many seconds for completion; timeout does not cancel",
    )
    jobs = commands.add_parser("jobs", help="Read or cancel the running studio's jobs")
    jobs.add_argument("--server", default="http://127.0.0.1:7870")
    actions = jobs.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    for action in ("show", "cancel"):
        actions.add_parser(action).add_argument("id")
    resolve = actions.add_parser("resolve")
    resolve.add_argument("id")
    resolve.add_argument("--confirm-not-running", action="store_true", required=True)
    return root


def request(client, method, url, **kwargs):
    response = client.request(method, url, **kwargs)
    if response.is_error:
        raise ValueError(f"HTTP {response.status_code}: {response.text[:2000]}")
    return response.json()


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "models":
            feature = get_feature(args.feature)
            mode = args.mode or feature.settings().mode
            if mode not in feature.modes:
                raise ValueError(f"{feature.name} does not support {mode}")
            models = [asdict(m) | {"url": m.url} for m in feature.models_for(mode)]
            if args.json:
                emit(models)
            else:
                for model in models:
                    print(
                        f"models/{model['category']}/{model['filename']}\n  {model['size']:,} bytes\n  SHA256 {model['sha256']}\n  {model['url']}"
                    )
            return 0
        config = load_settings(args.config)
        if args.command == "install-nodes":
            from .comfy.install import install_nodes

            destination = install_nodes(config.comfy_dir)
            emit({"installed": str(destination), "next": "Restart ComfyUI to load the nodes"})
            return 0
        if args.command == "configure":
            changes = {
                k: getattr(args, k)
                for k in ("comfy_dir", "comfy_url", "proxy_url", "data_dir", "extra_model_paths")
                if getattr(args, k) is not None
            }
            config = Settings(**(config.model_dump() | changes))
            save_settings(config, args.config)
            emit(config.model_dump(mode="json"))
            return 0
        if args.command == "doctor":
            from .comfy.doctor import diagnose

            reports = [
                asyncio.run(diagnose(config, args.mode, args.verify_hashes, feature=feature))
                for feature in (FEATURES if args.all else [args.feature])
            ]
            if args.json:
                emit(reports if args.all else reports[0])
            else:
                for report in reports:
                    if args.all:
                        print(get_feature(report["feature"]).name)
                    for check in report["checks"]:
                        print(f"{check['status'].upper():4} {check['name']}: {check['message']}")
                    print("Ready" if report["ready"] else "Setup needs attention")
            return 0 if all(report["ready"] for report in reports) else 1
        if args.command == "serve":
            import uvicorn

            from .api import create_app

            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be between 1 and 65535")
            uvicorn.run(
                create_app(config, config_file=args.config),
                host="127.0.0.1",
                port=args.port,
                proxy_headers=False,
            )
            return 0
        if args.command == "proxy":
            from comfy_api_proxy.cli import main as proxy_main

            if not config.proxy_url:
                raise ValueError("Configure a local proxy URL first")
            url = urlsplit(config.proxy_url)
            if url.scheme != "http":
                raise ValueError("The bundled local proxy uses HTTP")
            return proxy_main(
                [
                    "run",
                    "--comfyui",
                    config.comfy_url,
                    "--host",
                    url.hostname,
                    "--port",
                    str(url.port or 80),
                    "--state-dir",
                    str(config.data_dir / "proxy"),
                ]
            )
        base = local_url(args.server)
        with httpx.Client(
            timeout=config.request_timeout, trust_env=False, follow_redirects=False
        ) as client:
            if args.command == "jobs":
                if args.action == "resolve":
                    emit(
                        request(
                            client,
                            "POST",
                            base + f"/api/jobs/{args.id}/resolve",
                            json={"confirm_not_running": True},
                        )
                    )
                    return 0
                path = "/api/jobs" + (f"/{args.id}" if args.action != "list" else "")
                method = "POST" if args.action == "cancel" else "GET"
                emit(
                    request(
                        client, method, base + path + ("/cancel" if args.action == "cancel" else "")
                    )
                )
                return 0
            from .core.assets import MAX_INPUT_BYTES
            from .core.store import TERMINAL
            from .core.video import MAX_VIDEO_BYTES

            feature = get_feature(args.feature)
            settings = feature.parse_settings(
                {
                    k: getattr(args, k)
                    for k in feature.settings.model_fields
                    if getattr(args, k, None) is not None
                }
            )
            if feature.source_kind != "none" and not args.input:
                raise ValueError("This tool requires --input")
            if feature.source_kind == "none" and args.input:
                raise ValueError("This tool takes a prompt, without --input")
            paths = {}
            for value in args.asset:
                name, separator, path = value.partition("=")
                if not separator or not path or name in paths:
                    raise ValueError("Use one --asset NAME=PATH per input slot")
                paths[name] = Path(path)
            allowed = {slot["key"] for slot in feature.input_slots}
            if paths.keys() - allowed:
                raise ValueError(f"Unknown input slot; use one of: {', '.join(sorted(allowed))}")
            for slot in feature.input_slots:
                if slot["required"] and slot["key"] not in paths:
                    raise ValueError(f"Missing --asset {slot['key']}=PATH ({slot['label']})")

            def upload(path, video=False):
                limit = MAX_VIDEO_BYTES if video else MAX_INPUT_BYTES
                if path.stat().st_size > limit:
                    raise ValueError(f"Input exceeds the {limit // (1024 * 1024)} MiB upload limit")
                with path.open("rb") as source:
                    return request(
                        client, "POST", base + "/api/assets", files={"file": (path.name, source)}
                    )

            key = args.request_id or str(uuid.uuid4())
            print(f"Request ID: {key}", file=sys.stderr)
            asset = upload(args.input, feature.source_kind == "video") if args.input else None
            references = {name: upload(path)["id"] for name, path in paths.items()}
            job = request(
                client,
                "POST",
                base + "/api/jobs",
                json={
                    "feature": feature.id,
                    "source_id": asset["id"] if asset else None,
                    "inputs": references,
                    "settings": settings.model_dump(),
                    "request_id": key,
                },
            )
            deadline = time.monotonic() + max(args.wait, 0)
            while args.wait > 0 and job["status"] not in TERMINAL and time.monotonic() < deadline:
                time.sleep(min(2, max(deadline - time.monotonic(), 0)))
                job = request(client, "GET", base + f"/api/jobs/{job['id']}")
            emit(job)
            if args.wait <= 0:
                return 0
            return 0 if job["status"] == "succeeded" else 1 if job["status"] in TERMINAL else 3
    except Exception as exc:
        if args.command == "doctor" and args.json:
            emit({"ready": False, "error": str(exc), "checks": []})
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
