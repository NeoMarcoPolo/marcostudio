from __future__ import annotations

import hashlib
import io
import ntpath
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from .store import Store, atomic_write

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 32_000_000


class Assets:
    def __init__(self, store: Store):
        self.store = store

    def add(self, data: bytes, filename: str, *, output: bool = False) -> dict:
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
        content = normalized.getvalue()
        asset_id = hashlib.sha256(content).hexdigest()
        original_hash = hashlib.sha256(data).hexdigest()
        filename = ntpath.basename(filename).replace("\x00", "")[:150] or "image.png"
        target = self.store.root / "assets" / f"{asset_id}.png"
        original = self.store.root / "originals" / original_hash
        if not original.exists():
            atomic_write(original, data)
        if not target.exists():
            atomic_write(target, content)
        return self.store.add_asset(
            {
                "id": asset_id,
                "url": f"/api/assets/{asset_id}",
                "filename": filename,
                "width": width,
                "height": height,
                "media_type": "image/png",
                "sha256": asset_id,
                "original_sha256": original_hash,
                "size": len(content),
            }
        )

    def path(self, asset_id: str):
        asset = self.store.asset(asset_id)
        if len(asset["id"]) != 64 or any(c not in "0123456789abcdef" for c in asset["id"]):
            raise ValueError("Invalid asset identity")
        path = self.store.root / "assets" / f"{asset['id']}.png"
        if not path.is_file():
            raise KeyError("Asset file is unavailable")
        return path
