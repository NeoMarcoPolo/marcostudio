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


def test_jobs_cli_preserves_waiting_diagnostics_and_server(monkeypatch, capsys):
    import httpx

    from marcostudio.cli import main

    pending = {
        "id": "pending",
        "status": "preparing",
        "waiting": {
            "message": "Waiting for active jobs",
            "blockers": [
                {
                    "id": "old",
                    "status": "needs_attention",
                    "resolve_command": "marcostudio jobs --server STUDIO_URL resolve old --confirm-not-running",
                }
            ],
        },
    }
    requested = []
    original_client = httpx.Client

    def respond(request):
        requested.append((request.method, str(request.url)))
        return httpx.Response(200, json=[pending] if request.url.path == "/api/jobs" else pending)

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    assert main(["jobs", "--server", "http://127.0.0.1:7999", "list"]) == 0
    assert json.loads(capsys.readouterr().out) == [pending]
    assert main(["jobs", "--server", "http://127.0.0.1:7999", "show", "pending"]) == 0
    assert json.loads(capsys.readouterr().out) == pending
    assert requested == [
        ("GET", "http://127.0.0.1:7999/api/jobs"),
        ("GET", "http://127.0.0.1:7999/api/jobs/pending"),
    ]
