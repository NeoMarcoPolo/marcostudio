"""Original adapters for ComfyUI's native MiniMax H3 audio/video latent contract.

White mask pixels regenerate. Source latents stay clean: ComfyUI's H3 sampler
applies the .999 video / 1.0 audio conditioning times during masked sampling.
This module contains no sampler or model implementation.
"""

import math

import torch
import torch.nn.functional as F


def _validate_grid(frames, height, width):
    if frames < 5 or frames % 17 != 5:
        raise ValueError("H3 frames must be 5 + 17*k, with k >= 0")
    if height < 32 or width < 32 or height % 32 or width % 32:
        raise ValueError("H3 width and height must be positive multiples of 32")


def _validate_images(images):
    if images.ndim != 4 or images.shape[0] == 0 or images.shape[-1] not in (3, 4):
        raise ValueError("images must be a nonempty [frames, height, width, RGB(A)] tensor")
    if min(images.shape[1:3]) < 1 or not images.is_floating_point():
        raise ValueError("images must have nonempty dimensions and floating point pixels")


def _stereo_audio(audio):
    waveform = audio["waveform"]
    sample_rate = audio["sample_rate"]
    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
        raise ValueError("audio sample_rate must be a positive integer")
    if waveform.ndim != 3 or waveform.shape[0] != 1 or waveform.shape[1] not in (1, 2):
        raise ValueError("audio waveform must have shape [1, 1 or 2, samples]")
    if not waveform.is_floating_point():
        raise ValueError("audio waveform must be floating point")
    if waveform.shape[1] == 1:
        waveform = waveform.expand(-1, 2, -1)
    return waveform, sample_rate


def _fit_audio(waveform, length):
    waveform = waveform[..., :length]
    return F.pad(waveform, (0, length - waveform.shape[-1]))


def h3_noise_mask(mask, *, frames, height, width):
    """Map an image mask to hard H3 token coverage without temporal interpolation.

    H3 compresses each 17-frame chunk into groups of 1, 4, 4, 4, 4 frames.
    Each video token covers a 2x2 latent patch, or 32x32 image pixels. Max
    reduction retains a stroke anywhere within that temporal/spatial footprint.
    The resulting token value repeats across its four latent cells so the native
    sampler's own 2x2 pooling is idempotent.
    """
    _validate_grid(frames, height, width)
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if mask.ndim != 3 or tuple(mask.shape[-2:]) != (height, width):
        raise ValueError("mask spatial dimensions must match the padded source images")
    if mask.shape[0] not in (1, frames):
        raise ValueError("mask must contain one static frame or exactly the source frame count")
    if not torch.isfinite(mask).all():
        raise ValueError("mask must contain finite values")

    spatial = F.max_pool2d(mask.unsqueeze(1).float(), kernel_size=32, stride=32)
    spatial = (spatial > 0.5).to(dtype=torch.float32)
    latent_frames = 2 + 5 * ((frames - 5) // 17)
    if mask.shape[0] == 1:
        temporal = spatial.expand(latent_frames, -1, -1, -1)
    else:
        groups = []
        start = 0
        for index in range(latent_frames):
            end = start + (1 if index % 5 == 0 else 4)
            groups.append(spatial[start:end].amax(dim=0))
            start = end
        temporal = torch.stack(groups)
    grid = temporal.repeat_interleave(2, dim=-2).repeat_interleave(2, dim=-1)
    return grid.permute(1, 0, 2, 3).unsqueeze(0)


class MarcoStudioH3Window:
    """Resample source timing and align media to one native 24-fps H3 window."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "width": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 448, "min": 32, "max": 8192, "step": 32}),
                "frames": ("INT", {"default": 124, "min": 5, "max": 8199, "step": 17}),
            },
            "optional": {
                "audio": ("AUDIO",),
                "source_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "AUDIO")
    RETURN_NAMES = ("images", "original_count", "audio")
    FUNCTION = "execute"
    CATEGORY = "MarcoStudio/video"

    def execute(self, images, width, height, frames, audio=None, source_fps=24.0):
        _validate_grid(frames, height, width)
        _validate_images(images)
        if not math.isfinite(source_fps) or not 1 <= source_fps <= 120:
            raise ValueError("Source frame rate must be between 1 and 120 fps")
        if source_fps != 24:
            count = max(1, min(frames, round(images.shape[0] * 24 / source_fps)))
            indices = (torch.arange(count, device=images.device) * source_fps / 24).floor()
            images = images[indices.long().clamp(max=images.shape[0] - 1)]
        original_count = min(images.shape[0], frames)
        images = images[:original_count, ..., :3]
        if tuple(images.shape[1:3]) != (height, width):
            from comfy.utils import common_upscale

            images = (
                common_upscale(images.movedim(-1, 1), width, height, "bicubic", "center")
                .movedim(1, -1)
                .clamp(0, 1)
            )
        if original_count < frames:
            images = torch.cat((images, images[-1:].expand(frames - original_count, -1, -1, -1)))

        if audio is None:
            sample_rate = 48000
            waveform = torch.zeros(1, 2, round(frames * sample_rate / 24))
        else:
            waveform, sample_rate = _stereo_audio(audio)
            waveform = _fit_audio(waveform, round(frames * sample_rate / 24))
        return images, original_count, {"waveform": waveform, "sample_rate": sample_rate}


class MarcoStudioH3InpaintLatent:
    """Encode clean source AV and attach native joint denoising masks."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "mask": ("MASK",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "audio": ("AUDIO",),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "execute"
    CATEGORY = "MarcoStudio/video"

    def execute(self, images, mask, vae, audio_vae, audio):
        from comfy.audio import resample
        from comfy.nested_tensor import NestedTensor

        _validate_images(images)
        frames, height, width = images.shape[:3]
        video_mask = h3_noise_mask(mask, frames=frames, height=height, width=width)
        waveform, sample_rate = _stereo_audio(audio)
        vae_rate = getattr(audio_vae, "audio_sample_rate", 32000)
        if vae_rate != 32000:
            raise ValueError("H3 audio VAE must use a 32000 Hz sample rate")
        audio_tokens = round(frames / 24 * 40)
        waveform = waveform.float()
        if waveform.shape[-1] and sample_rate != vae_rate:
            waveform = resample(waveform, sample_rate, vae_rate)
        # H3 audio tokens span 800 samples at 32 kHz. Fit before VAE encoding:
        # padding by the codec alone would ceil the duration, rather than round it.
        waveform = _fit_audio(waveform, audio_tokens * 800)

        video_latent = vae.encode(images[..., :3])
        audio_latent = audio_vae.encode(waveform.movedim(1, -1))
        expected_video = (1, 24, video_mask.shape[2], height // 16, width // 16)
        expected_audio = (1, 32, 2, audio_tokens)
        if tuple(video_latent.shape) != expected_video:
            raise ValueError(
                f"H3 video VAE returned {tuple(video_latent.shape)}, expected {expected_video}"
            )
        if tuple(audio_latent.shape) != expected_audio:
            raise ValueError(
                f"H3 audio VAE returned {tuple(audio_latent.shape)}, expected {expected_audio}"
            )

        # Leave clean source latents unscaled. Native scale_latent_inpaint handles
        # .999 visual conditioning and audio's separate noise schedule each step.
        video_mask = video_mask.to(device=video_latent.device, dtype=video_latent.dtype)
        return (
            {
                "samples": NestedTensor((video_latent, audio_latent)),
                "noise_mask": NestedTensor((video_mask, torch.zeros_like(audio_latent))),
            },
        )
