# Relight MPS readiness — issue #2

## Baseline, evidence and diagnosis

Implementation baseline after queue PR9 merge: origin/main 5a14091063efa2e1bf4bedb59e23df9b63414baa. The clean plan branch was rebased before implementation. The isolated queue
branch b52538a41a453b4a9fb6490e1f04f691666aeb78 has identical readiness code.
Filed diagnosis: confirmed for metadata indifference, not for every Mac/Torch.
The production diagnose caller with real graph/node validation and tiny verified model
identities returns all-pass Ready for CPU/Torch2.13, MPS/2.13 and MPS/2.15; preserve
this as a regression fixture. Root's installed Torch2.13.0 on M4 Max reports MPS
available but a one-element FP32 -> float8_e4m3fn cast fails Undefined type
Float8_e4m3fn. No model/inference was run. Current isolated Comfy8194 reports CPU
and Torch2.13; do not describe that as an MPS Comfy execution.

Authoritative paths: src/marcostudio/comfy/doctor.py:120-126 retains system_stats
without device assessment; final Ready at273-280 checks only failure records.
frontend/src/browser/connection.ts:47-51 validates then discards metadata;
browser/requirements.ts:86 invokes probe, final Ready at193 ignores device.
Both execution paths already call their readiness gate before submission:
core/jobs.py:43-46 and browser/jobs.ts:92-94,111-115. Relight manifest.py:13-30
pins FP8 models; workflow.py:24 keeps weight_dtype=default. Comfy0.43's observed
system_stats uses devices[].type and system.pytorch_version; local QA server.py
795-824 emits these fields. Other tools must retain existing behavior.

Primary upstream evidence: https://github.com/pytorch/pytorch/releases/tag/v2.15.0
reports new MPS float8_e4m3fn support. Do not claim MPS permanently lacks FP8 or
that upgrading Torch alone validates this complete LoRA graph or memory fit.
Issue2 explicitly allows temporary non-Ready diagnostics until a Mac profile is
validated, as an alternative to implementing GGUF support now.

## Proposed behavior

Add a narrowly scoped Relight compatibility check in Python and browser
readiness. Fail closed for this pinned FP8/LoRA profile on MPS. Distinguish known
older-runtime failure guidance from newer FP8-capable-but-unvalidated profile
messages. Version alone never certifies full Relight execution or memory safety.
This is a temporary profile restriction, not a platform ban across other tools.
Missing/malformed selected-device metadata for Relight is a diagnostic
failure rather than silently treating it as a supported GPU. Explicit CPU/CUDA
metadata retains existing readiness; do not newly certify execution or memory.

Keep connection discovery semantics/address return unchanged. Extract a small
runtime-info probe used by readiness; existing address probe wraps it for
connection discovery. No global cached device data, extra requests or selected
endpoint changes. Report connected=true with device failure, not connection lost.
Use connected Comfy metadata, never browser OS or this Mac's Torch installation.
Recognizable browser responses retain the existing system-version/devices-array
identity check; malformed primary records inside that array get a compatibility
failure while connected remains true. Display only bounded/sanitized version text; no arbitrary server fields/argv.

No download, model, loader, dtype, launch-flag, PyTorch-installation or helper API
changes. No automatic CPU fallback. Users retain explicit download consent;
diagnostic explains generation readiness and does not silently change runtime.

## Assumptions and tests

- Pin policy to qwen2509-relight-flash-v1 from manifest WORKFLOW_VERSION and
  CatalogFeature.version. Relight exposes flash only: test flash and unchanged
  rejection of standard, plus unrelated-feature controls. No filename inference
  or new model abstraction. Future changed MPS profile fails explicitly as
  unvalidated until policy review; preserve CPU/CUDA behavior.
- Official Comfy-Org/ComfyUI v0.43.0 server.py:776,785-800 puts primary
  get_torch_device() first, then other visible devices. Use ONLY devices[0].type.
  Empty/malformed/unknown primary fails; extras do not override a valid primary.
  Test CPU-first/MPS-second, CUDA-first/MPS-second, MPS-first/CUDA-second. This
  supersedes older singleton-only source assumptions.
- Parse stable/version suffix/nightly/missing/malformed versions conservatively;
  distinct messages must not turn newer MPS Ready without profile validation.
- Shared JSON parity table: tests/fixtures/relight_device.json, consumed by
  Python and Vitest pure-check tests. Keep tiny checks in their separate runtimes,
  without a policy framework. Preserve probe address/timeout/abort/discovery and
  request count. Extract one stats probe; no extra request or metadata cache.
- Show device:relight failures in main Onboarding BEFORE download consent, both
  otherwise-ready and missing-model cases. Extend narrow failure filters so the
  reason stays visible. Explicit downloads may remain possible after warning;
  preserve checkbox/selection/space consent semantics.
- Shared table-driven parity cases cover Python/browser messages and status;
  complete otherwise-ready fixtures prove each guard changes Ready, not merely
  adds a warning behind unrelated missing-model failures.
- Exercise actual Python API/CLI and browser checkRequirements plus submit paths;
  known unsupported MPS must produce zero UPSTREAM upload/prompt submissions.
  Local API admission can remain accepted then fail visibly in worker. Test
  regeneration and preserve existing-job polling/cancellation under red readiness. Existing
  endpoint generation/cancellation and integrity gates remain intact.
- Mutation: bypass compatibility and observe both real caller tests fail; valid
  CPU/CUDA and unrelated-tool operations remain green. No live inference needed.

## Sequence and rollback

1. Four-lens plan review, revise until cleared, before source changes. Rebase on
   queue PR9 and rerun baseline fixture BEFORE step2.
2. Implement small pure checks, metadata propagation, parity and caller tests in
   isolated worktree. Verify no metadata writes/endpoints changes.
3. Run full Python/frontend/Ruff/build and isolated local UI; generate bundled
   web assets through canonical build. Independent source review and dogfood.
4. Push PR; merge exact reviewed head via merge commit after CI (native Windows
   included), under the user's existing explicit push/merge authority.
5. Hosted landing publication remains separately Luke-approved. Rollback is a
   normal source revert / git revert -m1 for merged PR; regenerate web assets.
   Never alter user models.

## Success, dependencies, non-goals and trade-offs

Otherwise-ready MPS Relight gets a visible non-Ready explanation on Python and
browser paths and makes zero upstream submissions; local admission remains unchanged. Newer Torch is described accurately without
claiming a validated Mac graph. CPU/CUDA existing controls and other tools retain
behavior; malformed metadata is visible. No user files or runtime settings change.
Depends on existing Comfy metadata and test harnesses. A supported Mac model
profile, GGUF nodes, memory capacity measurement and real full-graph validation
remain separate work. The temporary gate can reject an unvalidated installation
that might succeed; this is explicit until evidence supports a specific Mac
profile, avoiding unsafe inference attempts on the reported36GB system.

## Verification receipt

All four revised-plan lenses returned SOLID. Source/caller review returned CLEAR.
Full source checks: Python220passed/16platform-skipped, frontend167passed,
Ruff and canonical web build passed. Existing TestClient warning remains visible
and separately tracked. Shared parity cases include complete malformed versions,
nightlies/RC/local versions, unknown metadata/profile and primary-device ordering.
Otherwise-ready production caller fixtures substitute tiny real verified model
identities; this is not evidence of real model inference. Actual Python worker,
CLI/API doctor and Python regeneration fail the current MPS profile before any
upstream transport operation. Browser generation makes no additional upload or
prompt calls; a separately requested earlier source upload remains independent.
CPU/CUDA fixture controls generate, poll and cancel; unrelated-tool checks retain
behavior. Existing browser Regenerate routing is separately tracked (ledger9305),
not counted as device-guard coverage.

Isolated mutation controls: removing Python guard fails6 real caller checks;
removing browser guard fails the actual generation test with an upstream prompt;
hiding the warning fails2 visible-onboarding cases. A legitimate additional
secondary-device entry retains11 Python and22 browser caller tests green.
Actual Chromium desktop/mobile UI with read-only fake Comfy responses displayed
older/newer MPS guidance and warning before download consent; no mutation requests
or page errors. Explicit CPU metadata with otherwise identical present-model
fixtures exposes Open studio; this is only a metadata/readiness control.
No PyTorch upgrade, model download, inference, runtime switch or phone operation
was performed for the fix. A validated memory-bounded Mac profile remains future
work; do not claim Apple Silicon image generation is fixed by this mitigation.
