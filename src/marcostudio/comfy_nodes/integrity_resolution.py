"""Offline loader-path resolution for trusted model identities.

The caller must authenticate requests and match the client catalog first. This
function does not publish readiness: node-specific object_info may have a
choice list different from folder_paths, and paths can change after this call.
"""

from pathlib import Path, PurePosixPath
from typing import NamedTuple

from .integrity_catalog import MODELS


class Resolved(NamedTuple):
    status: str
    path: Path | None = None
    size: int | None = None
    digest: str | None = None
    choice: str | None = None


def resolve(identity: str, folder_paths) -> Resolved:
    """Resolve only a catalog identity using ComfyUI's own category lookup."""
    try:
        metadata = MODELS.get(identity)
        if metadata is None:
            return Resolved("unavailable")
        filename, category, size = metadata
        choices = list(folder_paths.get_filename_list(category))
        matches = [choice for choice in choices if isinstance(choice, str)
                   and choice.replace("\\", "/").split("/")[-1] == filename]
        choice = filename if filename in matches else matches[0] if len(matches) == 1 else None
        if choice is None:
            return Resolved("ambiguous" if len(matches) > 1 else "missing")
        normalized = choice.replace("\\", "/")
        parts = PurePosixPath(normalized)
        if parts.is_absolute() or ":" in normalized or any(part in (".", "..") for part in parts.parts):
            return Resolved("unavailable")
        resolved = folder_paths.get_full_path(category, choice)
        if not resolved or not Path(resolved).is_absolute():
            return Resolved("unavailable")
        # Resolver and listing may change while resolving. A changed list/path
        # must not produce a positive observation.
        after = list(folder_paths.get_filename_list(category))
        if choices != after or folder_paths.get_full_path(category, choice) != resolved:
            return Resolved("changed")
        return Resolved("resolved", Path(resolved), size, identity, choice)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return Resolved("unavailable")
