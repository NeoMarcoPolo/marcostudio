"""Validated settings for the native MiniMax H3 audio/video workflows."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

FrameIndex = Annotated[int, Field(strict=True, ge=1)]


class VideoSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    mode: Literal["standard", "flash"] = "standard"
    instruction: str = Field(default="", max_length=12000)
    seed: int = Field(default=0, ge=0, le=9007199254740991, strict=True)
    width: int = Field(default=768, ge=256, le=1344, multiple_of=32, strict=True)
    height: int = Field(default=448, ge=256, le=1344, multiple_of=32, strict=True)
    duration: int = Field(default=5, ge=2, le=10, strict=True)

    @model_validator(mode="after")
    def limit_canvas(self):
        if self.width * self.height > 768 * 1344:
            raise ValueError("Video canvas must not exceed 1,032,192 pixels")
        return self

    @property
    def frames(self) -> int:
        """24 fps, rounded up to H3's 17k+5 grid (5 seconds becomes 124 frames)."""
        requested = self.duration * 24
        return requested + (5 - requested % 17) % 17

    @property
    def actual_duration(self) -> float:
        return self.frames / 24

    def prompt(self) -> str:
        return self.instruction.strip()


class KeyframesSettings(VideoSettings):
    mode: Literal["standard"] = "standard"
    guide_frames: list[FrameIndex] = Field(default_factory=lambda: [48], min_length=1, max_length=3)

    @model_validator(mode="after")
    def ordered_guides(self):
        if any(a >= b for a, b in zip(self.guide_frames, self.guide_frames[1:])):
            raise ValueError("Guide frame indices must be strictly increasing")
        if self.guide_frames[-1] >= self.frames:
            raise ValueError(f"Guide frame indices must be between 1 and {self.frames - 1}")
        return self

    def validate_inputs(self, inputs):
        supplied = [key for key in ("guide_1", "guide_2", "guide_3") if inputs.get(key) is not None]
        if supplied != [f"guide_{i + 1}" for i in range(len(supplied))]:
            raise ValueError("Supply guides in order, beginning with guide_1")
        if len(supplied) != len(self.guide_frames):
            raise ValueError("Provide exactly one guide frame index for each supplied guide image")


class MotionControlSettings(VideoSettings):
    mode: Literal["standard"] = "standard"
    control_type: Literal["canny", "preprocessed"] = "canny"
    strength: float = Field(default=1.0, gt=0, le=2.0)
