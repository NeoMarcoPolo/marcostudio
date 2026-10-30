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


def _verify_windows(path, expected_size, expected_sha256, cancelled, chunk_size, *, diagnose=None):
    """Hash an NTFS file on a fixed-type drive while write/delete opens are excluded.

    This is a historical observation, not a future-load guarantee. Windows
    sharing checks do not prove that previously created writable mappings cannot
    alter bytes. File metadata and the trusted digest are checked while the
    read handle remains open; callers must never reuse the result as a cache.
    """
    import ctypes
    import re
    from ctypes import wintypes

    if not hasattr(ctypes, "WinDLL"):
        return Verification("unavailable")
    import msvcrt

    class BasicInfo(ctypes.Structure):
        _fields_ = [("creation", ctypes.c_longlong), ("access", ctypes.c_longlong),
                    ("write", ctypes.c_longlong), ("change", ctypes.c_longlong),
                    ("attributes", wintypes.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    kernel.GetDriveTypeW.restype = wintypes.UINT
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                                              wintypes.LPVOID, wintypes.LPVOID, wintypes.LPVOID,
                                              wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x08000000, None)
    if handle in (None, ctypes.c_void_p(-1).value):
        return Verification("missing" if ctypes.get_last_error() in (2, 3) else "unavailable")
    descriptor = None
    owns_native = True
    try:
        if kernel.GetFileType(handle) != 1:
            return Verification("unavailable")
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 1)
        match = re.match(r"^(\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\)", buffer.value) if length and length < len(buffer) else None
        if not match or kernel.GetDriveTypeW(match.group(1)) != 3:
            return Verification("unavailable")
        filesystem = ctypes.create_unicode_buffer(256)
        if not kernel.GetVolumeInformationW(match.group(1), None, 0, None, None, None, filesystem, len(filesystem)):
            return Verification("unavailable")
        if filesystem.value.upper() != "NTFS":
            return Verification("unavailable")

        def basic():
            value = BasicInfo()
            if not kernel.GetFileInformationByHandleEx(handle, 0, ctypes.byref(value), ctypes.sizeof(value)):
                return None
            return value.creation, value.write, value.change, value.attributes

        initial = path.stat()
        initial_basic = basic()
        if not stat.S_ISREG(initial.st_mode) or initial_basic is None:
            return Verification("unavailable")
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        owns_native = False  # Ownership transferred to the Python descriptor.
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            handle = msvcrt.get_osfhandle(stream.fileno())
            opened = os.fstat(stream.fileno())
            if _identity(initial) != _identity(opened):
                if diagnose is not None:
                    diagnose({"stage": "open_identity", "equal": False,
                              "field_equal": dict(zip(FileIdentity._fields_,
                                  (a == b for a, b in zip(_identity(initial), _identity(opened)))))})
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
            extra = stream.read(1)
            final = os.fstat(stream.fileno())
            current = path.stat()
            final_basic = basic()
            if (_identity(opened) != _identity(final) or _identity(final) != _identity(current)
                    or initial_basic != final_basic or final_basic is None or read_size != expected_size or extra):
                if diagnose is not None:
                    diagnose({"stage": "final_identity",
                              "opened_final_equal": _identity(opened) == _identity(final),
                              "final_current_equal": _identity(final) == _identity(current),
                              "basic_fields_equal": [a == b for a, b in zip(initial_basic, final_basic)] if final_basic else None,
                              "read_size_equal": read_size == expected_size, "extra_byte": bool(extra)})
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
    finally:
        if descriptor is not None:
            os.close(descriptor)
        elif owns_native:
            kernel.CloseHandle(handle)


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
    if os.name == "nt":
        # Windows hashing is an unreviewed prototype; storage opt-in alone
        # must not activate it. Native CI exercises this explicit test gate.
        if getattr(os, "environ", {}).get("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM") != "1":
            return Verification("unavailable")
        return _verify_windows(path, expected_size, expected_sha256, cancelled, chunk_size)
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
