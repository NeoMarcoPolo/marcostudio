from __future__ import annotations

import colorsys
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PRESETS = {
    "front": (0, 0),
    "right": (90, 0),
    "left": (-90, 0),
    "back": (180, 0),
    "top": (0, 90),
    "bottom": (0, -90),
}


class RelightSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    direction: Literal["front", "right", "left", "back", "top", "bottom", "custom"] = "front"
    azimuth: float | None = Field(default=None, ge=-180, le=180)
    elevation: float | None = Field(default=None, ge=-90, le=90)
    softness: Literal["soft", "hard"] = "soft"
    brightness: int = Field(default=50, ge=10, le=100, multiple_of=10)
    color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    mode: Literal["flash", "standard"] = "flash"
    seed: int = Field(default=0, ge=0, le=9007199254740991)

    @model_validator(mode="after")
    def coherent_direction(self):
        if self.direction == "custom" and (self.azimuth is None or self.elevation is None):
            raise ValueError("Custom direction requires azimuth and elevation")
        if self.direction != "custom":
            self.azimuth, self.elevation = PRESETS[self.direction]
        self.color = self.color.lower()
        return self

    def vector(self) -> tuple[float, float, float]:
        az, el = math.radians(self.azimuth), math.radians(self.elevation)
        return math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)

    def prompt(self) -> str:
        az, el = self.azimuth, self.elevation
        direction = (
            "above"
            if el >= 60
            else "below"
            if el <= -60
            else "the viewer’s right"
            if 45 <= az <= 135
            else "the viewer’s left"
            if -135 <= az <= -45
            else "behind the subject"
            if abs(az) > 135
            else "the camera side"
        )
        if -60 < el < 60 and abs(el) >= 20:
            direction += " and above" if el > 0 else " and below"
        rgb = tuple(int(self.color[i : i + 2], 16) / 255 for i in (1, 3, 5))
        hue, saturation, _ = colorsys.rgb_to_hsv(*rgb)
        name = (
            "neutral white"
            if saturation < 0.12
            else (
                "red",
                "orange",
                "yellow",
                "yellow-green",
                "green",
                "cyan-green",
                "cyan",
                "blue",
                "deep blue",
                "violet",
                "magenta",
                "pink",
            )[round(hue * 12) % 12]
        )
        intensity = (
            "very dim",
            "dim",
            "subdued",
            "gentle",
            "moderate",
            "bright",
            "strong",
            "very bright",
            "intense",
            "very intense",
        )[self.brightness // 10 - 1]
        shadow = (
            "soft diffuse light with gradual shadow transitions"
            if self.softness == "soft"
            else "hard directional light with crisp shadow edges"
        )
        return (
            f"重新照明, Relight this image with {intensity} {name} {shadow} from {direction}. "
            f"Requested light color {self.color}. Preserve the same subject identity, facial features, "
            "text, objects, materials, composition and background geometry. Change illumination, "
            "not surface colors or the scene contents."
        )
