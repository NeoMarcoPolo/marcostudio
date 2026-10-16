from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from platformdirs import user_config_path, user_data_path
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .core.store import atomic_write


def local_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ValueError("Use a local HTTP ComfyUI URL")
    try:
        loopback = parts.hostname == "localhost" or ipaddress.ip_address(parts.hostname).is_loopback
        _ = parts.port
    except ValueError:
        loopback = False
    if not loopback or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError(
            "Only loopback URLs without credentials, queries or fragments are supported"
        )
    if parts.path not in {"", "/"}:
        raise ValueError("Use the server base URL without a path")
    return value.rstrip("/")


def expanded_path(value: str | Path) -> Path:
    return Path(os.path.expandvars(str(value))).expanduser().resolve()


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)
    comfy_url: str = "http://127.0.0.1:8188"
    proxy_url: str | None = "http://127.0.0.1:8189"
    comfy_dir: Path | None = None
    data_dir: Path = Field(default_factory=lambda: user_data_path("MarcoStudio", appauthor=False))
    extra_model_paths: list[Path] = Field(default_factory=list)
    model_aliases: dict[str, str] = Field(default_factory=dict)
    request_timeout: float = Field(default=30, ge=1, le=300)
    poll_interval: float = Field(default=2, ge=0.1, le=60)

    @field_validator("comfy_url", "proxy_url")
    @classmethod
    def validate_url(cls, value):
        return local_url(value) if value is not None else value

    @field_validator("data_dir", "comfy_dir", mode="before")
    @classmethod
    def validate_path(cls, value):
        return str(expanded_path(value)) if value is not None else None

    @field_validator("extra_model_paths", mode="before")
    @classmethod
    def validate_extra_paths(cls, value):
        return [str(expanded_path(p)) for p in value]


def config_path() -> Path:
    override = os.environ.get("MARCOSTUDIO_CONFIG")
    return (
        expanded_path(override)
        if override
        else user_config_path("MarcoStudio", appauthor=False) / "config.json"
    )


def load_settings(path: Path | None = None) -> Settings:
    path = path or config_path()
    return (
        Settings.model_validate_json(path.read_text(encoding="utf-8"))
        if path.exists()
        else Settings()
    )


def save_settings(settings: Settings, path: Path | None = None) -> None:
    path = path or config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(settings.model_dump(mode="json"), indent=2).encode("utf-8"))
