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
| [#9](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/9) | Readiness reads `/experiment/models/{folder}` sizes for present models. A size that differs from the catalog marks the model incomplete, not ready. Any read failure keeps the current name-only behaviour. |
| [#8](https://github.com/NeoMarcoPolo/mp-marcostudio-qa/issues/8) | Not changed. Manager can install nodes only from the Comfy registry or a git URL. Both need a publishing decision by the repo owner. |

## Assumptions and how they are checked

| Assumption | Check | Result |
| --- | --- | --- |
| `/experiment/models/{folder}` returns `size` | ComfyUI `app/model_manager.py`, upstream commit `3dfefc88d` (PR #8792), first tag `v0.3.49` | confirmed by source |
| Its listing cache cannot return a stale size | `cache_model_file_list_` compares a float with a dict, so the cache never hits | confirmed by source; a future upstream fix could make sizes stale (code comment added) |
| Catalog `size` is exact bytes | `qwen_image_edit_2509_fp8_e4m3fn.safetensors`: catalog 20430698424, Hugging Face tree API 20430698424 | confirmed |
| Endpoint is reachable cross-origin | live ComfyUI with `--enable-cors-header`, request with `Origin` | checked in the zero-byte probe below |
| Permission names accepted by `navigator.permissions.query` | headless Chrome probe | checked before merge; each name is wrapped in try/catch |
| Filed diagnosis for #9 (name-only readiness) | `requirements.ts:172-195` at `aa482d4` | confirmed |

## Rollout and rollback

Frontend only, plus the rebuilt bundle in `src/marcostudio/web`. Each commit is
independent; `git revert <sha>` removes one fix.

## Success measures

- `npm test -- --run`, `npm run build`, `uv run pytest -q` pass, and
  `git diff --exit-code -- src/marcostudio/web` is clean after each commit.
- #9 red/green pair on a live ComfyUI: zero-byte files block readiness, files
  truncated to the exact catalog size do not.

## Open questions

- #7: does MarcoStudio support phones? Owner decision.
- #8: publish the nodes to the Comfy registry, or a separate git repo? Owner decision.

## Non-goals

- No change to checksum verification or commit `6f0e043`.
- The real browser permission prompt and a real phone stay untested.
