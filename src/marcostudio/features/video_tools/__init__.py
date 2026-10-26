"""Factory entries for the six built-in video tools; independent of the registry."""

from functools import partial

from .manifest import for_tool
from .settings import KeyframesSettings, MotionControlSettings, VideoSettings
from .workflow import compile_workflow


def _slot(key, label, *, required=False):
    return {"key": key, "label": label, "kind": "image", "required": required}


def entries() -> list[dict]:
    definitions = (
        ("create-video", "Create Video", "none", "", VideoSettings, ()),
        ("animate-image", "Animate Image", "image", "First frame", VideoSettings, ()),
        (
            "transition",
            "Transition",
            "image",
            "First frame",
            VideoSettings,
            (_slot("last_frame", "Last frame", required=True),),
        ),
        (
            "restyle-video",
            "Restyle Video",
            "video",
            "Source video",
            VideoSettings,
            (_slot("reference_1", "Reference 1"), _slot("reference_2", "Reference 2")),
        ),
        (
            "keyframes",
            "Keyframes",
            "image",
            "First frame",
            KeyframesSettings,
            (
                _slot("guide_1", "Guide 1", required=True),
                _slot("guide_2", "Guide 2"),
                _slot("guide_3", "Guide 3"),
            ),
        ),
        (
            "motion-control",
            "Motion Control",
            "video",
            "Control video",
            MotionControlSettings,
            (_slot("mask", "Edit mask (white replaces)"),),
        ),
    )
    return [
        dict(
            id=tool,
            name=name,
            source_kind=kind,
            source_label=label,
            settings=settings,
            input_slots=slots,
            output_kind="video",
            min_source_frames=5 if tool == "restyle-video" else 0,
            manifest=for_tool(tool),
            compile=partial(compile_workflow, tool),
            modes=("standard",) if tool in ("motion-control", "keyframes") else ("standard", "flash"),
        )
        for tool, name, kind, label, settings, slots in definitions
    ]
