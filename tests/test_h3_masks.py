"""CPU numerical contracts for the optional ComfyUI node bundle."""

import importlib

import pytest

torch = pytest.importorskip("torch")
cli_args = pytest.importorskip("comfy.cli_args")
cli_args.args.cpu = True
h3 = importlib.import_module("marcostudio.comfy_nodes.h3")


@pytest.mark.parametrize("fps", [24, 30, 60])
def test_window_preserves_source_duration_at_different_frame_rates(fps):
    images = torch.arange(fps * 2, dtype=torch.float32)[:, None, None, None].expand(-1, 32, 32, 3)
    result, count, audio = h3.MarcoStudioH3Window().execute(images, 32, 32, 56, source_fps=fps)
    assert count == 48
    assert result.shape[0] == 56
    assert result[24, 0, 0, 0] == fps
    assert torch.equal(result[-1], result[47])
    assert audio["waveform"].shape[-1] == round(56 * audio["sample_rate"] / 24)


@pytest.mark.parametrize(
    ("frame", "latent_frame"),
    [
        (0, 0),
        (1, 1),
        (4, 1),
        (5, 2),
        (8, 2),
        (9, 3),
        (12, 3),
        (13, 4),
        (16, 4),
        (17, 5),
        (18, 6),
        (21, 6),
    ],
)
def test_single_frame_stroke_survives_causal_and_spatial_pooling(frame, latent_frame):
    mask = torch.zeros(22, 64, 64)
    mask[frame, 31, 31] = 1

    result = h3.h3_noise_mask(mask, frames=22, height=64, width=64)

    assert result.shape == (1, 1, 7, 4, 4)
    assert result.sum().item() == 4
    assert torch.equal(result[0, 0, latent_frame, :2, :2], torch.ones(2, 2))


def test_static_mask_broadcasts_and_selects_whole_packed_tokens():
    mask = torch.zeros(1, 64, 64)
    mask[:, :, 32:] = 1

    result = h3.h3_noise_mask(mask, frames=124, height=64, width=64)

    assert result.shape == (1, 1, 37, 4, 4)
    assert torch.count_nonzero(result[..., :2]).item() == 0
    assert torch.all(result[..., 2:] == 1)


def test_mask_is_hard_and_does_not_edit_below_half_opacity():
    mask = torch.full((1, 32, 64), 0.49)
    mask[0, 0, 32] = 0.51

    result = h3.h3_noise_mask(mask, frames=5, height=32, width=64)

    assert torch.equal(result[0, 0, 0], torch.tensor([[0.0, 0.0, 1.0, 1.0]]).repeat(2, 1))
    assert torch.equal(result[0, 0, 0], result[0, 0, 1])


@pytest.mark.parametrize(
    ("shape", "frames", "height", "width"),
    [
        ((1, 32, 32), 21, 32, 32),
        ((1, 32, 32), 5, 32, 48),
        ((2, 32, 32), 5, 32, 32),
        ((1, 64, 32), 5, 32, 32),
    ],
)
def test_incompatible_masks_fail_instead_of_interpolating_the_causal_axis(
    shape, frames, height, width
):
    with pytest.raises(ValueError):
        h3.h3_noise_mask(torch.zeros(shape), frames=frames, height=height, width=width)


def test_window_repeats_last_frame_and_reports_original_length():
    images = torch.stack([torch.full((32, 32, 3), value) for value in (0.1, 0.3, 0.7)])

    frames, count, audio = h3.MarcoStudioH3Window().execute(images, 32, 32, 5)

    assert count == 3
    assert torch.equal(frames[:3], images)
    assert torch.equal(frames[3], images[-1])
    assert torch.equal(frames[4], images[-1])
    assert audio["sample_rate"] == 48000
    assert audio["waveform"].shape == (1, 2, 10000)
    assert torch.count_nonzero(audio["waveform"]).item() == 0


def test_window_center_crop_and_trim_keep_the_same_source_window():
    images = torch.full((8, 64, 96, 3), 0.25)
    images[:, :, :16] = 0
    images[:, :, 80:] = 1
    images[5:] = 0.9
    source_audio = {"waveform": torch.arange(400.0).reshape(1, 1, 400), "sample_rate": 1200}

    frames, count, audio = h3.MarcoStudioH3Window().execute(images, 64, 64, 5, source_audio)

    assert count == 5
    assert frames.shape == (5, 64, 64, 3)
    assert torch.allclose(frames, torch.full_like(frames, 0.25))
    assert audio["waveform"].shape == (1, 2, 250)
    assert audio["sample_rate"] == 1200
    assert torch.equal(audio["waveform"][0, 0], torch.arange(250.0))
    assert torch.equal(audio["waveform"][0, 1], torch.arange(250.0))


def test_window_pads_audio_with_silence_without_changing_existing_samples():
    audio = {"waveform": torch.full((1, 2, 100), 0.3), "sample_rate": 24000}

    _, _, aligned = h3.MarcoStudioH3Window().execute(torch.zeros(5, 32, 32, 3), 32, 32, 5, audio)

    assert aligned["waveform"].shape == (1, 2, 5000)
    assert torch.equal(aligned["waveform"][..., :100], audio["waveform"])
    assert torch.count_nonzero(aligned["waveform"][..., 100:]).item() == 0


class MeanVideoEncoder:
    """Tiny deterministic codec: masking source pixels would change the encoded result."""

    def encode(self, images):
        return torch.ones(1, 24, 7, 4, 4) * images.mean()


class MeanAudioEncoder:
    audio_sample_rate = 32000

    def encode(self, waveform):
        # Mirrors the public VAE's channels-last input and native stereo latent layout.
        assert waveform.shape == (1, 29600, 2)
        channels = waveform.mean(dim=1).reshape(1, 1, 2, 1)
        return channels.expand(1, 32, 2, 37).clone()


def test_latent_retains_clean_full_source_and_preserved_stereo_audio():
    images = torch.full((22, 64, 64, 3), 0.75)
    mask = torch.zeros(1, 64, 64)
    mask[:, :, 32:] = 1
    audio = {"waveform": torch.full((1, 2, 29600), 0.25), "sample_rate": 32000}
    audio["waveform"][:, 1] = 0.5

    (latent,) = h3.MarcoStudioH3InpaintLatent().execute(
        images, mask, MeanVideoEncoder(), MeanAudioEncoder(), audio
    )

    video, sound = latent["samples"].unbind()
    video_mask, sound_mask = latent["noise_mask"].unbind()
    assert video.shape == (1, 24, 7, 4, 4)
    assert torch.all(video == 0.75)  # No mask burn-in and no premature .999 scaling.
    assert sound.shape == (1, 32, 2, 37)
    assert torch.all(sound[:, :, 0] == 0.25)
    assert torch.all(sound[:, :, 1] == 0.5)
    assert video_mask.shape == (1, 1, 7, 4, 4)
    assert torch.all(video_mask[..., :2] == 0)
    assert torch.all(video_mask[..., 2:] == 1)
    assert sound_mask.shape == sound.shape
    assert torch.count_nonzero(sound_mask).item() == 0


def test_audio_is_resampled_and_fitted_to_exact_native_token_count():
    images = torch.zeros(22, 64, 64, 3)
    audio = {"waveform": torch.zeros(1, 1, 44000), "sample_rate": 48000}

    (latent,) = h3.MarcoStudioH3InpaintLatent().execute(
        images, torch.zeros(1, 64, 64), MeanVideoEncoder(), MeanAudioEncoder(), audio
    )

    sound = latent["samples"].unbind()[1]
    assert sound.shape == (1, 32, 2, 37)
    assert torch.count_nonzero(sound).item() == 0


def test_wrong_vae_layout_is_rejected_before_sampling():
    class WrongAudioEncoder:
        audio_sample_rate = 32000

        def encode(self, waveform):
            return torch.zeros(1, 8, 37)

    with pytest.raises(ValueError, match="audio"):
        h3.MarcoStudioH3InpaintLatent().execute(
            torch.zeros(22, 64, 64, 3),
            torch.zeros(1, 64, 64),
            MeanVideoEncoder(),
            WrongAudioEncoder(),
            {"waveform": torch.zeros(1, 2, 29600), "sample_rate": 32000},
        )
