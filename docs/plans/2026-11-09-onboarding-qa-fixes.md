# Onboarding QA fixes (mp-marcostudio-qa #4–#9)

Fixes the onboarding gaps filed from the 2026-10-28 walk against `69460ec`,
rechecked against `aa482d4`. One commit per issue. Ledger: senzhang-todo TODO-9297.

## What changes and why

| QA issue | Change |
| --- | --- |
| [#5](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/5) | Address fields use `type="text"` + `inputMode="url"`, so the browser no longer rejects `127.0.0.1:8192` before `normalizeAddress` adds `http://`. The local settings dialog adds the scheme before it saves, because the Python validator requires one. |
| [#4](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/4) | `discover` throws a typed `ConnectionFailure` with a `reason` and the addresses tried. On failure only, it reads the local-network permission state and sends one `no-cors` probe. `ConnectionHelp` shows the permission fix, the CORS fix, or "start ComfyUI", in that order of evidence. With no positive evidence, it keeps the generic text. |
| [#6](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/6) | The Connect step links to `https://comfy.org/download`. When nothing answers, the help lists the addresses tried and shows the address field inline. |
| [#7](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/7) | The address view and README explain `--listen` and the computer's network address. Phone use stays marked as unverified. |
| [#9](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/9) | When the Manager queue is idle or absent, readiness reads `/experiment/models/{folder}` sizes for present models. A smaller file is shown as incomplete, a larger one as a size mismatch; either is not ready. Any read failure keeps the current name-only behaviour. |
| [#8](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/8) | Not changed. Manager can install nodes only from the Comfy registry or a git URL. Both need a publishing decision by the repo owner. |

## Assumptions and how they were checked

| Assumption | Check | Result |
| --- | --- | --- |
| `/experiment/models/{folder}` returns `size` | ComfyUI `app/model_manager.py` at upstream `v0.43.0` and `master` (read with `gh api`, 2026-11-09); added in `3dfefc88d` (PR #8792), first tag `v0.3.49` | confirmed by source |
| Its listing cache cannot return a stale size | `cache_model_file_list_` compares `getmtime(folder)` (a float) with `model_file_list_cache[1]` (a dict), so it never hits; same code at `v0.43.0` and `master`. Live: a file grown in place from 0 to 4096 bytes was listed at 4096 on the next read | confirmed; a code comment notes the risk if upstream fixes the cache. The size check also runs only when the Manager queue is idle or absent |
| Catalog `size` is exact bytes | `qwen_image_edit_2509_fp8_e4m3fn.safetensors`: catalog 20430698424, Hugging Face tree API 20430698424 | confirmed |
| The listing is readable cross-origin | live ComfyUI started with `--enable-cors-header http://127.0.0.1:5173`; `GET /experiment/models/vae` with that `Origin` returned 200 and `Access-Control-Allow-Origin` | confirmed |
| Permission names accepted by `navigator.permissions.query` | headless Chrome 156.0.8078.80: `local-network-access`, `local-network`, `loopback-network` return a state; `private-network-access` and a made-up name throw `TypeError` | confirmed; each query is wrapped in try/catch |
| Filed diagnosis for #9 (name-only readiness) | `requirements.ts:172-195` at `aa482d4` | confirmed |
| The Python local-server mode has the same gap | `src/marcostudio/comfy/doctor.py` already verifies size and header from disk | no; #9 affects the hosted browser path only |

## Measured results

- #9 red/green on a live ComfyUI (local `ComfyUI-fork`, version 0.11.1, `--cpu`, temporary `--base-directory`), running the real `checkRequirements` from Node: five zero-byte Relight files gave five `size:` failures and not ready; the same files truncated to their exact catalog sizes (sparse, 0 B on disk) gave ready, with the existing `integrity-unchecked` warning.
- #4 CORS case in headless Chrome against the dev server: ComfyUI on 8192 without `--enable-cors-header` gave "Something is running at http://127.0.0.1:8192" and the startup-option picker.
- #4/#6 unreachable case: with nothing on 8188 or 8000, the help listed both addresses, the installer link and the inline address field.
- Not tested: the permission-denied case (unit tests only; a local dev page shares the loopback address space), the real browser permission prompt, and a real phone.

## Rollout and rollback

Frontend only, plus the rebuilt bundle in `src/marcostudio/web`. Each commit
renames the hashed bundle files, so `git revert` of a middle commit conflicts
in `src/marcostudio/web`. To roll back one fix, revert its source change, then
rebuild the bundle with `npm run build` and commit the result.

## Success measures

- `npm test -- --run`, `npm run build`, `uv run pytest -q` pass, and
  `git diff --exit-code -- src/marcostudio/web` is clean after a rebuild.
- A local build of unchanged `origin/main` reproduced the committed bundle
  byte for byte (Node v26.9.0), so local bundles match CI.

## Open questions

- #7: does MarcoStudio support phones? Owner decision.
- #8: publish the nodes to the Comfy registry, or a separate git repo? Owner decision.

## Non-goals

- No change to checksum verification or commit `6f0e043`.
- The real browser permission prompt and a real phone stay untested.
