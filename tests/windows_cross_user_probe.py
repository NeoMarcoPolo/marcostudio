"""Cross-user pairing probe for a disposable GitHub-hosted Windows VM only.

Run in the dedicated CI step, never as part of a regular developer test run.
It creates and deletes an ephemeral local account without logging credentials.
"""
import ctypes
import importlib.util
import os
import secrets
from ctypes import wintypes
from pathlib import Path

if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
        or os.environ.get("MARCO_EPHEMERAL_WINDOWS_USER_TEST") != "1"):
    raise SystemExit("This probe only runs in its dedicated disposable GitHub-hosted Windows job.")


class UserInfo(ctypes.Structure):
    _fields_ = [("name", wintypes.LPWSTR), ("password", wintypes.LPWSTR),
                ("password_age", wintypes.DWORD), ("privilege", wintypes.DWORD),
                ("home", wintypes.LPWSTR), ("comment", wintypes.LPWSTR),
                ("flags", wintypes.DWORD), ("script_path", wintypes.LPWSTR)]


class ProfileInfo(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("username", wintypes.LPWSTR), ("profile_path", wintypes.LPWSTR),
                ("default_path", wintypes.LPWSTR), ("server_name", wintypes.LPWSTR),
                ("policy_path", wintypes.LPWSTR), ("profile", wintypes.HANDLE)]


net = ctypes.WinDLL("netapi32", use_last_error=True)
net.NetUserAdd.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
net.NetUserAdd.restype = wintypes.DWORD
net.NetUserDel.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
net.NetUserDel.restype = wintypes.DWORD
adv = ctypes.WinDLL("advapi32", use_last_error=True)
adv.LogonUserW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                           wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
adv.LogonUserW.restype = wintypes.BOOL
adv.ImpersonateLoggedOnUser.argtypes = [wintypes.HANDLE]
adv.ImpersonateLoggedOnUser.restype = wintypes.BOOL
adv.RevertToSelf.argtypes = []
adv.RevertToSelf.restype = wintypes.BOOL
adv.GetUserNameW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
adv.GetUserNameW.restype = wintypes.BOOL
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
userenv = ctypes.WinDLL("userenv", use_last_error=True)
userenv.LoadUserProfileW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProfileInfo)]
userenv.LoadUserProfileW.restype = wintypes.BOOL
userenv.UnloadUserProfile.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
userenv.UnloadUserProfile.restype = wintypes.BOOL

source = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/storage_pairing_windows.py"
spec = importlib.util.spec_from_file_location("marcostudio_windows_pairing_probe", source)
pairing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pairing)

username = "ms" + secrets.token_hex(6)
password = "A9a!" + secrets.token_hex(20)
user = UserInfo(name=username, password=password, privilege=1, flags=0x201)
error_index = wintypes.DWORD()
result = net.NetUserAdd(None, 1, ctypes.byref(user), ctypes.byref(error_index))
if result:
    raise SystemExit(f"INCONCLUSIVE: could not create isolated test account (status {result}).")
owner = None
other = None
handle = wintypes.HANDLE()
impersonating = False
profile_loaded = False
profile = ProfileInfo(size=ctypes.sizeof(ProfileInfo), username=username)
try:
    owner = pairing.WindowsOwnerPairing()
    if not owner.accepts(pairing.read_owner_token(owner.target)):
        raise RuntimeError("Owner positive control failed")
    if not adv.LogonUserW(username, ".", password, 2, 0, ctypes.byref(handle)):
        raise OSError(ctypes.get_last_error(), "Alternate account logon failed")
    if not userenv.LoadUserProfileW(handle, ctypes.byref(profile)):
        raise OSError(ctypes.get_last_error(), "Alternate account profile load failed")
    profile_loaded = True
    if not adv.ImpersonateLoggedOnUser(handle):
        raise OSError(ctypes.get_last_error(), "Alternate account impersonation failed")
    impersonating = True
    name = ctypes.create_unicode_buffer(256)
    name_length = wintypes.DWORD(len(name))
    if not adv.GetUserNameW(name, ctypes.byref(name_length)) or name.value.casefold() != username.casefold():
        raise RuntimeError("Alternate account identity control failed")
    other = pairing.WindowsOwnerPairing()
    if not other.accepts(pairing.read_owner_token(other.target)):
        raise RuntimeError("Alternate account positive control failed")
    try:
        pairing.read_owner_token(owner.target)
    except OSError as exc:
        if exc.errno != 1168:  # ERROR_NOT_FOUND; do not turn arbitrary errors into success.
            raise
    else:
        raise RuntimeError("Alternate account read the owner credential")
    other.close()
    other = None
    if not adv.RevertToSelf():
        raise OSError(ctypes.get_last_error(), "Could not revert impersonation")
    impersonating = False
    if not owner.accepts(pairing.read_owner_token(owner.target)):
        raise RuntimeError("Owner credential unavailable after alternate account test")
    print("PASS: owner and alternate-account controls worked; alternate account could not read owner credential.")
finally:
    try:
        try:
            if other is not None:
                other.close()
        finally:
            if impersonating and not adv.RevertToSelf():
                raise OSError(ctypes.get_last_error(), "Could not revert impersonation during cleanup")
    finally:
        try:
            if profile_loaded and not userenv.UnloadUserProfile(handle, profile.profile):
                raise OSError(ctypes.get_last_error(), "Could not unload isolated account profile")
            if handle:
                kernel.CloseHandle(handle)
            if owner is not None:
                owner.close()
        finally:
            result = net.NetUserDel(None, username)
            if result:
                raise RuntimeError(f"Could not remove isolated test account (status {result})")
