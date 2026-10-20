# MarcoStudio

[![CI](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue)](https://www.python.org/downloads/)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Relight images with your own ComfyUI. Choose the light, generate, compare, download, or use the result as a new source. Images, settings and job history stay on your computer. No MarcoStudio account or credits.

**Development preview.** Hardware coverage and output quality are still being evaluated. [Download the preview](https://github.com/NeoMarcoPolo/marcostudio/releases) or install from source below.

| Connection | Status |
| --- | --- |
| Installed MarcoStudio + local ComfyUI | Available: Relight with Flash |
| Website + your ComfyUI | Planned |
| Your Comfy API key + Comfy Cloud | Planned |

Relight uses one pinned public workflow: Qwen Image Edit 2509 + the Relight adapter. **Flash** runs its published four-step Lightning recipe. Standard remains unavailable until a separate sampling profile is validated. Acceleration can affect results; no specific quality loss or speedup is claimed.

## Windows setup

You need Python 3.12+, a working local [ComfyUI installation](https://docs.comfy.org/installation/system_requirements), and enough GPU/system memory for the selected Qwen models. The five model files total approximately **31.2 GB**, in addition to ComfyUI, Python packages and output storage. A minimum VRAM requirement has not been established for this release.

ComfyUI runs in its own Python environment. MarcoStudio does not install, upgrade, restart or manage that runtime. Its doctor checks the running node contracts rather than assuming a version number is sufficient. No extra custom-node package is required by this workflow.

In PowerShell:

```powershell
git clone https://github.com/NeoMarcoPolo/marcostudio.git
cd marcostudio
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install .
.\.venv\Scripts\marcostudio.exe configure --comfy-dir "C:\AI\ComfyUI"
.\.venv\Scripts\marcostudio.exe models
```

Use the pinned download URLs printed by `models` and place each file in its listed model category. Model weights are separate downloads and have their own licenses. Never rename a different checkpoint to satisfy a filename check. Use **Check setup** in Settings once ComfyUI recognizes the files.

Start ComfyUI using its normal launcher. In a second terminal, run the local proxy:

```powershell
.\.venv\Scripts\marcostudio.exe proxy
```

In a third terminal:

```powershell
.\.venv\Scripts\marcostudio.exe doctor --feature relight --verify-hashes
.\.venv\Scripts\marcostudio.exe serve
```

Open **http://127.0.0.1:7870**. ComfyUI and the API proxy default to loopback ports 8188 and 8189. Their URLs can be changed in Settings or with `configure --comfy-url ... --proxy-url ...`. Keep the proxy's upstream and the native URL aligned. Stop and restart the proxy after changing its configuration.

The Python wheel includes the built interface; **Node is not required to run it**. After packages and models are installed, the app needs no account, external service, CDN or internet connection. This release binds to loopback and is intended for one local user.

To install a downloaded wheel instead, create a Python virtual environment and run `python -m pip install <path-to-wheel>` with that environment's Python. Then follow the same configuration, model and startup steps. Packages are distributed through GitHub Releases.

## Using Relight

- Upload a still PNG or JPEG, up to 32 MiB and 32 megapixels. The original is retained; the working image is orientation-corrected and stripped of source metadata.
- Choose a direction preset or custom angles, soft/hard lighting, brightness, color and seed. Controls guide the model through a prompt: they are approximate artistic instructions, not a physically calibrated lighting simulation. Nearby custom angles can map to the same instruction.
- Click Generate explicitly. Editing controls never submits work. The four-step workflow may resize the image; actual output dimensions are recorded.
- Compare the original/result, download, reuse the result, or regenerate a historical job from its recorded input and settings.

Identity, geometry, text and background preservation require evaluation on your own inputs. Successful execution and image decoding do not establish photographic quality or equivalence to another product.

## Jobs and recovery

Jobs persist across browser and service restarts. The service serializes its own submissions. Repeated requests with the same request ID return the existing job; changed input/settings with that ID are rejected. An uncertain submission is reconciled without automatic resubmission.

Cancellation is scoped to a known job through ComfyUI's own job endpoint. It may be unavailable on older runtimes. A request stays pending until termination or queue removal is confirmed. MarcoStudio never clears the shared queue or calls global interruption.

If a run remains uncertain because its upstream history was lost, first inspect ComfyUI. **Resolve uncertain job** asks for explicit confirmation that it is no longer running, checks the reachable runtime, and stops tracking it. This action neither cancels nor resubmits work; history says **Stopped tracking**, not success. Keep an uncertain job tracked until you have checked its state.

User configuration and data use your operating system's MarcoStudio application-data location. `configure --data-dir ...` chooses a different data location for the next server start. `--config <file>` (before the command), or `MARCOSTUDIO_CONFIG`, selects an alternate configuration file. Originals, normalized assets, SQLite history and JSON receipts are stored outside the source checkout by default. Only one server may use a data directory at a time. Close the server before backing up the entire directory.

For additional model locations, pass the same YAML files used by ComfyUI to `configure --extra-model-path "C:\AI\extra_model_paths.yaml"` (repeatable). The standard `extra_model_paths.yaml` beside ComfyUI's `main.py` is discovered automatically. Ambiguous basenames require an exact loader-relative name in the configuration's `model_aliases` map; keys are `diffusion`, `encoder`, `vae`, `lightning`, and `relight`.

## CLI

These examples assume the virtual environment is activated. Otherwise use `.\.venv\Scripts\marcostudio.exe` as above.

```powershell
marcostudio doctor --all --json
marcostudio doctor --feature relight --verify-hashes
marcostudio models --json
marcostudio run relight --input photo.png --direction front --softness soft --brightness 50 --color "#ffffff" --mode flash --seed 42 --wait 600
marcostudio jobs list
marcostudio jobs show <job-id>
marcostudio jobs cancel <job-id>
marcostudio jobs resolve <job-id> --confirm-not-running
```

`run` and `jobs` contact the running studio (`--server` changes its loopback URL). They use the same validation and job service as the interface. Save the printed request ID; use `--request-id` with the same input and settings for a deliberate retry after a lost response. No submission is retried automatically. A wait timeout exits 3 and leaves the job running; inspect it using `jobs show`.

Doctor is read-only: no downloads, tensor loading, inference or queue mutation. Normal checks verify registered nodes, input contracts, loader choices, file sizes and safetensors headers. Exact checkpoint identities remain **unverified** unless `--verify-hashes` streams their contents. Proxy health is checked separately from native ComfyUI. Exit codes: 0 ready, 1 prerequisites unavailable/incompatible/indeterminate, 2 invalid configuration or internal error. Readiness does not prove inference quality.

## Contributing

[Report a bug](https://github.com/NeoMarcoPolo/marcostudio/issues) with your OS, Python/ComfyUI versions, reproduction steps and relevant diagnostic results. Remove personal paths and image data from reports. Keep pull requests focused; discuss new tools or execution backends in an issue first.

Python dependencies are locked in `uv.lock`; frontend dependencies in `frontend/package-lock.json`. Use Python 3.12 and a Node version supported by the pinned Vite release (Node 22.12+ is suitable).

```powershell
uv sync --locked --extra dev
cd frontend
npm ci
npm run test -- --run
npm run typecheck
npm run build
cd ..
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m ruff check src tests
.\.venv\Scripts\python.exe -m build
```

Frontend development uses same-origin `/api` requests through Vite's local proxy. The production build is stored in `src/marcostudio/web`; rebuild it after changing the interface. Tests use synthetic images and protocol mocks, including the released SDK/proxy pair, and require no GPU.

CI runs the existing checks and installs the wheel in a separate environment on Windows, Linux and macOS. These checks cover application behavior and packaging, not GPU compatibility.

## Releases

Update the Python version in `pyproject.toml` and `src/marcostudio/__init__.py`, refresh `uv.lock`, and commit the rebuilt interface. A matching `v*` tag (for example, `v0.1.0a1`) runs CI and publishes the wheel and source archive as a GitHub prerelease. The workflow does not publish to PyPI.

## License

Original application code is [MIT licensed](LICENSE). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for the adapted [public workflow](https://github.com/Comfy-Org/workflow_templates/blob/04a508b31bec1818e48122ca0761c1de4140a234/templates/image_qwen_image_edit_2509_relight.json), bundled libraries and separately provisioned model sources.
