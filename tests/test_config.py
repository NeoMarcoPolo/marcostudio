def test_saved_configuration_with_paths_loads_again(tmp_path):
    from marcostudio.config import Settings, load_settings, save_settings

    config = Settings(
        comfy_dir=tmp_path / "Comfy UI",
        data_dir=tmp_path / "データ",
        extra_model_paths=[tmp_path / "paths.yaml"],
    )
    file = tmp_path / "settings.json"
    save_settings(config, file)
    assert load_settings(file) == config
