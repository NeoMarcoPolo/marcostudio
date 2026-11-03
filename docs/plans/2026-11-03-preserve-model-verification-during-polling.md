# Preserve model verification during capability polling

Status: Both review rounds received four SOLID verdicts. Implemented and validated locally on 2026-11-03; source PR and deployment remain pending.

## Change and reason

Separate invalidation of permission to use unverified models from invalidation of an authenticated verification context. Busy helper observations must revoke bypass permission and report active work, while allowing an already-running checksum request to finish. Endpoint changes, pairing changes, helper-instance changes, explicit cancellation, unknown capabilities, and failed checks must retain their conservative behavior.

## Grounded baseline and assumptions

| Claim / assumption | Evidence and verification |
| --- | --- |
| Filed diagnosis: confirmed on hosted revision `fd3a658`; implementation baseline is `3bcdd820`. A background poll cancels its own active verification. | `frontend/src/Onboarding.tsx:203-208` polls every 7000 ms. `frontend/src/browser/integrity.ts:170` calls `clearUnverified()` when busy; line 63 increments the generation that lines 98-103 snapshot/check; verification checks it at lines 197-220. |
| This occurs in a genuine hosted run, not only a mock. | On 2026-11-03, fresh isolated Chromium145/macOS at `https://neomarcopolo.co/marcostudio/` served the `fd3a658` export and connected to isolated ComfyUI0.43.0/Manager4.2.2 at loopback8194. `git cat-file -t fd3a658` confirms the object exists; `git diff fd3a658 3bcdd820 -- frontend/src/browser/integrity.ts frontend/src/Onboarding.tsx` is empty, so these source paths are byte-identical across hosted and implementation baselines. Sanitized trace: running at436ms through6455ms, capability busy at7275ms, cancel response7458ms; dialog then said `Verification cancelled.` No generation or download was submitted. |
| Real files and helper can verify independently of the UI. | All five installed Relight files returned `checksum_matched` HTTP200 through paired loopback helper calls, using trusted catalog digests; the same files passed offline production `verify_file`. The diffusion file is20430698424 bytes and its local HTTP check took13.679s, exceeding the current poll period. These are verification observations, not a guarantee against later file changes. |
| Bypass consent must still become stale during helper activity. | `integrity.ts:180-190` snapshots/rechecks `consentGeneration` around asynchronous permission checks. Preserve this behavior with a deferred-request race test. |
| Existing tests lack the active-verification plus background-busy interaction. | `frontend/src/browser/integrity.test.ts` tests normal verification, busy fallback refusal, failure persistence, pairing changes, helper-instance changes, and delayed old-endpoint responses; add behavior tests through the exported production functions. |
| Manager setup activity is a separate full-invalidation boundary. | `frontend/src/browser/requirements.ts:143-148` observes the Manager queue and calls `clearUnverified()` for `active` or `unknown`; retain it unchanged. |
| Late abort during an already pending status completion needs a direct regression. | `integrity.ts:218` checks `signal.aborted` before the status await; lines 219-224 check context but not `signal.aborted` after awaiting the result. Reproduce before deciding whether a narrow additional abort check is required. |
| No new API or library option is required. | Changes stay in `integrity.ts`, its tests, and the checked-in generated frontend bundle. `frontend/package.json` supplies Vitest, typecheck, and build commands. |

## Proposed implementation

1. Keep `consentGeneration` specifically for permission to continue without verification; add a separate verification/context generation for authenticated operations.
2. Add one local function that clears `allowed` and advances consent generation. `clearUnverified()` invokes it, clears observed instance, and advances context generation, preserving its existing full-invalidation callers.
3. Only a validated same-instance helper-busy capability invokes consent-only invalidation. Changed-instance, invalid, missing, failed, or otherwise unknown capability observations retain full invalidation; Manager queue `active`/`unknown` also retains full invalidation. It still returns `active`; it must not create consent, mark files matched, or admit new work.
4. Context capture/current checks compare endpoint, connection generation, pairing object, and context generation. `allowUnverified` retains its consent-generation comparisons, so an older idle observation cannot restore bypass after intervening activity.
5. Preserve explicit AbortSignal cancellation, helper failure persistence, server queue witnesses, hashing, storage pairing, and catalog validation. Add a narrow post-status-await abort check only if the deferred-completion regression reproduces publication after abort. Retain every existing full `clearUnverified()` caller other than the precise validated same-instance helper-busy path.

## Verification and success metrics

- Add a regression through `verifyModelSnapshots` with a genuinely deferred running status. Call exported `integrityBusy` with a valid same-instance busy response while it is pending, then return a real-shaped checksum-matched result. The baseline must reject; the candidate must finish and expose a verified snapshot. Use unique test identities and clean up deferred work.
- Add a deferred `allowUnverified` race: initial idle observation, another poll observes busy, then delayed clean failure/status lookup completes. Consent must remain absent and the pending bypass request must reject.
- Cover explicit abort during deferred status completion, unpair/re-pair, endpoint A→B→A, changed helper instance, unavailable/malformed capabilities, Manager queue active/unknown, and checksum mismatch during a deferred verification. Assert that `verifiedSnapshots` does not publish the result and `allowsUnverified` remains false, in addition to expected promise rejection; inspect actual cancellation requests where applicable. A rejection alone does not prove that the job was not subsequently published. Use a fake that deliberately resolves the pending status after abort so the assertion exercises the late-completion hazard.
- Run targeted integrity tests, full frontend suite, typecheck, frontend build, and applicable Python helper tests. Confirm executed counts and record failures. Do not change Python verifier behavior.
- Mutation control: restore the old busy full-invalidation behavior and observe the new legitimate-verification test fail; restore candidate and observe green. Keep existing failure-path tests green.
- Use the next applicable operation to run the candidate UI against the same isolated real-model backend. Run verification long enough to cross at least one observed capability poll, confirm `Open studio` is enabled after checksums match, and retain a sanitized state trace and screenshot. Also verify bypass remains blocked without consent and revoked after busy activity.
- After separate deployment approval, repeat the exact hosted-origin test against the deployed asset identity. Local preview success does not prove hosted shipment.

## Rollout order and rollback

1. Review this plan through four independent lenses before code changes. Revise any unresolved findings.
2. Implement/tests in this existing isolated worktree, which was clean and fast-forwarded to `origin/main` before the plan. Commit exact owned files; regenerate the frontend bundle using the repository build/export flow.
3. Validate locally and on the isolated backend; push source PR. Rollback before merge is a revert of this single fix commit; no data migration or model writes occur.
4. Merge with a merge commit only after exact-head checks/review pass. Pending landing pin PR #160 currently targets source `3bcdd820`; it must advance to the eventual merged, tested fix revision and update its exact-revision evidence before publication. Update the landing-site pin through its own reviewed PR; production deployment continues to require the repository's explicit production approval. Rollback deployed behavior by restoring the previous pin/bundle through the same review/deployment path.

## Review record and open questions

Round 1: all four lenses returned SOLID. This in-place revision records sequencing/served-identity, blast-radius/publication assertions, deferred-abort, consent-race, and full-clear preservation refinements. Parent coordinates four round 2 reviews before implementation. Keep the before/after SHA-256 receipt and review delta; do not fork a second canonical plan.


- Do the four reviewers find any caller that relies on ordinary busy observations invalidating authenticated lookup context, beyond the intended bypass revocation? Audit every `clearUnverified`, `captureContext` and `consentGeneration` consumer.
- Can a helper-instance replacement race between capability and status publish an old result after this split? Preserve full context invalidation and exercise deferred instance-change coverage before accepting the change.

## Dependencies, non-goals and trade-offs

Dependencies: existing isolated loopback backend with current helper, trusted Relight files, Manager4.2.2 queue witness, and user-approved credential entry into the exact hosted origin. Credential stays in process/page memory and is never logged. Four-lens review and deployment permissions remain external gates.

Non-goals: no download, generation, new backend endpoint, model catalog change, verifier relaxation, new framework, Windows behavior claim, or polling-interval adjustment. The extra generation counter is a small state distinction justified by two different invalidation lifetimes; favor this direct split over an event/state-machine abstraction.


## Implementation and verification outcomes (2026-11-03)

The implemented path retains all full-invalidation callers, including Manager queue active/unknown. A same-instance helper busy observation now revokes bypass consent without invalidating authenticated verification context. Verification admission first establishes an idle, supported helper observation while checking the original context before and after that await; a test that manually seeded this observation hid the genuine first-poll path, so that seed was removed.

Tracked jobs carry their original context and pending AbortSignal. Snapshot publication checks those original boundaries before accepting a late matched response, even while the original verification promise is still deferred. Failed/cancelled verification keeps active work visible but prevents its result from being published. The verifier itself rechecks cancellation after awaited status. Once that verifier has actually accepted a matched response, it detaches the completed operation's signal, so ordinary modal cleanup does not revoke an already accepted snapshot.

Measured receipts:

| Check | Observed result |
| --- | --- |
| Baseline regression with deferred status | 23 executed: 8 failed, 15 passed. Busy polling cancelled legitimate verification; late abort completed; invalidated jobs could later re-publish matched responses. |
| Pre-completion invalidation assertions before releasing the original status | 7 failures demonstrated publication during abort, re-pair, A-B-A, helper replacement, malformed capability, and Manager active/unknown. |
| Unseeded direct caller admission | Same-instance busy regression failed until real idle/supported preflight was added. Deferred preflight pair/endpoint changes now reject without an install/hash POST. |
| Accepted completion followed by modal cleanup abort | New legitimate-change control initially failed. Detaching the signal only after accepted completion restored it while keeping pending-abort controls green. |
| Final targeted integrity suite | 29 passed, 0 skipped. |
| Final frontend suite | 14 files / 123 tests passed, 0 skipped. Node emitted its existing `--localstorage-file` path warning; this was not suppressed. An earlier full run overlapped a controlled mutant and caught that mutant; its result was discarded and the full suite rerun after restoration. |
| Typecheck and frontend production build | Passed; current candidate generated index is `index-BR0ljNeD.js`. |
| Existing Python integrity/pairing regressions | 13 passed, 0 skipped across integrity service/routes/check and storage pairing. Python verifier code unchanged. |
| Actual local-candidate UI against isolated ComfyUI0.43.0 / Manager4.2.2 | All five existing real Relight model checks completed; busy capability polls were observed during the diffusion-model checksum. `Relight is ready` and enabled `Open studio` appeared. After clicking `Open studio`, opening Settings performed a fresh requirements check and still showed `Relight is ready`. No download or generation was initiated. |

The real UI receipt uses locally built candidate static assets intercepted only under the exact approved hosted origin, with actual loopback helper/model responses; it does not establish deployment. The isolated browser profile holds the pairing credential only in process/page memory and is closed after checking. The server remains separately isolated; original ComfyUI source/model files were not changed.

Guard-validity table (each mutation is applied to an isolated source copy, run through the normal npm caller, then restored before the next row; do not run the full suite concurrently with source mutation):

| Deliberate mutation | Caller / test pattern | Observed |
| --- | --- | --- |
| Restore old busy full-context invalidation | `npm test -- --run src/browser/integrity.test.ts -t 'same-instance busy poll'` | RED |
| Remove post-status-await abort check | `npm test -- --run src/browser/integrity.test.ts -t 'after an explicit abort'` | RED |
| Remove originating job-context publication guard | `npm test -- --run src/browser/integrity.test.ts -t 'after unpair and re-pair'` | RED |
| Remove pending job AbortSignal publication guard | `npm test -- --run src/browser/integrity.test.ts -t 'after an explicit abort'` | RED |
| Remove accepted-completion signal detach | `npm test -- --run src/browser/integrity.test.ts -t 'successful modal cleanup'` | RED |
| Stop revoking bypass consent on valid busy observations | `npm test -- --run src/browser/integrity.test.ts -t 'deferred bypass consent'` | RED |
| Restore candidate after all mutations | `npm test -- --run src/browser/integrity.test.ts` | GREEN: 29 executed |

Remaining gates: independent implementation review of stable final source, exact-head source PR checks, merge, updated landing pin PR #160 and exact-revision evidence, explicit production deployment approval, and a fresh deployed-hosted readiness check. The source plan's remote reach must be checked after its authorized push; staged or local committed state alone is not delivery.
