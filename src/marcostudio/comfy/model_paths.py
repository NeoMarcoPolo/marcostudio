from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path, PurePosixPath

import yaml

from ..config import Settings, expanded_path
from ..features.models import Model

CATEGORIES = {
    "diffusion_models": ["unet", "diffusion_models"],
    "text_encoders": ["text_encoders", "clip"],
    "vae": ["vae"],
    "loras": ["loras"],
    "model_patches": ["model_patches"],
}


def relative_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not name or path.is_absolute() or ".." in path.parts or ":" in name:
        raise ValueError("Model and output names must be relative paths without traversal")
    return normalized


def model_roots(config: Settings) -> dict[str, list[Path]]:
    roots = {key: [] for key in CATEGORIES}
    if config.comfy_dir:
        for key, folders in CATEGORIES.items():
            roots[key] = [config.comfy_dir / "models" / folder for folder in folders]
    configs = []
    if config.comfy_dir and (config.comfy_dir / "extra_model_paths.yaml").exists():
        configs.append(config.comfy_dir / "extra_model_paths.yaml")
    configs.extend(config.extra_model_paths)
    for source in dict.fromkeys(configs):
        content = yaml.safe_load(source.read_text(encoding="utf-8")) or {}
        if not isinstance(content, dict):
            raise ValueError(f"Invalid model-path mapping: {source.name}")
        for group in content.values():
            if group is None:
                continue
            if not isinstance(group, dict):
                raise ValueError("Model path groups must be mappings")
            base = Path(os.path.expandvars(str(group.get("base_path", ".")))).expanduser()
            if not base.is_absolute():
                base = source.parent / base
            for alias, value in group.items():
                category = next((k for k, aliases in CATEGORIES.items() if alias in aliases), None)
                if category is not None:
                    if not isinstance(value, str):
                        raise ValueError("Model path values must be newline-separated strings")
                    for value in value.splitlines():
                        if value.strip():
                            path = Path(os.path.expandvars(value.strip())).expanduser()
                            path = (base / path).resolve()
                            if group.get("is_default", False):
                                if path in roots[category]:
                                    roots[category].remove(path)
                                roots[category].insert(0, path)
                            elif path not in roots[category]:
                                roots[category].append(path)
    return {
        key: list(dict.fromkeys(expanded_path(p) for p in paths)) for key, paths in roots.items()
    }


def select_loader(choices: list[str], filename: str, alias: str | None = None) -> str:
    wanted = relative_name(alias or filename)
    exact = [c for c in choices if relative_name(c) == wanted]
    if alias:
        matches = exact
    else:
        matches = [c for c in choices if PurePosixPath(relative_name(c)).name == filename]
    if len(matches) > 1:
        raise ValueError(f"Model basename is ambiguous; configure an exact alias: {filename}")
    if not matches:
        raise ValueError(f"Model is not registered in its loader: {wanted}")
    return matches[0]


def resolve_model(roots: list[Path], name: str) -> Path:
    relative = relative_name(name)
    for root in roots:
        candidate = root / relative
        if candidate.is_file():
            return candidate.resolve()
    raise ValueError(f"Model not found in configured model paths: {name}")


def inspect_model(path: Path, model: Model, verify_hash: bool) -> dict:
    size = path.stat().st_size
    if size != model.size:
        raise ValueError(f"Wrong file size for {model.filename}: expected {model.size}, got {size}")
    with path.open("rb") as stream:
        prefix = stream.read(8)
        if len(prefix) != 8:
            raise ValueError("Incomplete safetensors header")
        length = struct.unpack("<Q", prefix)[0]
        if not 2 <= length <= min(16 * 1024 * 1024, size - 8):
            raise ValueError("Invalid safetensors header length")
        try:
            header = json.loads(stream.read(length))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("Invalid safetensors metadata") from exc
        if not isinstance(header, dict):
            raise ValueError("Invalid safetensors header")
        tensors = [v for k, v in header.items() if k != "__metadata__"]
        if not tensors:
            raise ValueError("Safetensors contains no tensors")
        for tensor in tensors:
            if not isinstance(tensor, dict):
                raise ValueError("Invalid tensor metadata")
            offsets = tensor.get("data_offsets", [])
            if (
                not isinstance(offsets, list)
                or len(offsets) != 2
                or not all(type(n) is int for n in offsets)
                or not 0 <= offsets[0] <= offsets[1] <= size - 8 - length
                or not isinstance(tensor.get("shape"), list)
                or not all(type(n) is int and n >= 0 for n in tensor.get("shape", []))
                or not isinstance(tensor.get("dtype"), str)
                or not tensor.get("dtype")
            ):
                raise ValueError("Invalid safetensors tensor offsets or shape")
        digest = None
        if verify_hash:
            stream.seek(0)
            hasher = hashlib.sha256()
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                hasher.update(chunk)
            digest = hasher.hexdigest()
            if digest != model.sha256:
                raise ValueError(f"SHA256 mismatch for {model.filename}")
    return {"size": size, "hash_verified": verify_hash, "sha256": digest}
