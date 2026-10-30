"""Export browser graphs from the same compilers used by the Python runtime.

Run ``python -m marcostudio.browser_export`` after changing a feature.
The checked-in catalog lets the static frontend build without Python.
"""

import inspect
import json
from dataclasses import asdict
from itertools import product
from pathlib import Path
from zipfile import ZipFile, ZipInfo

from .features import FEATURES

CATALOG = Path(__file__).resolve().parents[2] / "frontend/src/browser/catalog.json"
NODE_BUNDLE = CATALOG.parents[2] / "public/marcostudio-nodes.zip"
INSTRUCTION = "__MARCO_INSTRUCTION__"


def param(name):
    return {"$param": name}


class TemplateSettings:
    def __init__(self, feature, mode, inputs, control):
        self.defaults = feature.settings()
        self.mode = mode
        self.control_type = control
        self.guide_frames = [param(f"settings.guide_frames.{i}") for i in range(len(inputs))]

    def __getattr__(self, name):
        if name == "duration":
            return self.defaults.duration  # Character Swap casts duration to float.
        return param(f"settings.{name}")

    def prompt(self):
        return param("prompt")

    def validate_inputs(self, inputs):
        pass  # Valid combinations are enumerated below; the browser validates actual values.


def variants(feature):
    required = {s["key"] for s in feature.input_slots if s["required"]}
    optional = [s["key"] for s in feature.input_slots if not s["required"]]
    for mode in feature.modes:
        for flags in product((False, True), repeat=len(optional)):
            slots = sorted(required | {key for key, enabled in zip(optional, flags) if enabled})
            if any(
                f"{prefix}{i - 1}" not in slots
                for prefix in ("reference_", "guide_")
                for i in (2, 3)
                if f"{prefix}{i}" in slots
            ):
                continue
            for control in (("canny", "preprocessed") if feature.id == "motion-control" else ("",)):
                yield mode, slots, control


def build_catalog():
    features = []
    for feature in FEATURES.values():
        defaults = feature.settings()
        graphs = []
        for mode, slots, control in variants(feature):
            graph = feature.compile(
                TemplateSettings(feature, mode, slots, control),
                None if feature.source_kind == "none" else param("source"),
                param("prefix"),
                {m.key: param(f"models.{m.key}") for m in feature.models_for(mode)},
                inputs={key: param(f"inputs.{key}") for key in slots},
            )
            if feature.id == "character-swap":
                graph["slice"]["inputs"]["duration"] = param("settings.duration")
            graphs.append({"mode": mode, "slots": slots, "control": control, "graph": graph})
        prompt = (feature.settings(instruction="").prompt()
                  if "instruction" in feature.settings.model_fields else defaults.prompt())
        instruction_prompt = (
            feature.settings(instruction=INSTRUCTION).prompt()
            if "instruction" in feature.settings.model_fields else prompt
        )
        features.append({
            "id": feature.id, "name": feature.name, "supported_modes": list(feature.modes),
            "defaults": defaults.model_dump(), "schema": feature.settings.model_json_schema(),
            "source_kind": feature.source_kind, "source_label": feature.source_label,
            "output_kind": feature.output_kind, "input_slots": list(feature.input_slots),
            "min_source_frames": feature.min_source_frames,
            "prompt": {"empty": prompt, "instruction": instruction_prompt},
            "models": {
                mode: [asdict(m) | {"url": m.url} for m in feature.models_for(mode)]
                for mode in feature.modes
            },
            "version": feature.manifest.WORKFLOW_VERSION,
            "source_url": feature.manifest.SOURCE_URL,
            "workflow_url": "https://github.com/NeoMarcoPolo/marcostudio/blob/main/src/"
            + Path(inspect.getsourcefile(getattr(feature.compile, "func", feature.compile)))
            .relative_to(Path(__file__).resolve().parents[1]).as_posix(),
            "variants": graphs,
        })
    return {"version": 1, "features": features}


def export_nodes(destination=NODE_BUNDLE):
    """A deterministic manual node bundle, not a connector or local server."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).parent / "comfy_nodes"
    def entry(name):
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        return info

    with ZipFile(destination, "w") as archive:
        for path in sorted(source.iterdir(), key=lambda path: path.name):
            if path.suffix == ".py" or path.name in {"LICENSE", "README.md"}:
                archive.writestr(entry(f"marcostudio/{path.name}"), path.read_bytes().replace(b"\r\n", b"\n"))
        archive.writestr(entry("marcostudio/.marcostudio-nodes"),
                         "Managed by marcostudio install-nodes\n")


if __name__ == "__main__":
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps(build_catalog(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    export_nodes()
    print(f"Exported {len(FEATURES)} features")
