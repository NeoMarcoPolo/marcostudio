import importlib
import importlib.util
import re

import pytest
from pydantic import ValidationError

from marcostudio.features import Feature


def entry():
    name = "marcostudio.features.character_swap"
    assert importlib.util.find_spec(name) is not None, "Replace Person is not implemented"
    return importlib.import_module(name).entries()[0]


def graph(*, inputs=None, source="source.mp4", models=None, **settings):
    feature = entry()
    return feature["compile"](
        feature["settings"](**settings),
        source,
        "character/test",
        models or {},
        inputs={"reference_1": "identity.png"} if inputs is None else inputs,
    )


def find(prompt, kind):
    return [(key, node["inputs"]) for key, node in prompt.items() if node["class_type"] == kind]


def only(prompt, kind):
    matches = find(prompt, kind)
    assert len(matches) == 1
    return matches[0]


def test_replace_person_requires_a_character_image_and_rejects_flash():
    feature = Feature(**entry())
    settings = feature.parse_settings({})
    source = {"media_type": "video/mp4", "frame_count": 120}
    assert feature.id == "character-swap"
    assert feature.name == "Replace Person"
    assert feature.modes == ("standard",)
    with pytest.raises(ValueError, match="full-body reference"):
        feature.validate_assets(source, {}, settings)
    feature.validate_assets(source, {"reference_1": {"media_type": "image/png"}}, settings)
    with pytest.raises(ValidationError):
        feature.parse_settings({"mode": "flash"})
    with pytest.raises(ValueError, match="at least 5 frames"):
        feature.validate_assets(
            {"media_type": "video/mp4", "frame_count": 4},
            {"reference_1": {"media_type": "image/png"}},
            settings,
        )


@pytest.mark.parametrize("duration,frames", [(2, 56), (3, 73), (5, 124)])
def test_single_window_is_bounded_and_keeps_the_h3_frame_grid(duration, frames):
    settings = entry()["settings"](duration=duration)
    assert settings.frames == frames
    assert "<Video 1>" in settings.prompt() and "<Picture 1>" in settings.prompt()
    with pytest.raises(ValidationError):
        entry()["settings"](duration=6)


@pytest.mark.parametrize(
    "source,inputs,match",
    [(None, {"reference_1": "person.png"}, "source"), ("source.mp4", {}, "character reference")],
)
def test_compiler_rejects_missing_required_media(source, inputs, match):
    with pytest.raises(ValueError, match=match):
        graph(source=source, inputs=inputs)


def test_ref2va_turbo_and_character_adapters_use_the_pinned_profile():
    prompt = graph()
    model_id, base = only(prompt, "UNETLoader")
    assert base["unet_name"] == "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
    shift_id, shift = only(prompt, "MiniMaxH3SigmaShift")
    assert shift == {"model": [model_id, 0], "shift_video": 12.0, "shift_audio": 3.0}
    attention_id, attention = only(prompt, "ModelAttentionBackend")
    assert attention == {"model": [shift_id, 0], "attention": "pytorch attention"}
    adapters = find(prompt, "LoraLoaderModelOnly")
    assert len(adapters) == 2
    turbo_id, turbo = next(item for item in adapters if "turbo_8step" in item[1]["lora_name"])
    character_id, character = next(
        item for item in adapters if "character_swap" in item[1]["lora_name"]
    )
    assert turbo["model"] == [attention_id, 0] and turbo["strength_model"] == 1.0
    assert character["model"] == [turbo_id, 0] and character["strength_model"] == 1.0
    _, encoder = only(prompt, "CLIPLoader")
    assert encoder["clip_name"] == "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
    assert encoder["type"] == "minimax"
    assert encoder["device"] == "default"
    assert not find(prompt, "SelectCLIPDevice")
    _, guider = only(prompt, "CFGGuider")
    assert guider["model"] == [character_id, 0] and guider["cfg"] == 1.0
    assert guider["negative"] == guider["positive"]
    assert only(prompt, "KSamplerSelect")[1]["sampler_name"] == "er_sde"
    assert only(prompt, "BasicScheduler")[1] == {
        "model": [character_id, 0],
        "scheduler": "normal",
        "steps": 8,
        "denoise": 1.0,
    }
    assert not find(prompt, "BlockSparseAttention")


def test_character_conditioning_uses_padded_performance_and_audio_only_target_guide():
    source = {"class_type": "core/ASSET", "inputs": {"id": "video-asset"}}
    identity = {"class_type": "core/ASSET", "inputs": {"id": "identity-asset"}}
    prompt = graph(source=source, inputs={"reference_1": identity})
    assert only(prompt, "LoadVideo")[1]["file"] is source
    reference_id, reference = only(prompt, "LoadImage")
    assert reference["image"] is identity
    components_id, _ = only(prompt, "GetVideoComponents")
    windows = find(prompt, "MarcoStudioH3Window")
    assert len(windows) == 2
    window_id, window = next(item for item in windows if item[1]["images"] == [components_id, 0])
    assert window["audio"] == [components_id, 1]
    assert (window["width"], window["height"], window["frames"]) == (768, 448, 124)
    assert only(prompt, "Video Slice")[1]["duration"] == 5.0
    condition_id, condition = only(prompt, "MiniMaxH3ReferenceToVideo")
    assert condition["ref_images.ref_image_0"] == [reference_id, 0]
    assert condition["ref_videos.ref_video_0"] == [window_id, 0]
    assert condition["ref_audios.ref_audio_0"] == [window_id, 2]
    assert condition["ref_image_size"] == "match"
    assert condition["length"] == 124
    assert "ref_images.ref_image_1" not in condition
    guide_id, guide = only(prompt, "MiniMaxH3AddGuide")
    assert guide["positive"] == [condition_id, 0]
    assert guide["latent"] == [condition_id, 1]
    assert guide["audio"] == [window_id, 2] and guide["frame_idx"] == 0
    assert "image" not in guide
    assert only(prompt, "CFGGuider")[1]["positive"] == [guide_id, 0]


def test_output_trims_decoded_frames_and_source_soundtrack_to_the_original_count():
    prompt = graph()
    source_id, _ = only(prompt, "GetVideoComponents")
    windows = find(prompt, "MarcoStudioH3Window")
    source_window_id, _ = next(item for item in windows if item[1]["images"] == [source_id, 0])
    decode_id, _ = only(prompt, "VAEDecode")
    decode_window_id, decode_window = next(
        item for item in windows if item[1]["images"] == [decode_id, 0]
    )
    assert decode_window["frames"] == 124
    trim_id, trim = only(prompt, "ImageFromBatch")
    assert trim == {
        "image": [decode_window_id, 0],
        "batch_index": 0,
        "length": [source_window_id, 1],
    }
    duration_id, duration = only(prompt, "ComfyMathExpression")
    assert duration == {"expression": "a / 24", "values.a": [source_window_id, 1]}
    audio_id, audio = only(prompt, "TrimAudioDuration")
    assert audio == {
        "audio": [source_window_id, 2],
        "start_index": 0.0,
        "duration": [duration_id, 0],
    }
    video_id, video = only(prompt, "CreateVideo")
    assert video["images"] == [trim_id, 0] and video["audio"] == [audio_id, 0]
    assert video["fps"] == 24.0
    _, save = only(prompt, "SaveVideo")
    assert save["video"] == [video_id, 0]
    assert save["filename_prefix"] == "character/test"
    assert save["format"] == "mp4" and save["format.codec"] == "h264"
    assert not find(prompt, "VAEDecodeAudio")
    for node in prompt.values():
        for value in node["inputs"].values():
            if isinstance(value, list):
                assert len(value) == 2 and value[0] in prompt and isinstance(value[1], int)


def test_downloads_use_root_lora_paths_and_compile_accepts_verified_loader_aliases():
    manifest = entry()["manifest"]
    models = manifest.MODEL_SETS["standard"]
    assert len(models) == 6
    aliases = {model.key: f"verified/{model.filename}" for model in models}
    prompt = graph(models=aliases)
    for model in models:
        assert any(
            node["class_type"] == model.loader
            and node["inputs"].get(model.field) == aliases[model.key]
            for node in prompt.values()
        )
        assert re.fullmatch(r"[a-f0-9]{40}", model.revision)
        assert re.fullmatch(r"[a-f0-9]{64}", model.sha256)
    loras = {model.filename: model for model in models if model.category == "loras"}
    character = loras["h3_character_swap_v1.5.safetensors"]
    assert character.url == (
        "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/"
        "96ea3407b230b6f7df71c58c70e31df96bd7e533/h3_character_swap_v1.5.safetensors"
    )
    turbo = loras["minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"]
    assert turbo.url == (
        "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/"
        "30f485ed874aa44c8183348ad361c5eabad318da/"
        "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors"
    )
    assert manifest.SOURCE_REVISION in manifest.SOURCE_URL
    assert (
        manifest.SOURCE_SHA256 == "d128d297ecb2696d9560a6eaffec261f29eb502b31c08288dc34d517f65bc476"
    )
