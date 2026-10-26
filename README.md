# MarcoStudio

[![CI](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NeoMarcoPolo/marcostudio/actions/workflows/ci.yml)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue)](https://www.python.org/downloads/)
[![MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

An open-source interface for your local ComfyUI. MarcoStudio provides the controls and workflows; your running ComfyUI generates the images and videos.

You need a working ComfyUI installation on the computer you're using. No MarcoStudio account or credits. The [application and workflow source](https://github.com/NeoMarcoPolo/marcostudio) are public; workflow definitions live in [src/marcostudio/features](src/marcostudio/features).

## Use your ComfyUI

The browser interface connects directly to ComfyUI. No MarcoStudio server or proxy is needed. This flow is available in the local development build; a public hosted release is not deployed yet.

Start ComfyUI and open MarcoStudio. A short setup panel checks:

1. **ComfyUI detected** — click **Connect** to find your running installation.
2. **Models and nodes** — click **Install missing** for model downloads, or **Open ComfyUI** to set things up yourself. The panel updates automatically.
3. **Ready** — click **Open studio**.

Checks advance automatically. Model downloads show their size before you install, reuse matching files, and go into ComfyUI's configured folders. Setup checks your starting tool, Relight by default; other tools can be set up when you use them. Missing node instructions, sources, and licenses are under **Details**.

Future visits reconnect and skip completed setup. Your media stays between your browser and ComfyUI.

<details>
<summary>Connection and automatic setup</summary>

Connection checks the usual local ports, 8188 and 8000. If it cannot connect, you can enter another address. Allow local-network access if your browser asks. ComfyUI must allow the website's origin; MarcoStudio will show the launch option in connection help.

Automatic downloads use **ComfyUI-Manager 4** on the same connection. If it is unavailable, tools whose requirements are already installed still work. Help appears only when a missing requirement needs it.

Automatic setup currently downloads models only. Update built-in nodes in ComfyUI; MarcoStudio's video nodes have a download under **Details**. They are not yet published in the Comfy registry, so automatic node installation is unavailable. Restart ComfyUI yourself when its queue is idle; the panel reconnects and checks again. Onboarding never restarts ComfyUI or submits a generation.

The browser stores its connection, uploads, and job references locally and recovers job status after refresh. Unknown submission results are checked against ComfyUI's queue/history without resubmitting. Clearing browser data removes those local records; save results you want to keep. The optional Python application stores its own media and history separately.

Readiness checks loaded node contracts and model names visible in ComfyUI. It does not verify file checksums. HTTPS browser permission behavior and real Manager downloads still need release validation; the local build has protocol and recovery tests.

</details>

## Tools

| Tool | Inputs | Model / mode |
| --- | --- | --- |
| Relight | Image + light controls | Qwen Image Edit 2509 + Relight, Flash |
| Remove Background | Image | Qwen Image 2.1, Standard; transparent PNG |
| Create Image | Prompt | Qwen Image 2.1, Standard / Flash |
| Edit Image | Image + prompt + up to three references | Qwen Image 2.1, Standard / Flash |
| AI Stylist | Person + outfit reference + optional instructions | Qwen Image 2.1, Standard / Flash |
| Product Scene | Product + scene prompt or reference | Qwen Image 2.1, Standard / Flash |
| Create Video | Prompt | MiniMax H3, Standard / Flash |
| Animate Image | First frame + prompt | MiniMax H3, Standard / Flash |
| Transition | First and last frames + prompt | MiniMax H3, Standard / Flash |
| Restyle Video | Video + prompt + optional image references | MiniMax H3 OmniRef, Standard / Flash |
| Replace Person | Video + character reference | MiniMax H3 + Character Swap V1.5, eight steps |
| Keyframes | First frame + one to three timed images + prompt | MiniMax H3 OmniRef, Standard |
| Motion Control | Video + prompt + optional edit mask | MiniMax H3, Standard |

Flash uses eight-step Qwen Turbo or FastH3 checkpoints; Relight uses its four-step adapter. Standard and Flash have separate model downloads. Image/video generation quality and performance depend on your runtime and inputs; this expanded tool set is experimental.

Download only the models for the tools you use. Qwen Image 2.1 weights use the [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE), which permits research and evaluation; commercial use requires a separate license. MarcoStudio's application code remains MIT licensed.

Video tools are Powered by MiniMax H3. H3 and Character Swap weights have separate [model license terms](https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/blob/96ea3407b230b6f7df71c58c70e31df96bd7e533/LICENSE).

## Run the current alpha (Windows)

These instructions run the optional Python application, with its local file storage and CLI. To run just the website locally, see [Development](#development).

You need:

- Git and Python 3.12+.
- A working [ComfyUI installation](https://docs.comfy.org/installation/system_requirements), running in its own environment.
- For video tools, FFmpeg and FFprobe available on `PATH`.
- Space for the selected tool's models, dependencies and outputs. GPU memory requirements depend on your ComfyUI setup; a minimum has not been established.

In PowerShell, clone the repo and configure the path to your ComfyUI folder:

```powershell
git clone https://github.com/NeoMarcoPolo/marcostudio.git
cd marcostudio
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install .
.\.venv\Scripts\marcostudio.exe configure --comfy-dir "C:\AI\ComfyUI"
.\.venv\Scripts\marcostudio.exe install-nodes
.\.venv\Scripts\marcostudio.exe models
```

`models` lists Relight's files. Select another tool with `models --feature <tool-id>` and add `--mode flash` for its Flash checkpoints. Download from the printed URLs into the listed ComfyUI model folders. `install-nodes` copies MarcoStudio's video adapters into the configured ComfyUI folder; restart ComfyUI after installing or updating them. Use a runtime with Qwen Image 2.1 and MiniMax H3 support. FastH3 OmniRef also needs [PDD support](https://github.com/Comfy-Org/ComfyUI/commit/ce42de5f64ac1d421e304ab7b6c0b3d2f0dde1f6); `doctor` checks the running implementation before submitting these jobs.

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
- **Image tools:** enter a prompt and add the references shown below the preview. Outfit and product references are generative guidance, not exact texture transfers.
- **Video tools:** enter a prompt, choose size and duration, and add any required frames or source video. MP4 uploads are limited to 15 seconds and 96 MiB and are normalized locally to 24 fps. Output is MP4 with audio.
- **Keyframes:** add guide images in order and set increasing timestamps within the output duration.
- **Replace Person:** use a full-body reference showing the person and outfit. Processes up to five seconds and keeps the source soundtrack.
- **Motion Control:** extract edges from a source video or use a prepared control video. Adding a mask switches to a masked edit: white replaces, black preserves. Source pixels outside the mask are composited back before MP4 encoding.
- Compare image results, play videos, download, reuse the result, or regenerate a previous job from history.

Job references survive page refreshes. Selecting a previous job restores its tool, prompt, settings, source and references. The browser reconciles those references with ComfyUI; if ComfyUI clears a pending request's history, its status may need manual resolution. PNG transparency is preserved when downloading or reusing a result.

Image edits can change subject details. Remove Background uses the [official Qwen Image 2.1 workflow](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1), with an approximately 1024 × 1024 pixel budget and the source aspect ratio, rounded to multiples of 32. It does not promise pixel-identical foregrounds or original dimensions. Video durations are rounded up to H3's frame grid; the duration menu shows the resulting length.

If a job's status is uncertain, check ComfyUI before submitting it again. **Resolve uncertain job** stops tracking a job after you confirm it is no longer running; it does not cancel or resubmit it. The browser can remove a queued job by ID. Cancel running jobs in ComfyUI; MarcoStudio never sends a global interrupt.

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
marcostudio run create-image --prompt "A ceramic teapot on a wooden table" --mode flash
marcostudio run edit-image --input photo.png --prompt "Replace the sky with sunset"
marcostudio run ai-stylist --input person.png --asset reference_1=outfit.png
marcostudio run product-scene --input product.png --prompt "On a marble counter beside a window"
marcostudio run create-video --prompt "Waves breaking on a beach, ocean sound" --duration 5
marcostudio run animate-image --input photo.png --prompt "Slow camera push forward"
marcostudio run transition --input first.png --asset last_frame=last.png --prompt "The camera moves through the doorway"
marcostudio run restyle-video --input clip.mp4 --prompt "Turn the scene into a watercolor animation"
marcostudio run character-swap --input clip.mp4 --asset reference_1=person.png
marcostudio run keyframes --input first.png --asset guide_1=middle.png --guide-frames 48 --prompt "A continuous camera move"
marcostudio run motion-control --input clip.mp4 --prompt "A dancer on a theater stage"
marcostudio jobs list
marcostudio jobs show <job-id>
marcostudio jobs cancel <job-id>
```

`doctor` checks your runtime and the selected tool's models without downloading anything or submitting a job; `--all` checks every tool's default mode. Add `--mode flash` when checking a Flash workflow. `--verify-hashes` verifies model SHA256 hashes. `run` and `jobs` require the studio server to be running. A `--wait` timeout leaves the job running. Use `marcostudio <command> --help` for more options.

## Contributing

[Report bugs](https://github.com/NeoMarcoPolo/marcostudio/issues) with your OS, Python/ComfyUI versions, and reproduction steps. Remove personal paths and image data from diagnostic output before sharing it. Pull requests are welcome.

## Development

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

For the website, run `npm run dev` from `frontend` and open the printed address with `?runtime=browser`. Start ComfyUI normally and connect from the setup panel. No Python application or proxy is required. `npm run build` produces the static site in `src/marcostudio/web`, ready to serve from a dedicated origin.

Without `?runtime=browser`, the interface uses a local MarcoStudio server if its settings API responds; otherwise it uses the browser connection. The Vite development proxy points to port 7870 for the Python application.

Workflow templates and manifests are exported from the Python feature registry. After changing a workflow or the video nodes, run `.\.venv\Scripts\python.exe -m marcostudio.browser_export` at the repo root, then rebuild the frontend. Tests check that the browser catalog matches the Python compilers. Rebuild `src/marcostudio/web` before publishing interface changes. The tests require no GPU. CI checks the frontend and installs the Python package on Windows, Linux, and macOS.

## License

Original application code is [MIT licensed](LICENSE). See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for adapted public workflows, bundled libraries and separately provisioned model sources.
