# Relight MPS readiness — issue #2

## Baseline, evidence and diagnosis

Baseline origin/main ac085b7d2326b91821701b5f15bcdc8fd67a9eec. The isolated queue
branch b52538a41a453b4a9fb6490e1f04f691666aeb78 has identical readiness code.
Filed diagnosis: confirmed for metadata indifference, not for every Mac/Torch.
Production diagnose with real graph/node validation and tiny verified model
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
Missing/malformed/ambiguous selected-device metadata for Relight is a diagnostic
failure rather than silently treating it as a supported GPU. Explicit CPU/CUDA
metadata retains existing readiness; do not newly certify execution or memory.

Keep connection discovery semantics/address return unchanged. Extract a small
runtime-info probe used by readiness; existing address probe wraps it for
connection discovery. No global cached device data, extra requests or selected
endpoint changes. Report connected=true with device failure, not connection lost.
Use connected Comfy metadata, never browser OS or this Mac's Torch installation.
Display only bounded/sanitized version text; no arbitrary server fields/argv.

No download, model, loader, dtype, launch-flag, PyTorch-installation or helper API
changes. No automatic CPU fallback. Users retain explicit download consent;
diagnostic explains generation readiness and does not silently change runtime.

## Assumptions and tests

- Scope is current Relight modes/profile; test both modes and unrelated-feature
  controls. Do not infer FP8 requirement from arbitrary model filenames.
- Validate selected-device schema from Comfy source and observed stats. Define
  conservative handling for empty, invalid or multiple contradictory devices.
- Parse stable/version suffix/nightly/missing/malformed versions conservatively;
  distinct messages must not turn newer MPS Ready without profile validation.
- Shared table-driven parity cases cover Python/browser messages and status;
  complete otherwise-ready fixtures prove each guard changes Ready, not merely
  adds a warning behind unrelated missing-model failures.
- Exercise actual Python API/CLI and browser checkRequirements plus submit paths;
  known unsupported MPS must produce zero upload/prompt submissions. Existing
  endpoint generation/cancellation and integrity gates remain intact.
- Mutation: bypass compatibility and observe both real caller tests fail; valid
  CPU/CUDA and unrelated-tool operations remain green. No live inference needed.

## Sequence and rollback

1. Four-lens plan review, revise until cleared, before source changes.
2. Implement small pure checks, metadata propagation, parity and caller tests in
   isolated worktree. Verify no metadata writes/endpoints changes.
3. Run full Python/frontend/Ruff/build and isolated local UI; generate bundled
   web assets through canonical build. Independent source review and dogfood.
4. Push PR; merge exact reviewed head via merge commit after CI (native Windows
   included). Rebase on newly merged queue PR before final tests if needed.
5. Hosted landing publication remains separately Luke-approved. Rollback is a
   normal source revert / git revert -m1 for merged PR; never alter user models.

## Success, dependencies, non-goals and trade-offs

Otherwise-ready MPS Relight gets a visible non-Ready explanation on Python and
browser paths and cannot submit. Newer Torch is described accurately without
claiming a validated Mac graph. CPU/CUDA existing controls and other tools retain
behavior; malformed metadata is visible. No user files or runtime settings change.
Depends on existing Comfy metadata and test harnesses. A supported Mac model
profile, GGUF nodes, memory capacity measurement and real full-graph validation
remain separate work. The temporary gate can reject an unvalidated installation
that might succeed; this is explicit until evidence supports a specific Mac
profile, avoiding unsafe inference attempts on the reported36GB system.
