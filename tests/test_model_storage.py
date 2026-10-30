"""Test storage observations without importing ComfyUI or using real models."""

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/model_storage.py"
SPEC = importlib.util.spec_from_file_location("marcostudio_model_storage_test", SOURCE)
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_existing_destination_reports_available_bytes(tmp_path):
    result = storage.available_space(tmp_path)
    assert result.status == "available"
    assert isinstance(result.available_bytes, int)
    assert result.available_bytes >= 0


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_missing_destination_checks_nearest_existing_ancestor(tmp_path, monkeypatch):
    ancestor = tmp_path / "models"
    ancestor.mkdir()
    seen = []

    def usage(fd):
        seen.append((os.fstat(fd).st_dev, os.fstat(fd).st_ino))
        return SimpleNamespace(f_bavail=123456, f_frsize=1)

    monkeypatch.setattr(storage.os, "fstatvfs", usage)
    result = storage.available_space(ancestor / "nested" / "destination")
    assert result == storage.StorageSpace("available", 123456)
    assert seen == [(ancestor.stat().st_dev, ancestor.stat().st_ino)]


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_destinations_are_checked_individually(tmp_path, monkeypatch):
    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    monkeypatch.setattr(storage.os, "fstatvfs", lambda fd: SimpleNamespace(
        f_bavail=11 if os.fstat(fd).st_ino == first.stat().st_ino else 22, f_frsize=1
    ))
    assert storage.available_space(first).available_bytes == 11
    assert storage.available_space(second).available_bytes == 22


def test_invalid_file_and_relative_destination_are_unavailable(tmp_path):
    existing_file = tmp_path / "not-a-directory"
    existing_file.write_text("test")
    assert storage.available_space(existing_file).status == "unavailable"
    assert storage.available_space(existing_file / "child").status == "unavailable"
    assert storage.available_space(Path("relative/models")).status == "unavailable"
    assert storage.available_space(tmp_path / "one" / ".." / "two").status == "unavailable"


def test_dangling_symlink_does_not_fall_back_to_parent(tmp_path):
    link = tmp_path / "missing-mount"
    try:
        link.symlink_to(tmp_path / "missing", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks unavailable")
    assert storage.available_space(link).status == "unavailable"
    assert storage.available_space(link / "models").status == "unavailable"


def test_query_errors_and_invalid_free_values_are_unavailable(tmp_path, monkeypatch):
    if os.name != "posix" or not hasattr(os, "fstatvfs"):
        pytest.skip("descriptor-based probe unavailable")

    def fail(_fd):
        raise PermissionError("sensitive path")

    monkeypatch.setattr(storage.os, "fstatvfs", fail)
    assert storage.available_space(tmp_path) == storage.StorageSpace("unavailable")
    monkeypatch.setattr(storage.os, "fstatvfs", lambda _fd: SimpleNamespace(f_bavail=-1, f_frsize=1))
    assert storage.available_space(tmp_path) == storage.StorageSpace("unavailable")


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_directory_replacement_during_measurement_is_unavailable(tmp_path, monkeypatch):
    destination = tmp_path / "models"
    destination.mkdir()
    displaced = tmp_path / "old-models"
    real_usage = os.fstatvfs

    def swap_during_measurement(fd):
        value = real_usage(fd)
        destination.rename(displaced)
        destination.mkdir()
        return value

    monkeypatch.setattr(storage.os, "fstatvfs", swap_during_measurement)
    assert storage.available_space(destination) == storage.StorageSpace("unavailable")


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_missing_child_created_during_measurement_is_unavailable(tmp_path, monkeypatch):
    destination = tmp_path / "new" / "models"
    real_usage = os.fstatvfs

    def create_child(fd):
        value = real_usage(fd)
        (tmp_path / "new").mkdir()
        return value

    monkeypatch.setattr(storage.os, "fstatvfs", create_child)
    assert storage.available_space(destination) == storage.StorageSpace("unavailable")


@pytest.mark.skipif(os.name != "posix" or not hasattr(os, "fstatvfs"), reason="descriptor-based probe unavailable")
def test_symlink_retarget_during_measurement_is_unavailable(tmp_path, monkeypatch):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    link = tmp_path / "models"
    link.symlink_to(first, target_is_directory=True)
    real_usage = os.fstatvfs

    def retarget_during_measurement(fd):
        value = real_usage(fd)
        link.unlink()
        link.symlink_to(second, target_is_directory=True)
        return value

    monkeypatch.setattr(storage.os, "fstatvfs", retarget_during_measurement)
    assert storage.available_space(link) == storage.StorageSpace("unavailable")


def test_unproven_non_posix_platform_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(storage.os, "name", "nt")
    assert storage.available_space(tmp_path) == storage.StorageSpace("unavailable")
