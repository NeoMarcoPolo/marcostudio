"""Built-in creative tools."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from .character_swap import entries as character_entries
from .image_tools import entries as image_entries
from .relight import manifest as relight_manifest
from .relight.settings import RelightSettings
from .relight.workflow import compile_workflow as relight_workflow
from .remove_background import manifest as background_manifest
from .remove_background.settings import RemoveBackgroundSettings
from .remove_background.workflow import compile_workflow as background_workflow
from .video_tools import entries as video_entries


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    settings: type[BaseModel]
    compile: Callable
    manifest: Any
    modes: tuple[str, ...]
    source_kind: str = "image"
    source_label: str = "Image"
    output_kind: str = "image"
    input_slots: tuple[dict, ...] = ()
    min_source_frames: int = 0

    def parse_settings(self, value: dict):
        settings = self.settings.model_validate(value)
        if settings.mode not in self.modes:
            raise ValueError(f"{self.name} supports {', '.join(self.modes)} mode")
        return settings

    def models_for(self, mode):
        return getattr(self.manifest, "MODEL_SETS", {}).get(mode, self.manifest.MODELS)

    def validate_assets(self, source, inputs, settings):
        if self.source_kind == "none":
            if source is not None:
                raise ValueError(f"{self.name} does not accept a source")
        elif source is None or not source["media_type"].startswith(self.source_kind + "/"):
            raise ValueError(f"{self.source_label} must be an {self.source_kind} upload")
        if self.min_source_frames and source.get("frame_count", 0) < self.min_source_frames:
            raise ValueError(
                f"{self.name} needs a video with at least {self.min_source_frames} frames"
            )
        slots = {s["key"]: s for s in self.input_slots}
        if inputs.keys() - slots.keys():
            raise ValueError(
                "Unknown input slot: " + ", ".join(sorted(inputs.keys() - slots.keys()))
            )
        for key, slot in slots.items():
            if slot.get("required") and key not in inputs:
                raise ValueError(f"Add {slot['label'].lower()}")
            if key in inputs and not inputs[key]["media_type"].startswith(slot["kind"] + "/"):
                raise ValueError(f"{slot['label']} must be an {slot['kind']} upload")
        for key in inputs:
            if key.startswith("reference_"):
                for i in range(1, int(key.rsplit("_", 1)[1])):
                    if f"reference_{i}" not in inputs:
                        raise ValueError("Add references in order")
        if not settings.prompt().strip():
            raise ValueError("Enter a prompt")
        if hasattr(settings, "validate_inputs"):
            settings.validate_inputs(inputs)


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
        *(Feature(**entry) for entry in image_entries()),
        *(Feature(**entry) for entry in video_entries()),
        *(Feature(**entry) for entry in character_entries()),
    )
}


def get_feature(feature_id: str) -> Feature:
    if feature_id not in FEATURES:
        raise ValueError(f"Unknown feature: {feature_id}")
    return FEATURES[feature_id]
