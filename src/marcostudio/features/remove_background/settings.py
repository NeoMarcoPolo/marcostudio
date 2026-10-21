from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RemoveBackgroundSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["standard"] = "standard"
    seed: int = Field(default=0, ge=0, le=2**53 - 1, strict=True)

    def prompt(self):
        return "Remove the background, and output a PNG image"
