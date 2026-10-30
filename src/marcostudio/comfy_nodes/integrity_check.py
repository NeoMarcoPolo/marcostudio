"""Offline verify-and-reresolve primitive; never an HTTP readiness verdict."""

from .integrity_resolution import resolve
from .model_verify import Verification, _identity, verify_file


def verify_identity(identity, folder_paths, *, cancelled=None):
    """Verify trusted catalog bytes, then recheck loader resolution and stat.

    This is an observation only. Callers must also prove the actual loader's
    object_info choice matches, the Manager queue is idle, and revalidate for
    their publication and model-loading lifecycle. Never cache solely by stat.
    """
    before = resolve(identity, folder_paths)
    if before.status != "resolved":
        return Verification(before.status)
    result = verify_file(before.path, before.size, before.digest, cancelled=cancelled)
    if result.status != "verified":
        return result
    if cancelled is not None and cancelled():
        return Verification("cancelled")
    after = resolve(identity, folder_paths)
    if after != before:
        return Verification("changed")
    try:
        if _identity(before.path.stat()) != result.identity:
            return Verification("changed")
    except OSError:
        return Verification("changed")
    if cancelled is not None and cancelled():
        return Verification("cancelled")
    return result
