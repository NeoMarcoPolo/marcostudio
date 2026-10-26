"""Copy the bundled video nodes into an explicitly configured ComfyUI checkout."""

import shutil
from pathlib import Path


def install_nodes(comfy_dir: Path | None) -> Path:
    if comfy_dir is None or not (comfy_dir / "main.py").is_file():
        raise ValueError("Configure a ComfyUI directory containing main.py first")
    destination = comfy_dir / "custom_nodes" / "marcostudio"
    marker = destination / ".marcostudio-nodes"
    if destination.exists() and not marker.is_file():
        raise ValueError("custom_nodes/marcostudio already exists and is not managed by MarcoStudio")
    source = Path(__file__).resolve().parents[1] / "comfy_nodes"
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.glob("*.py"):
        shutil.copyfile(path, destination / path.name)
    shutil.copyfile(source / "LICENSE", destination / "LICENSE")
    marker.write_text("Managed by marcostudio install-nodes\n", encoding="utf-8")
    return destination
