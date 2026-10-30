"""Windows native disk-space probes; actual Windows runner provides the proof."""
import importlib.util
import os
import shutil
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "src/marcostudio/comfy_nodes/model_storage_windows.py"
SPEC = importlib.util.spec_from_file_location("marcostudio_windows_storage_test", SOURCE)
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)


@pytest.mark.skipif(os.name != "nt", reason="requires actual Windows")
def test_real_windows_directory_reports_available_bytes_and_same_volume(tmp_path):
    directory = tmp_path / "models"
    directory.mkdir()
    observation = storage.available_windows(directory)
    assert observation is not None
    free, volume = observation
    assert isinstance(volume, int)
    assert 0 <= free <= shutil.disk_usage(directory).total
    other = storage.available_windows(directory / "not-created")
    assert other is not None
    assert other[1] == volume


@pytest.mark.skipif(os.name != "nt", reason="requires actual Windows")
def test_windows_file_and_bad_paths_are_unavailable(tmp_path):
    path = tmp_path / "not-a-directory"
    path.write_text("fixture", encoding="utf-8")
    assert storage.available_windows(path) is None
    assert storage.available_windows(Path("relative")) is None
    assert storage.available_windows(tmp_path / ".." / "relative") is None
