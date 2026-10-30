"""Windows storage primitive, used only on Windows and not exposed independently.

Open the actual directory first, query the handle's volume GUID path, and
reopen the original path to detect a replacement while the probe is running.
UNC, unsupported volumes and missing metadata return unknown.
"""
import ctypes
import hashlib
import os
import re
from ctypes import wintypes
from pathlib import Path


class _FileTime(ctypes.Structure):
    _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]


class _FileInformation(ctypes.Structure):
    _fields_ = [
        ("attributes", wintypes.DWORD), ("created", _FileTime),
        ("accessed", _FileTime), ("written", _FileTime),
        ("volume_serial", wintypes.DWORD), ("size_high", wintypes.DWORD),
        ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
        ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD),
    ]


def available_windows(destination: Path):
    """Return (available bytes, opaque volume identifier) or None."""
    if os.name != "nt" or not destination.is_absolute() or ".." in destination.parts:
        return None
    current = destination
    missing = []
    while True:
        try:
            current.lstat()
            break
        except FileNotFoundError:
            missing.append(current)
            if current.parent == current:
                return None
            current = current.parent
        except OSError:
            return None

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(_FileInformation)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel.GetDiskFreeSpaceExW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_ulonglong),
                                          ctypes.c_void_p, ctypes.c_void_p]
    kernel.GetDiskFreeSpaceExW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    invalid = ctypes.c_void_p(-1).value

    def open_directory():
        # FILE_READ_ATTRIBUTES, share read/write/delete, OPEN_EXISTING,
        # FILE_FLAG_BACKUP_SEMANTICS: directories can be opened by handle.
        handle = kernel.CreateFileW(str(current), 0x80, 7, None, 3, 0x02000000, None)
        return None if handle in (None, invalid) else handle

    def identity(handle):
        info = _FileInformation()
        if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)) or not info.attributes & 0x10:
            return None
        return info.volume_serial, info.index_high, info.index_low

    first = open_directory()
    if first is None:
        return None
    second = None
    try:
        before = identity(first)
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(first, buffer, len(buffer), 1)
        if before is None or not length or length >= len(buffer):
            return None
        final_path = buffer.value
        match = re.match(r"^\\\\\?\\(Volume\{[0-9a-fA-F-]+\})\\", final_path)
        if not match:
            return None
        available = ctypes.c_ulonglong()
        if not kernel.GetDiskFreeSpaceExW(final_path, ctypes.byref(available), None, None):
            return None
        second = open_directory()
        if second is None or identity(second) != before or identity(first) != before:
            return None
        for child in reversed(missing):
            try:
                child.lstat()
            except FileNotFoundError:
                continue
            return None
        volume = int.from_bytes(hashlib.sha256(match.group(1).lower().encode()).digest()[:8], "big")
        return available.value, volume
    except OSError:
        return None
    finally:
        if second is not None:
            kernel.CloseHandle(second)
        kernel.CloseHandle(first)
