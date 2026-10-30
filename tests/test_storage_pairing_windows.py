"""Exercise Windows Credential Manager pairing on an actual Windows runner."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/storage_pairing_windows.py"
SPEC = importlib.util.spec_from_file_location("marcostudio_windows_pairing_test", SOURCE)
pairing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pairing)


@pytest.mark.skipif(os.name != "nt", reason="requires actual Windows")
def test_credential_is_visible_to_owner_process_and_deleted():
    owner = pairing.WindowsOwnerPairing()
    try:
        token = pairing.read_owner_token(owner.target)
        assert owner.accepts(token)
        assert not owner.accepts("wrong")
        # An independently launched owner process must use the same session.
        program = (
            "import importlib.util,sys; "
            "s=importlib.util.spec_from_file_location('p',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "print(m.read_owner_token(sys.argv[2]))"
        )
        child = subprocess.run([sys.executable, "-c", program, str(SOURCE), owner.target],
                               check=True, capture_output=True, text=True)
        assert child.stdout.strip() == token
    finally:
        owner.close()
    with pytest.raises(OSError):
        pairing.read_owner_token(owner.target)


@pytest.mark.skipif(os.name != "nt", reason="requires actual Windows")
def test_pairing_sessions_have_distinct_credentials():
    first = pairing.WindowsOwnerPairing()
    second = pairing.WindowsOwnerPairing()
    try:
        assert first.target != second.target
        assert not second.accepts(pairing.read_owner_token(first.target))
    finally:
        first.close()
        second.close()
