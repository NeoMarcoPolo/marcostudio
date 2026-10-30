"""Native Windows snapshot verification; no stat-only result caching."""
import hashlib
import importlib.util
import mmap
import os
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/model_verify.py"
SPEC = importlib.util.spec_from_file_location("windows_model_verify", SOURCE)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)
pytestmark = pytest.mark.skipif(os.name != "nt", reason="requires native Windows")


@pytest.fixture(autouse=True)
def enable_experimental_windows_checksum(monkeypatch):
    monkeypatch.setenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM", "1")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def test_trusted_snapshot_and_invalid_files(tmp_path):
    data = b"trusted native fixture"
    path = tmp_path / "model.safetensors"
    assert verify.verify_file(path, len(data), digest(data)).status == "missing"
    path.write_bytes(data)
    result = verify.verify_file(path, len(data), digest(data), chunk_size=3)
    assert result.status == "verified"
    assert result.identity.size == len(data)
    assert not verify.supports_identity_cache()
    assert verify.verify_file(path, len(data) + 1, digest(data)).status == "size_mismatch"
    assert verify.verify_file(path, len(data), digest(b"x" * len(data))).status == "hash_mismatch"
    assert verify.verify_file(path, len(data), digest(data), cancelled=lambda: True).status == "cancelled"


def test_open_writer_prevents_verification(tmp_path):
    data = b"valid fixture"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    with path.open("r+b"):
        assert verify.verify_file(path, len(data), digest(data)).status == "unavailable"


def test_writes_and_rename_blocked_until_hash_finishes(tmp_path):
    data = b"0123456789abcdef"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    replacement = tmp_path / "replacement"
    replacement.write_bytes(data)
    checked = []

    def try_mutation():
        if not checked:
            with pytest.raises(PermissionError):
                path.write_bytes(b"x" * len(data))
            with pytest.raises(PermissionError):
                replacement.replace(path)
            checked.append(True)
        return False

    assert verify.verify_file(path, len(data), digest(data), cancelled=try_mutation, chunk_size=4).status == "verified"
    assert checked == [True]


def test_existing_writable_mapping_cannot_produce_false_snapshot(tmp_path):
    data = b"0123456789abcdef"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    stream = path.open("r+b")
    view = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_WRITE)
    stream.close()
    calls = 0
    try:
        def mutate_after_first_chunk():
            nonlocal calls
            calls += 1
            if calls == 2:
                view[0] = ord("x")
                view.flush()
            return False

        result = verify.verify_file(path, len(data), digest(data), cancelled=mutate_after_first_chunk, chunk_size=4)
        assert result.status in {"unavailable", "changed", "hash_mismatch"}
    finally:
        view.close()


def test_windows_checksum_is_disabled_without_explicit_opt_in(tmp_path, monkeypatch):
    path = tmp_path / "fixture"
    path.write_bytes(b"a")
    monkeypatch.delenv("MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM")
    assert verify.verify_file(path, 1, digest(b"a")).status == "unavailable"
