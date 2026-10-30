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


def test_manager_default_space_uses_manager_resolver_and_hides_paths(tmp_path, monkeypatch):
    import sys
    from types import ModuleType

    constants = ModuleType("comfyui_manager.glob.constants")
    constants.model_dir_name_map = {"checkpoint": "checkpoints"}
    resolver = ModuleType("comfyui_manager.glob.utils.model_utils")
    requests = []

    def resolve(data):
        requests.append(dict(data))
        return str(tmp_path)

    resolver.get_model_dir = resolve
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.constants", constants)
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.utils.model_utils", resolver)
    monkeypatch.setattr(storage, "available_space", lambda path: storage.StorageSpace("available", 42))
    result = storage.manager_default_space("model.safetensors", "Checkpoint")
    assert result == storage.StorageSpace("available", 42)
    assert requests == [{"filename": "model.safetensors", "type": "Checkpoint", "save_path": "default"}] * 2
    assert str(tmp_path) not in repr(result)
    assert storage.manager_default_space("../model", "Checkpoint").status == "unavailable"
    assert storage.manager_default_space("model", "unknown").status == "unavailable"


def test_manager_default_space_rejects_mapping_change_and_resolution_failure(tmp_path, monkeypatch):
    import sys
    from types import ModuleType

    constants = ModuleType("comfyui_manager.glob.constants")
    constants.model_dir_name_map = {"checkpoint": "checkpoints"}
    resolver = ModuleType("comfyui_manager.glob.utils.model_utils")
    paths = iter([str(tmp_path), str(tmp_path / "other")])
    resolver.get_model_dir = lambda _data: next(paths)
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.constants", constants)
    monkeypatch.setitem(sys.modules, "comfyui_manager.glob.utils.model_utils", resolver)
    monkeypatch.setattr(storage, "available_space", lambda path: storage.StorageSpace("available", 42))
    assert storage.manager_default_space("model", "checkpoint").status == "unavailable"
    def fail(_data):
        raise KeyError("private path")
    resolver.get_model_dir = fail
    assert storage.manager_default_space("model", "checkpoint") == storage.StorageSpace("unavailable")


def test_manager_import_exit_does_not_terminate_process(monkeypatch):
    import builtins

    original_import = builtins.__import__

    def import_with_manager_exit(name, *args, **kwargs):
        if name == "comfyui_manager.glob.constants":
            raise SystemExit(255)
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_with_manager_exit)
    assert storage.manager_default_space("model.safetensors", "checkpoint") == storage.StorageSpace("unavailable")
