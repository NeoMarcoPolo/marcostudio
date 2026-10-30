"""Exercise the portable verifier without importing ComfyUI or torch."""

import hashlib
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/model_verify.py"
SPEC = importlib.util.spec_from_file_location("marcostudio_model_verify_test", SOURCE)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def test_identity_diagnostic_reports_only_field_comparisons():
    first = verify.FileIdentity(1, 2, 3, 4, 5)
    second = verify.FileIdentity(1, 2, 3, 4, 6)
    assert verify._identity_fields_equal(first, second) == {
        "device": True, "inode": True, "size": True,
        "modified_ns": True, "changed_ns": False,
    }


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_exact_file_verifies_and_returns_matching_identity(tmp_path):
    data = b"trusted model fixture"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    result = verify.verify_file(path, len(data), digest(data), chunk_size=3)
    assert result.status == "verified"
    assert result.identity.size == len(data)
    assert result.identity.inode == path.stat().st_ino


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_truncated_corrupt_and_missing_fail_closed(tmp_path):
    data = b"valid model bytes"
    path = tmp_path / "model.safetensors"
    assert verify.verify_file(path, len(data), digest(data)).status == "missing"
    path.write_bytes(data[:-1])
    assert verify.verify_file(path, len(data), digest(data)).status == "size_mismatch"
    path.write_bytes(b"x" * len(data))
    assert verify.verify_file(path, len(data), digest(data)).status == "hash_mismatch"


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_changed_file_during_read_is_not_verified(tmp_path):
    data = b"0123456789abcdef"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    calls = 0

    def mutate_after_first_chunk():
        nonlocal calls
        calls += 1
        if calls == 2:
            path.write_bytes(b"x" * len(data))
        return False

    result = verify.verify_file(path, len(data), digest(data), cancelled=mutate_after_first_chunk, chunk_size=4)
    assert result.status == "changed"
    assert result.identity is None


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_path_replacement_during_read_is_not_verified(tmp_path):
    data = b"0123456789abcdef"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    replacement = tmp_path / "replacement"
    replacement.write_bytes(data)
    calls = 0

    def replace_after_first_chunk():
        nonlocal calls
        calls += 1
        if calls == 2:
            replacement.replace(path)
        return False

    result = verify.verify_file(path, len(data), digest(data), cancelled=replace_after_first_chunk, chunk_size=4)
    assert result.status == "changed"
    assert result.identity is None


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_cancelled_and_invalid_catalog_metadata_fail_closed(tmp_path):
    path = tmp_path / "model.safetensors"
    path.write_bytes(b"abc")
    assert verify.verify_file(path, 3, digest(b"abc"), cancelled=lambda: True).status == "cancelled"
    assert verify.verify_file(path, 3, "invalid").status == "invalid_metadata"
    assert verify.verify_file(path, True, digest(b"abc")).status == "invalid_metadata"
    assert verify.verify_file(path, 3, digest(b"abc"), chunk_size=0).status == "invalid_metadata"
    assert verify.verify_file(tmp_path, 3, digest(b"abc")).status == "unavailable"


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_cancellation_after_final_read_cannot_return_verified(tmp_path):
    path = tmp_path / "model.safetensors"
    path.write_bytes(b"abc")
    calls = 0

    def cancel_at_commit():
        nonlocal calls
        calls += 1
        return calls == 3

    result = verify.verify_file(path, 3, digest(b"abc"), chunk_size=3, cancelled=cancel_at_commit)
    assert result.status == "cancelled"
    assert result.identity is None


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_growing_file_never_exceeds_expected_read_bound(tmp_path):
    data = b"0123456789abcdef"
    path = tmp_path / "model.safetensors"
    path.write_bytes(data)
    calls = 0

    def grow_each_check():
        nonlocal calls
        calls += 1
        if calls > 1:
            with path.open("ab") as stream:
                stream.write(b"x" * 100)
        return False

    result = verify.verify_file(path, len(data), digest(data), chunk_size=4, cancelled=grow_each_check)
    assert result.status == "changed"
    # Four bounded reads and one pre-growth check suffice; this would keep
    # reading indefinitely if the loop followed the newly appended bytes.
    assert calls <= 6


def test_stat_identity_is_not_a_safe_cache_signal_on_supported_platforms(monkeypatch):
    monkeypatch.setattr(verify, "os", SimpleNamespace(name="nt"))
    assert not verify.supports_identity_cache()
    monkeypatch.setattr(verify, "os", SimpleNamespace(name="posix"))
    assert not verify.supports_identity_cache()


@pytest.mark.skipif(os.name == "nt", reason="simulates missing Windows APIs on a non-Windows host")
def test_windows_file_verification_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "model.safetensors"
    data = b"trusted model fixture"
    path.write_bytes(data)
    monkeypatch.setattr(verify, "os", SimpleNamespace(name="nt"))
    assert verify.verify_file(path, len(data), digest(data)) == verify.Verification("unavailable")


@pytest.mark.skipif(os.name == "nt", reason="Windows verification is deliberately unavailable")
def test_os_errors_are_coarse_and_do_not_disclose_paths(tmp_path, monkeypatch):
    path = tmp_path / "private-model"
    path.write_bytes(b"abc")

    def denied(_path, *args, **kwargs):
        raise PermissionError("sensitive local filename")

    monkeypatch.setattr(verify.os, "open", denied)
    result = verify.verify_file(path, 3, digest(b"abc"))
    assert result == verify.Verification("unavailable")
    assert "sensitive" not in repr(result)


@pytest.mark.skipif(not hasattr(os, "mkfifo") or not hasattr(os, "O_NONBLOCK"), reason="requires POSIX FIFO")
def test_replacement_with_fifo_does_not_block_worker(tmp_path, monkeypatch):
    path = tmp_path / "model.safetensors"
    path.write_bytes(b"abc")
    original_open = os.open

    def swap_then_open(target, flags):
        path.unlink()
        os.mkfifo(path)
        return original_open(target, flags)

    monkeypatch.setattr(verify.os, "open", swap_then_open)
    assert verify.verify_file(path, 3, digest(b"abc")).status == "changed"
