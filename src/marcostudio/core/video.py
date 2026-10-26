"""Bounded local MP4 ingestion. No GPU, network access or shell execution."""

import json
import math
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

MAX_VIDEO_BYTES = 96 * 1024 * 1024  # Below ComfyUI/proxy's default 100 MiB input ceiling.
MAX_OUTPUT_BYTES = 256 * 1024 * 1024


def executable(name):
    path = shutil.which(name)
    if not path:
        raise ValueError(f"Install FFmpeg and add {name} to PATH for video tools")
    return path


def run(arguments, timeout):
    try:
        return subprocess.run(
            arguments,
            capture_output=True,
            check=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (subprocess.SubprocessError, OSError) as exc:
        raise ValueError("The MP4 could not be read or converted by FFmpeg") from exc


def probe(path, *, output=False, count_frames=False):
    raw = run(
        [
            executable("ffprobe"),
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-threads",
            "2",
            *(["-count_frames"] if count_frames else []),
            "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration,nb_read_frames",
            "-of",
            "json",
            str(path),
        ],
        60 if count_frames else 20,
    )
    try:
        info = json.loads(raw)
        stream = next(s for s in info["streams"] if s["codec_type"] == "video")
        duration = float(info["format"].get("duration", stream.get("duration", 0)))
        fps = float(Fraction(stream["avg_frame_rate"]))
        width, height = int(stream["width"]), int(stream["height"])
        if "mp4" not in info["format"]["format_name"].split(","):
            raise ValueError("Use an MP4 video")
        if not math.isfinite(duration) or not 0 < duration <= (30.1 if output else 15.1):
            raise ValueError("Use an MP4 up to 15 seconds long")
        if not math.isfinite(fps) or not 1 <= fps <= 120:
            raise ValueError("Video frame rate must be between 1 and 120 fps")
        if not (32 <= width <= 4096 and 32 <= height <= 4096) or width * height > 3840 * 2160:
            raise ValueError("Video resolution must be between 32 pixels and 4K")
        metadata = {
            "width": width,
            "height": height,
            "duration": duration,
            "fps": fps,
            "has_audio": any(s["codec_type"] == "audio" for s in info["streams"]),
        }
        if count_frames:
            try:
                frames = int(stream["nb_read_frames"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("Could not count decoded video frames") from exc
            if frames < 1:
                raise ValueError("The MP4 has no readable video frames")
            metadata["frame_count"] = frames
        return metadata
    except (KeyError, StopIteration, TypeError, ZeroDivisionError, json.JSONDecodeError) as exc:
        raise ValueError("The MP4 has no readable video stream") from exc


def prepare_video(data: bytes, directory: Path, *, output=False):
    if not data or len(data) > (MAX_OUTPUT_BYTES if output else MAX_VIDEO_BYTES):
        raise ValueError("Video is empty or exceeds the 96 MiB upload limit")
    with TemporaryDirectory(prefix="video-", dir=directory) as temporary:
        source = Path(temporary) / "input.mp4"
        source.write_bytes(data)
        metadata = probe(source, output=output, count_frames=output)
        if output:
            return data, metadata
        target = Path(temporary) / "normalized.mp4"
        run(
            [
                executable("ffmpeg"),
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-threads",
                "2",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-sn",
                "-dn",
                "-filter_threads",
                "1",
                "-vf",
                "fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
                "-fs",
                str(MAX_VIDEO_BYTES),
                str(target),
            ],
            180,
        )
        if target.stat().st_size >= MAX_VIDEO_BYTES:
            raise ValueError("Converted video exceeds the 96 MiB limit")
        normalized = probe(target, count_frames=True)
        if normalized["duration"] < metadata["duration"] - 0.15:
            raise ValueError("The video could not be converted in full within the upload limit")
        return target.read_bytes(), normalized
