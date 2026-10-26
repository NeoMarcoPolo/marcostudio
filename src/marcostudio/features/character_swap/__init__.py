"""A bounded, explicit identity-replacement tool, separate from general restyling."""

from . import manifest
from .settings import CharacterSwapSettings
from .workflow import compile_workflow


def entries() -> list[dict]:
    return [
        dict(
            id="character-swap",
            name="Replace Person",
            settings=CharacterSwapSettings,
            compile=compile_workflow,
            manifest=manifest,
            modes=("standard",),
            source_kind="video",
            source_label="Source performance",
            output_kind="video",
            min_source_frames=5,
            input_slots=(
                {
                    "key": "reference_1",
                    "label": "Full-body reference",
                    "kind": "image",
                    "required": True,
                },
            ),
        )
    ]
