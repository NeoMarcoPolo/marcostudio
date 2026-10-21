# MarcoStudio

[![CI](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue)](https://www.python.org/downloads/)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

An open-source creative studio powered by ComfyUI. **Relight** adjusts an image's lighting. **Remove Background** creates a transparent PNG. Compare results, download them, or use them as your next source.

The current alpha runs locally with your own ComfyUI. Images, settings, and job history stay on your computer. No MarcoStudio account or credits.

| Tool | Workflow | Model downloads |
| --- | --- | --- |
| Relight | Qwen Image Edit 2509 + Relight adapter, four-step **Flash** | 31.2 GB, five files |
| Remove Background | Qwen Image 2.1, 25 steps, native RGBA output | 17.3 GB, three files |

Download only the models for the tools you use. Qwen Image 2.1 weights use the [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE), which permits research and evaluation; commercial use requires a separate license. MarcoStudio's application code remains MIT licensed.

## Quick start (Windows)

You need:

- Git and Python 3.12+.
- A working [ComfyUI installation](https://docs.comfy.org/installation/system_requirements), running in its own environment.
- Space for the selected tool's models, dependencies and outputs. GPU memory requirements depend on your ComfyUI setup; a minimum has not been established.

In PowerShell, clone the repo and configure the path to your ComfyUI folder:

```powershell
git clone https://github.com/NeoMarcoPolo/marcostudio.git
cd marcostudio
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install .
.\.venv\Scripts\marcostudio.exe configure --comfy-dir "C:\AI\ComfyUI"
.\.venv\Scripts\marcostudio.exe models
```

`models` lists Relight's files. Use `models --feature remove-background` for Remove Background. Download from the printed URLs into the listed ComfyUI model folders. No extra custom-node package is required; Remove Background needs a ComfyUI version with `TextEncodeQwenImage21` and `QwenImage21Cache`.

Start ComfyUI with its normal launcher. From the MarcoStudio folder, start the API proxy and leave it running:

```powershell
.\.venv\Scripts\marcostudio.exe proxy
```

In another PowerShell terminal, open the MarcoStudio folder, check setup, and start the studio:

```powershell
.\.venv\Scripts\marcostudio.exe doctor --feature relight --verify-hashes
.\.venv\Scripts\marcostudio.exe serve
```

Open [http://127.0.0.1:7870](http://127.0.0.1:7870). For Remove Background, check with `doctor --feature remove-background --verify-hashes`. **Check setup** in Settings checks the currently selected tool.

The interface is included: **Node is not required to run MarcoStudio**. Once dependencies and models are installed, it works offline. The server accepts local connections only.

Prebuilt Python wheels are available in [GitHub Releases](https://github.com/NeoMarcoPolo/marcostudio/releases). To use one instead of cloning the repo, create a virtual environment and install the downloaded wheel with that environment's Python, then follow the same configuration and startup steps.

## Using the tools

- Upload a PNG or JPEG, up to 32 MiB and 32 megapixels.
- **Relight:** choose direction, softness, brightness, color and seed, then click **Generate**.
- **Remove Background:** click **Remove background** and download the transparent PNG.
- Compare, download, reuse the result, or regenerate a previous job from history.

History and job tracking survive page refreshes and service restarts. Selecting a previous job restores its tool and settings. PNG transparency is preserved when downloading or reusing a result.

Both tools make generative edits, which can change subject details. Remove Background uses the [official Qwen Image 2.1 workflow](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1), with an approximately 1024 × 1024 pixel budget and the source aspect ratio, rounded to multiples of 32. It does not promise pixel-identical foregrounds or original dimensions.

If a job's status is uncertain, check ComfyUI before submitting it again. **Resolve uncertain job** stops tracking a job after you confirm it is no longer running; it does not cancel or resubmit it. Cancellation targets only the selected job and requires a compatible ComfyUI runtime.

## Configuration

ComfyUI defaults to `http://127.0.0.1:8188`, and the API proxy to `http://127.0.0.1:8189`. Change these in Settings or with `configure --comfy-url ... --proxy-url ...`. Restart the proxy after changing its configuration.

Configuration, images, and job history are stored in your operating system's MarcoStudio application-data directory, outside the source checkout. Use `configure --data-dir ...` to choose another data directory for the next server start. Close the server before backing up that directory.

ComfyUI's `extra_model_paths.yaml` is discovered automatically. For other model-path files, use `configure --extra-model-path "C:\AI\extra_model_paths.yaml"` (repeatable). To select a different configuration file, put `--config <file>` before the command or set `MARCOSTUDIO_CONFIG`.

## CLI

These examples assume the virtual environment is activated. Otherwise use `.\.venv\Scripts\marcostudio.exe` as above.

```powershell
marcostudio doctor --feature relight --verify-hashes
marcostudio doctor --feature remove-background --verify-hashes
marcostudio models --json
marcostudio models --feature remove-background --json
marcostudio run relight --input photo.png --direction front --mode flash --seed 42 --wait 600
marcostudio run remove-background --input photo.png --seed 42 --wait 600
marcostudio jobs list
marcostudio jobs show <job-id>
marcostudio jobs cancel <job-id>
```

`doctor` checks your runtime and the selected tool's models without downloading anything or submitting a job; `--all` checks both tools, and `--verify-hashes` verifies model SHA256 hashes. `run` and `jobs` require the studio server to be running. A `--wait` timeout leaves the job running. Use `marcostudio <command> --help` for more options.

## Contributing

[Report bugs](https://github.com/NeoMarcoPolo/marcostudio/issues) with your OS, Python/ComfyUI versions, and reproduction steps. Remove personal paths and image data from diagnostic output before sharing it. Pull requests are welcome.

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

For frontend development, run `npm run dev` from `frontend` with the studio server running. Rebuild and commit `src/marcostudio/web` after changing the interface. The existing tests require no GPU. CI checks the frontend and installs the Python package on Windows, Linux, and macOS.

## License

Original application code is [MIT licensed](LICENSE). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for adapted public workflows, bundled libraries and separately provisioned model sources.
