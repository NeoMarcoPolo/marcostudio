# Model download consent and readiness

## Baseline and diagnosis

The current onboarding submits all eligible models at once (`frontend/src/Onboarding.tsx:32-34,115-120,146-148`) and places names and sizes inside a disclosure (`frontend/src/Onboarding.tsx:152-158`). Model availability is inferred from loader filenames (`frontend/src/browser/requirements.ts:83-90`); local task history separately blocks unresolved downloads (`frontend/src/browser/requirements.ts:118-135`). Live test on 2026-10-30 confirmed the isolated ComfyUI instance exposes the filename of a model while it is still downloading. Filed diagnosis: confirmed for the loader listing; whether another session incorrectly reaches Ready still needs a controlled reproduction.

## Change and verification

Show each missing model and size, allow selecting eligible models individually or all, display the selected total, and require an unchecked confirmation specific to that selection before starting. Invalidate confirmation on selection or connection changes. Preserve queue deduplication and readiness requirements. Explain disk needs without claiming a free-space measurement unless an actual supported ComfyUI API is verified. Investigate queue and file-integrity evidence across sessions, and fail closed where the API can support it. Report download errors and recovery in plain language. Verify each assumption against installed Manager API and current code, test selection, consent, changed selection, partial downloads and error paths, and run the project's applicable checks plus live browser checks.

Reuse `startDownloads(models)` and show queued or manual-only models with their reason and manual/source links. Bind consent to the precise eligible URL set and endpoint, including eligibility changes during polling; reject empty selection. Exercise partial selection, select-all, a changed queue, mobile keyboard access, and duplicate submissions. The installed Manager's global queue can only provide aggregate counts: an active queue can conservatively block readiness across browser sessions, but this may also block unrelated operations. Its absence is not evidence of an idle queue. Test the supported Manager version and an unavailable-queue case. An idle queue and filename alone cannot prove a previously interrupted file is intact; document this residual limitation rather than claim comprehensive integrity validation. The installed Manager returns generic installation errors, so mention insufficient space only as a possible cause, not a diagnosis.

Check the consent snapshot at submission as well as invalidating it on changes. Treat a known active queue as a conservative readiness block, including unrelated tasks; distinguish a genuinely unsupported Manager from a transient failure and disclose uncertainty instead of claiming integrity. Do not interrupt or resubmit the existing live test queue. Use isolated fixtures for a second-browser active-download case and an interrupted-file case; verify README and desktop/mobile behavior. Do not claim an unsupported progress or resume guarantee. The proposed optional sample verification requires a separate product decision on the sample and must not silently run generation; investigate the available artifact before implementation.

## Rollout, measures and rollback

Implement in an isolated worktree, validate locally before any publication, and retain the existing hosted instance for comparison. Success means explicit consent precedes every newly submitted selected download, unselected items are not submitted, incomplete items cannot produce a demonstrated false Ready in tested conditions, and errors offer actionable recovery. Roll back by reverting the isolated commit; no deployment is authorized by this plan.

## Assumptions and open questions

Confirm Manager's queue/history scope and whether it reports disk capacity, progress, or partial-file integrity. Confirm whether task status can be correlated across browser clients. If evidence is unavailable, report the limitation rather than asserting readiness or free space. Confirm current remote and hosted build identity before claiming the deployed site is fixed.

## Dependencies and non-goals

Depends on the existing ComfyUI Manager interface and browser-accessible server. No workflow generation, changes to the existing production ComfyUI installation, deployment, or automatic cleanup of user files. Partial selection may intentionally leave the tool not ready until all requirements are installed.
