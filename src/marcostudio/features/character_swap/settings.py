"""One short source performance and one replacement identity."""

from typing import Literal

from pydantic import Field

from ..video_tools.settings import VideoSettings


class CharacterSwapSettings(VideoSettings):
    mode: Literal["standard"] = "standard"
    duration: int = Field(default=5, ge=2, le=5, strict=True)
    instruction: str = Field(
        default=(
            "Replace the person in <Video 1> with the character in <Picture 1>. "
            "Keep the reference character's face, hair and clothing. Follow the source "
            "performance's pose, gaze, expression and movement. Preserve the scene "
            "and other people."
        ),
        max_length=12000,
    )
