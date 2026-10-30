"""Offline storage-space probe for an already-authorized model destination.

The caller must resolve the actual Manager destination and authorize its path.
This module neither accepts network requests nor reports filesystem paths. A
result is a point-in-time observation, not a reservation or guarantee that a
download will fit. If the destination does not exist, its nearest existing
ancestor is measured; callers must recheck after creating the destination.
"""

import os
import stat
from pathlib import Path
from typing import NamedTuple


class StorageSpace(NamedTuple):
    status: str
    available_bytes: int | None = None
    device: int | None = None


def available_space(destination: Path) -> StorageSpace:
    """Return user-available bytes for a single authorized destination.

    Do not fall back to another location when a path exists but is inaccessible,
    is not a directory, or is a dangling symlink. Failure is deliberately coarse
    so callers cannot accidentally disclose a local path or operating-system error.
    """
    if (not isinstance(destination, Path) or not destination.is_absolute()
            or ".." in destination.parts or os.name != "posix"
            or not hasattr(os, "fstatvfs")
            or not (hasattr(os, "O_DIRECTORY") or hasattr(os, "O_NONBLOCK"))):
        return StorageSpace("unavailable")
    current = destination
    missing = []
    while True:
        try:
            # lstat distinguishes a missing directory from a dangling symlink.
            current.lstat()
        except FileNotFoundError:
            missing.append(current)
            parent = current.parent
            if parent == current:
                return StorageSpace("unavailable")
            current = parent
            continue
        except OSError:
            return StorageSpace("unavailable")

        # A directory that disappears or a dangling symlink is not an absent
        # child: do not fall back to a different filesystem in those cases.
        descriptor = None
        try:
            before = current.stat()
            if not stat.S_ISDIR(before.st_mode):
                return StorageSpace("unavailable")
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NONBLOCK", 0)
            descriptor = os.open(current, flags)
            opened = os.fstat(descriptor)
            if not stat.S_ISDIR(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                return StorageSpace("unavailable")
            info = os.fstatvfs(descriptor)
            final = os.fstat(descriptor)
            current_info = current.stat()
            if (opened.st_dev, opened.st_ino) != (final.st_dev, final.st_ino) or (
                opened.st_dev, opened.st_ino
            ) != (current_info.st_dev, current_info.st_ino):
                return StorageSpace("unavailable")
            # A formerly missing child may now point to another filesystem.
            for child in reversed(missing):
                try:
                    child.lstat()
                except FileNotFoundError:
                    continue
                return StorageSpace("unavailable")
            if type(info.f_bavail) is not int or type(info.f_frsize) is not int or info.f_bavail < 0 or info.f_frsize <= 0:
                return StorageSpace("unavailable")
            return StorageSpace("available", info.f_bavail * info.f_frsize, opened.st_dev)
        except OSError:
            return StorageSpace("unavailable")
        finally:
            if descriptor is not None:
                os.close(descriptor)


def manager_default_space(filename: str, model_type: str) -> StorageSpace:
    """Measure Manager's actual default destination for trusted catalog metadata.

    This is an offline primitive, not an authorization boundary. Callers must
    select both arguments from a trusted catalog, never from a network request.
    It invokes the installed Manager's own resolver rather than guessing model
    folders. If the Manager is absent, incompatible, or its mapping changes
    while measuring, the result is unavailable. No path is returned.
    """
    if (not isinstance(filename, str) or not filename or filename in {".", "..", "<huggingface>"}
            or any(char in filename for char in ("/", "\\", ":"))
            or not isinstance(model_type, str) or not model_type):
        return StorageSpace("unavailable")
    try:
        from comfyui_manager.glob.constants import model_dir_name_map
        from comfyui_manager.glob.utils.model_utils import get_model_dir
    except (ImportError, SystemExit):
        # Some Manager versions terminate when their standalone environment is
        # incomplete; this optional probe must not terminate the host process.
        return StorageSpace("unavailable")
    try:
        if model_type.lower() not in model_dir_name_map:
            return StorageSpace("unavailable")
        data = {"filename": filename, "type": model_type, "save_path": "default"}
        first = get_model_dir(data)
        if not isinstance(first, str):
            return StorageSpace("unavailable")
        result = available_space(Path(first))
        if get_model_dir(data) != first:
            return StorageSpace("unavailable")
        return result
    except (ImportError, OSError, KeyError, IndexError, TypeError, ValueError, AttributeError):
        return StorageSpace("unavailable")
