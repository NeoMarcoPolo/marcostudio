import pytest


def test_flash_graph_preserves_image_conditioning_and_valid_connections():
    from marcostudio.features.relight.settings import RelightSettings
    from marcostudio.features.relight.workflow import compile_workflow

    graph = compile_workflow(RelightSettings(seed=42, direction="left"), "input.png", "run-1", {})
    assert graph["3"]["inputs"]["steps"] == 4
    assert graph["3"]["inputs"]["seed"] == 42
    assert graph["3"]["inputs"]["latent_image"] == ["88", 0]
    assert graph["88"]["inputs"]["pixels"] == ["117", 0]
    assert "viewer’s left" in graph["111"]["inputs"]["prompt"]
    assert graph["111"]["inputs"]["prompt"].startswith("重新照明,")
    assert graph["110"]["inputs"]["prompt"] == ""
    assert graph["12"]["inputs"]["filename_prefix"] == "run-1"
    for node in graph.values():
        for value in node["inputs"].values():
            if isinstance(value, list):
                assert value[0] in graph


def test_standard_cannot_silently_run_flash():
    from marcostudio.features.relight.settings import RelightSettings
    from marcostudio.features.relight.workflow import compile_workflow

    with pytest.raises(ValueError, match="Standard"):
        compile_workflow(RelightSettings(mode="standard"), "a.png", "r", {})


@pytest.mark.parametrize(
    "settings",
    [
        {"brightness": 55},
        {"brightness": 0},
        {"color": "blue"},
        {"seed": -1},
        {"direction": "custom"},
        {"direction": "custom", "azimuth": float("nan"), "elevation": 0},
    ],
)
def test_invalid_settings_rejected(settings):
    from marcostudio.features.relight.settings import RelightSettings

    with pytest.raises(ValueError):
        RelightSettings(**settings)


def test_compiles_are_independent_and_direction_is_normalized():
    from marcostudio.features.relight.settings import RelightSettings
    from marcostudio.features.relight.workflow import compile_workflow

    a = compile_workflow(RelightSettings(), "a.png", "a", {"diffusion": "nested/model.safetensors"})
    b = compile_workflow(RelightSettings(direction="back"), "b.png", "b", {})
    a["89"]["inputs"]["strength_model"] = 0
    assert b["89"]["inputs"]["strength_model"] == 1
    assert a["37"]["inputs"]["unet_name"] == "nested/model.safetensors"
    assert RelightSettings(direction="top").vector() == pytest.approx((0, 1, 0))
    assert RelightSettings(direction="back").vector() == pytest.approx((0, 0, -1))


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://127.0.0.1@evil.test",
        "file:///a",
        "http://127.0.0.1:8188/?token=x",
    ],
)
def test_config_never_accepts_remote_inference_or_credentials(url, tmp_path):
    from marcostudio.config import Settings

    with pytest.raises(ValueError):
        Settings(comfy_url=url, data_dir=tmp_path)
