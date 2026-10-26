from __future__ import annotations

import hashlib
import io
import ntpath
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from .store import Store, atomic_write
from .video import prepare_video, probe

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 32_000_000


class Assets:
    def __init__(self, store: Store):
        self.store = store

    def metadata(self, asset_id: str) -> dict:
        asset = self.store.asset(asset_id)
        if asset["media_type"] == "video/mp4" and "frame_count" not in asset:
            # Older saved videos predate frame counts; validate their actual
            # decoded frames when reused, without changing their identity.
            return asset | probe(self.path(asset_id), output=True, count_frames=True)
        return asset

    def add(self, data: bytes, filename: str, *, output: bool = False) -> dict:
        if len(data) >= 12 and data[4:8] == b"ftyp":
            content, metadata = prepare_video(data, self.store.root, output=output)
            return self._store(content, data, filename, "video/mp4", ".mp4", metadata)
        if not data or len(data) > (64 * 1024 * 1024 if output else MAX_INPUT_BYTES):
            raise ValueError("Image is empty or exceeds the supported upload size")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as source:
                    if source.format not in {"PNG", "JPEG"} or getattr(source, "n_frames", 1) != 1:
                        raise ValueError("Use a still PNG or JPEG image")
                    if source.width * source.height > MAX_PIXELS:
                        raise ValueError("Image exceeds the 32 megapixel limit")
                    source.load()
                    has_alpha = "A" in source.getbands() or "transparency" in source.info
                    image = ImageOps.exif_transpose(source).convert("RGBA" if has_alpha else "RGB")
                    normalized = io.BytesIO()
                    image.save(normalized, format="PNG")
                    width, height = image.size
        except (
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise ValueError("The image could not be decoded") from exc
        return self._store(
            normalized.getvalue(),
            data,
            filename,
            "image/png",
            ".png",
            {"width": width, "height": height},
        )

    def _store(self, content, original_data, filename, media_type, extension, metadata):
        asset_id = hashlib.sha256(content).hexdigest()
        original_hash = hashlib.sha256(original_data).hexdigest()
        filename = ntpath.basename(filename).replace("\x00", "")[:140] or "asset"
        filename = ntpath.splitext(filename)[0] + extension
        target = self.store.root / "assets" / f"{asset_id}{extension}"
        original = self.store.root / "originals" / original_hash
        if not original.exists():
            atomic_write(original, original_data)
        if not target.exists():
            atomic_write(target, content)
        return self.store.add_asset(
            {
                "id": asset_id,
                "url": f"/api/assets/{asset_id}",
                "filename": filename,
                **metadata,
                "media_type": media_type,
                "sha256": asset_id,
                "original_sha256": original_hash,
                "size": len(content),
            }
        )

    def path(self, asset_id: str):
        asset = self.store.asset(asset_id)
        if len(asset["id"]) != 64 or any(c not in "0123456789abcdef" for c in asset["id"]):
            raise ValueError("Invalid asset identity")
        extension = {"image/png": ".png", "video/mp4": ".mp4"}.get(asset["media_type"])
        if extension is None:
            raise ValueError("Unsupported stored media type")
        path = self.store.root / "assets" / f"{asset['id']}{extension}"
        if not path.is_file():
            raise KeyError("Asset file is unavailable")
        return path
