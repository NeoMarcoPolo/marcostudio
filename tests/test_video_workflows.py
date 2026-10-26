import re

import pytest
from pydantic import ValidationError

from marcostudio.features.video_tools import entries
from marcostudio.features.video_tools.settings import (
    KeyframesSettings,
    MotionControlSettings,
    VideoSettings,
)

TOOLS = {entry["id"]: entry for entry in entries()}


def compile_tool(tool, *, mode="standard", source="source.png", inputs=None, **settings):
    entry = TOOLS[tool]
    return entry["compile"](
        entry["settings"](mode=mode, instruction="Camera moves", **settings),
        source,
        "video/test",
        {},
        inputs=inputs,
    )


def nodes(graph, kind):
    return [node["inputs"] for node in graph.values() if node["class_type"] == kind]


@pytest.mark.parametrize("tool", TOOLS)
def test_every_registered_mode_has_connected_audio_video_and_native_mp4(tool):
    entry = TOOLS[tool]
    inputs = {
        slot["key"]: f"{slot['key']}.png" for slot in entry["input_slots"] if slot["required"]
    }
    for mode in entry["modes"]:
        graph = compile_tool(tool, mode=mode, inputs=inputs)
        save = graph["12"]
        assert save["class_type"] == "SaveVideo"
        assert save["inputs"]["format"] == "mp4"
        assert save["inputs"]["format.codec"] == "h264"
        video = graph[save["inputs"]["video"][0]]["inputs"]
        assert video["fps"] == 24
        assert graph[video["audio"][0]]["class_type"] == "VAEDecodeAudio"
        assert graph[video["images"][0]]["class_type"] == "VAEDecode"
        assert (
            graph[video["audio"][0]]["inputs"]["samples"]
            == graph[video["images"][0]]["inputs"]["samples"]
        )
        for node in graph.values():
            for value in node["inputs"].values():
                if isinstance(value, list):
                    assert len(value) == 2 and value[0] in graph and isinstance(value[1], int)
        for model in entry["manifest"].MODEL_SETS[mode]:
            assert any(
                node["class_type"] == model.loader
                and node["inputs"].get(model.field) == model.filename
                for node in graph.values()
            )


@pytest.mark.parametrize("duration,frames", [(2, 56), (5, 124), (10, 243)])
def test_frame_grid_and_effective_prompt(duration, frames):
    settings = VideoSettings(duration=duration, instruction="  Camera pans  ")
    assert settings.frames == frames
    assert frames % 17 == 5
    assert settings.actual_duration == frames / 24
    assert settings.prompt() == "Camera pans"
    assert settings.width == 768 and settings.height == 448
    assert VideoSettings().prompt() == ""


@pytest.mark.parametrize(
    "value",
    [
        {"seed": -1},
        {"seed": 9007199254740992},
        {"seed": True},
        {"seed": 1.2},
        {"width": 769},
        {"height": 432},
        {"width": 1344, "height": 1344},
        {"duration": 1},
        {"duration": 11},
        {"duration": 3.5},
        {"extra": "ignored?"},
        {"instruction": "x" * 12001},
    ],
)
def test_settings_reject_invalid_submission_values(value):
    with pytest.raises(ValidationError):
        VideoSettings(**value)


def test_flash_uses_separate_pinned_weights_and_sampler_profiles():
    for tool in ("create-video", "restyle-video"):
        entry = TOOLS[tool]
        assert (
            entry["manifest"].MODEL_SETS["standard"][0] != entry["manifest"].MODEL_SETS["flash"][0]
        )
        standard, flash = compile_tool(tool), compile_tool(tool, mode="flash")
        assert nodes(standard, "BasicScheduler")[0]["steps"] == 20
        assert nodes(flash, "BasicScheduler")[0]["steps"] == 8
        shift = nodes(flash, "MiniMaxH3SigmaShift")[0]
        assert shift["shift_video"] == (12 if tool == "restyle-video" else 10)
        assert shift["shift_audio"] == 3
        sparse = nodes(flash, "BlockSparseAttention")[0]
        assert sparse["selection"] == "vsa" and sparse["selection.keep_percent"] == 10
        assert sparse["sink_conditioning"] == "exact_kv_and_rows"
        assert nodes(flash, "KSamplerSelect")[0]["sampler_name"] == (
            "euler" if tool == "restyle-video" else "res_multistep"
        )


def test_create_video_has_no_image_loader_and_transition_requires_two_frames():
    assert not nodes(compile_tool("create-video", source=None), "LoadImage")
    with pytest.raises(ValueError, match="last frame"):
        compile_tool("transition")
    graph = compile_tool("transition", inputs={"last_frame": "last.png"})
    conditioning = nodes(graph, "MiniMaxH3ImageToVideo")[0]
    assert graph[conditioning["first_frame"][0]]["inputs"]["image"] == "source.png"
    assert graph[conditioning["last_frame"][0]]["inputs"]["image"] == "last.png"


def test_asset_references_preserved_and_restyle_uses_video_audio_and_optional_images():
    source = {"class_type": "core/ASSET", "inputs": {"id": "video-asset"}}
    ref = {"class_type": "core/ASSET", "inputs": {"id": "image-asset"}}
    graph = compile_tool("restyle-video", source=source, inputs={"reference_1": ref})
    assert nodes(graph, "LoadVideo")[0]["file"] is source
    assert nodes(graph, "LoadImage")[0]["image"] is ref
    condition = nodes(graph, "MiniMaxH3ReferenceToVideo")[0]
    assert "ref_videos.ref_video_0" in condition
    assert "ref_video_audios.ref_video_audio_0" in condition
    assert "ref_images.ref_image_0" in condition
    assert "ref_images.ref_image_1" not in condition
    assert nodes(graph, "Video Slice")[0]["duration"] == 124 / 24
    assert nodes(graph, "MarcoStudioH3Window")[0]["frames"] == 124
    assert nodes(graph, "MarcoStudioH3Window")[0]["width"] == 768


def test_keyframes_anchor_source_and_guides_in_order_without_changing_latent():
    graph = compile_tool(
        "keyframes",
        guide_frames=[24, 72, 123],
        inputs={f"guide_{i}": f"guide{i}.png" for i in range(1, 4)},
    )
    guides = nodes(graph, "MiniMaxH3AddGuide")
    assert [guide["frame_idx"] for guide in guides] == [0, 24, 72, 123]
    assert all(guide["latent"] == ["5", 1] for guide in guides)
    assert graph["7"]["inputs"]["conditioning"] == ["36", 0]


def test_keyframes_reject_flash_that_drops_the_opening_anchor():
    assert TOOLS["keyframes"]["modes"] == ("standard",)
    assert set(TOOLS["keyframes"]["manifest"].MODEL_SETS) == {"standard"}
    with pytest.raises(ValidationError):
        KeyframesSettings(mode="flash")


@pytest.mark.parametrize("indices", [[0], [-1], [24, 24], [72, 24], [124], [True], [1, 2, 3, 4]])
def test_keyframes_reject_invalid_guide_timing(indices):
    with pytest.raises(ValidationError):
        KeyframesSettings(guide_frames=indices)


@pytest.mark.parametrize("inputs", [{}, {"guide_1": "a", "guide_2": "b"}, {"guide_2": "b"}])
def test_keyframes_reject_missing_or_mismatched_guides(inputs):
    with pytest.raises(ValueError):
        compile_tool("keyframes", inputs=inputs)


def test_motion_control_native_union2_mask_geometry_and_preprocessed_bypass():
    graph = compile_tool("motion-control", inputs={"mask": "mask.png"})
    assert not nodes(graph, "Canny")
    assert not nodes(graph, "MiniMaxH3FunControlNetApply")
    assert not nodes(graph, "ModelPatchLoader")
    assert nodes(graph, "UNETLoader")[0]["unet_name"].startswith("minimax_h3_fl2va")
    inpaint = nodes(graph, "MarcoStudioH3InpaintLatent")[0]
    assert inpaint["images"] == ["24", 0]
    mask = graph[inpaint["mask"][0]]
    assert mask["class_type"] == "ImageToMask" and mask["inputs"]["channel"] == "red"
    geometry = graph[mask["inputs"]["image"][0]]["inputs"]
    assert (geometry["width"], geometry["height"], geometry["crop"]) == (768, 448, "center")
    assert geometry["upscale_method"] == "nearest-exact"
    assert graph["10"]["inputs"]["latent_image"] == ["33", 0]
    composite = nodes(graph, "ImageCompositeMasked")[0]
    assert composite["destination"] == ["24", 0]
    assert composite["mask"] == inpaint["mask"]
    assert graph["14"]["inputs"]["images"] == ["35", 0]
    assert graph["14"]["inputs"]["audio"] == ["24", 2]
    assert len(nodes(compile_tool("motion-control"), "Canny")) == 1
    preprocessed = compile_tool("motion-control", control_type="preprocessed")
    assert nodes(preprocessed, "ModelPatchLoader")[0]["name"].endswith(
        "union_2.0_pruned_int8_convrot.safetensors"
    )
    assert not nodes(preprocessed, "Canny")
    assert "mask" not in nodes(preprocessed, "MiniMaxH3FunControlNetApply")[0]
    with pytest.raises(ValidationError):
        MotionControlSettings(mode="flash")


def test_provenance_is_public_content_pinned_and_complete():
    for entry in TOOLS.values():
        manifest = entry["manifest"]
        assert re.fullmatch(r"[a-f0-9]{40}", manifest.SOURCE_REVISION)
        assert re.fullmatch(r"[a-f0-9]{64}", manifest.SOURCE_SHA256)
        assert manifest.SOURCE_REVISION in manifest.SOURCE_URL
        for mode, models in manifest.MODEL_SETS.items():
            assert mode in entry["modes"]
            assert len({m.key for m in models}) == len(models)
            for model in models:
                assert model.size > 0
                assert re.fullmatch(r"[a-f0-9]{64}", model.sha256)
                assert re.fullmatch(r"[a-f0-9]{40}", model.revision)
                assert model.revision in model.url


def test_readiness_model_names_override_each_selected_loader():
    entry = TOOLS["animate-image"]
    names = {
        model.key: f"custom/{model.filename}" for model in entry["manifest"].MODEL_SETS["flash"]
    }
    graph = entry["compile"](VideoSettings(mode="flash"), "source.png", "out", names)
    for model in entry["manifest"].MODEL_SETS["flash"]:
        assert any(
            node["class_type"] == model.loader
            and node["inputs"].get(model.field) == names[model.key]
            for node in graph.values()
        )
