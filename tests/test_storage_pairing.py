"""Exercise owner-local pairing without importing ComfyUI."""
import importlib.util
import os
import stat
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/storage_pairing.py"
SPEC = importlib.util.spec_from_file_location("marcostudio_storage_pairing_test", SOURCE)
pairing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pairing)


@pytest.mark.skipif(os.name != "posix", reason="Unix-domain sockets required")
def test_token_is_local_only_and_rotated(tmp_path):
    first = pairing.OwnerPairing()
    try:
        token = pairing.read_owner_token(first.path)
        assert len(token) >= 40
        assert first.accepts(token)
        assert not first.accepts("wrong")
        assert not first.accepts(None)
        assert not first.accepts("💡")
        alias = tmp_path / "owner.sock"
        alias.symlink_to(first.path)
        with pytest.raises(ValueError):
            pairing.read_owner_token(alias)
        assert stat.S_IMODE(first.path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(first.path.stat().st_mode) == 0o600
        assert stat.S_ISSOCK(first.path.stat().st_mode)
        with pytest.raises(OSError):
            first.path.read_bytes()
    finally:
        first.close()
    assert not first.path.exists()
    second = pairing.OwnerPairing()
    try:
        assert not second.accepts(token)
        assert second.accepts(pairing.read_owner_token(second.path))
    finally:
        second.close()
