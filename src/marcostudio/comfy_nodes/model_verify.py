"""Dependency-free, offline model verification primitive.

Callers must resolve an authorized model to the exact loader path and provide
trusted catalog metadata. This module does not resolve paths or expose routes.
The returned identity describes the file observed at verification time only;
callers must revalidate it before reuse, and it cannot guarantee the file stays
unchanged until ComfyUI subsequently loads it.

Stat identity alone is not a proven cache guarantee on every filesystem.
Windows can expose ``st_ctime`` as creation time, and network or coarse-time
filesystems can provide weaker change signals. Callers must perform a fresh
hash unless their actual filesystem's cache safety is independently proven.
Callers must serialize cancellation against publication under their own lock;
the final cancellation check alone cannot make those concurrent actions atomic.
"""

import hashlib
import hmac
import os
import stat
from pathlib import Path
from typing import Callable, NamedTuple


class FileIdentity(NamedTuple):
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int


class Verification(NamedTuple):
    # A caller must only treat "verified" as success. Other states are
    # deliberately coarse: never disclose a local path or raw OS error.
    status: str
    identity: FileIdentity | None = None


def _identity(info: os.stat_result) -> FileIdentity:
    return FileIdentity(info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def supports_identity_cache() -> bool:
    """Whether stat-only identity is proven safe for reuse by default.

    Fail closed on every platform: stat metadata semantics vary by filesystem,
    not only OS. A caller that independently proves a stronger mechanism must
    still re-resolve the loader path and guard against later file changes.
    """
    return False


def verify_file(
    path: Path,
    expected_size: int,
    expected_sha256: str,
    *,
    cancelled: Callable[[], bool] | None = None,
    chunk_size: int = 1024 * 1024,
) -> Verification:
    """Hash one *already authorized* file and compare its identity and digest.

    No network access, path selection, retry, cache, or background thread is
    provided. Cancellation is checked between reads. Identity should be checked
    again against both loader resolution and stat before cached results are used.
    """
    if (
        type(expected_size) is not int
        or expected_size < 0
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(c not in "0123456789abcdef" for c in expected_sha256)
        or type(chunk_size) is not int
        or chunk_size <= 0
    ):
        return Verification("invalid_metadata")
    # Windows metadata can remain unchanged during a write to an open file.
    # Until a Windows handle-based change guard is validated, never publish a
    # successful verification from this primitive there.
    if os.name == "nt":
        return Verification("unavailable")
    try:
        initial = path.stat()
        if not stat.S_ISREG(initial.st_mode):
            return Verification("unavailable")
        # A file may be replaced after stat. Nonblocking open prevents a swapped
        # FIFO from hanging the single verification worker before fstat.
        flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or _identity(initial) != _identity(opened):
                return Verification("changed")
            if opened.st_size != expected_size:
                return Verification("size_mismatch")
            hasher = hashlib.sha256()
            read_size = 0
            while read_size < expected_size:
                if cancelled is not None and cancelled():
                    return Verification("cancelled")
                chunk = stream.read(min(chunk_size, expected_size - read_size))
                if not chunk:
                    break
                read_size += len(chunk)
                hasher.update(chunk)
            if cancelled is not None and cancelled():
                return Verification("cancelled")
            # Bound reads even if a file grows continuously; an extra byte is
            # sufficient to detect growth beyond the trusted catalog size.
            extra = stream.read(1)
            final = os.fstat(stream.fileno())
            current = path.stat()
            if _identity(opened) != _identity(final) or _identity(final) != _identity(current) or read_size != expected_size or extra:
                return Verification("changed")
            if not hmac.compare_digest(hasher.hexdigest(), expected_sha256):
                return Verification("hash_mismatch")
            if cancelled is not None and cancelled():
                return Verification("cancelled")
            return Verification("verified", _identity(final))
    except FileNotFoundError:
        return Verification("missing")
    except OSError:
        return Verification("unavailable")
