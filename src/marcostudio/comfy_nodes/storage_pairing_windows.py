"""Experimental session-scoped Windows Credential Manager pairing primitive.

This module is not wired to the helper routes. It is usable only after actual
Windows session isolation and Desktop/portable compatibility are verified.
"""
import ctypes
import hmac
import os
import re
import secrets
from ctypes import wintypes


class _Credential(ctypes.Structure):
    _fields_ = [
        ("flags", wintypes.DWORD), ("type", wintypes.DWORD),
        ("target", wintypes.LPWSTR), ("comment", wintypes.LPWSTR),
        ("last_written", wintypes.FILETIME), ("blob_size", wintypes.DWORD),
        ("blob", ctypes.POINTER(ctypes.c_ubyte)), ("persist", wintypes.DWORD),
        ("attribute_count", wintypes.DWORD), ("attributes", wintypes.LPVOID),
        ("target_alias", wintypes.LPWSTR), ("username", wintypes.LPWSTR),
    ]


def _manager():
    if os.name != "nt":
        raise RuntimeError("Windows Credential Manager unavailable")
    manager = ctypes.WinDLL("advapi32", use_last_error=True)
    manager.CredWriteW.argtypes = [ctypes.POINTER(_Credential), wintypes.DWORD]
    manager.CredWriteW.restype = wintypes.BOOL
    manager.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.POINTER(ctypes.POINTER(_Credential))]
    manager.CredReadW.restype = wintypes.BOOL
    manager.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    manager.CredDeleteW.restype = wintypes.BOOL
    manager.CredFree.argtypes = [wintypes.LPVOID]
    manager.CredFree.restype = None
    return manager


def read_owner_token(target):
    if not isinstance(target, str) or not re.fullmatch(r"NeoMarcoPolo_MarcoStudio_[0-9a-f]{32}", target):
        raise ValueError("Invalid credential target")
    manager = _manager()
    result = ctypes.POINTER(_Credential)()
    if not manager.CredReadW(target, 1, 0, ctypes.byref(result)):
        raise OSError(ctypes.get_last_error(), "Windows pairing credential unavailable")
    try:
        data = ctypes.string_at(result.contents.blob, result.contents.blob_size)
        token = data.decode("ascii")
        if len(token) != 43 or not re.fullmatch("[A-Za-z0-9_-]{43}", token):
            raise ValueError("Invalid credential")
        return token
    finally:
        manager.CredFree(result)


class WindowsOwnerPairing:
    def __init__(self):
        self._manager = _manager()
        self._token = secrets.token_urlsafe(32)
        self.target = "NeoMarcoPolo_MarcoStudio_" + secrets.token_hex(16)
        token_buffer = (ctypes.c_ubyte * len(self._token)).from_buffer_copy(self._token.encode("ascii"))
        credential = _Credential()
        credential.type = 1  # CRED_TYPE_GENERIC
        credential.target = self.target
        credential.blob_size = len(token_buffer)
        credential.blob = token_buffer
        credential.persist = 1  # CRED_PERSIST_SESSION
        if not self._manager.CredWriteW(ctypes.byref(credential), 0):
            raise OSError(ctypes.get_last_error(), "Windows pairing credential unavailable")
        self._closed = False

    def accepts(self, token):
        return isinstance(token, str) and token.isascii() and hmac.compare_digest(token, self._token)

    def volume(self, device):
        return hmac.new(self._token.encode("ascii"), str(device).encode("ascii"), "sha256").hexdigest()[:24]

    def close(self):
        if not self._closed:
            if not self._manager.CredDeleteW(self.target, 1, 0):
                raise OSError(ctypes.get_last_error(), "Windows pairing credential removal failed")
            self._closed = True


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("Usage: python storage_pairing_windows.py <credential-target>")
    print(read_owner_token(sys.argv[1]))
