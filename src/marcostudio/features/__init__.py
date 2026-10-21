"""Built-in creative tools."""

from collections.abc import Callable
from dataclasses import dataclass
from types import ModuleType

from pydantic import BaseModel

from .relight import manifest as relight_manifest
from .relight.settings import RelightSettings
from .relight.workflow import compile_workflow as relight_workflow
from .remove_background import manifest as background_manifest
from .remove_background.settings import RemoveBackgroundSettings
from .remove_background.workflow import compile_workflow as background_workflow


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    settings: type[BaseModel]
    compile: Callable
    manifest: ModuleType
    modes: tuple[str, ...]

    def parse_settings(self, value: dict):
        settings = self.settings.model_validate(value)
        if settings.mode not in self.modes:
            raise ValueError(f"{self.name} supports {', '.join(self.modes)} mode")
        return settings


FEATURES = {
    f.id: f
    for f in (
        Feature(
            "relight", "Relight", RelightSettings, relight_workflow, relight_manifest, ("flash",)
        ),
        Feature(
            "remove-background",
            "Remove Background",
            RemoveBackgroundSettings,
            background_workflow,
            background_manifest,
            ("standard",),
        ),
    )
}


def get_feature(feature_id: str) -> Feature:
    if feature_id not in FEATURES:
        raise ValueError(f"Unknown feature: {feature_id}")
    return FEATURES[feature_id]
