import json


def test_doctor_bad_config_exits_two_without_creating_data(tmp_path, capsys):
    from marcostudio.cli import main

    path = tmp_path / "bad.json"
    path.write_text('{"comfy_url":"https://remote.example"}')
    assert main(["--config", str(path), "doctor", "--json"]) == 2
    assert json.loads(capsys.readouterr().out)["ready"] is False
    assert list(tmp_path.iterdir()) == [path]


def test_models_lists_pinned_public_checkpoints(capsys):
    from marcostudio.cli import main

    assert main(["models", "--json"]) == 0
    models = json.loads(capsys.readouterr().out)
    assert len(models) == 5
    assert all(len(model["sha256"]) == 64 and "huggingface.co" in model["url"] for model in models)
