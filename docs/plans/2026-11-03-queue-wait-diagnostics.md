# Queue waiting diagnostics for issue #3

## Baseline and filed diagnosis

Baseline: origin/main ac085b7d2326b91821701b5f15bcdc8fd67a9eec.
`src/marcostudio/core/jobs.py:326-347` treats every nonterminal, non-preparing job as active;
`src/marcostudio/core/store.py:12` excludes needs_attention from TERMINAL. The filed diagnosis is
confirmed in an isolated temporary Store running the actual worker for one
iteration: uncertain prior job reconciled once, pending job remains preparing,
zero execute calls, error null, no waiting explanation. No real runtime contacted.
`src/marcostudio/api.py:204-206,239-241` returns undecorated store list/detail. CLI jobs list/show
prints API JSON (`src/marcostudio/cli.py:190-208`). `frontend/src/App.tsx:697-723` displays status
and error but no blocker explanation. The browser runtime separately rejects new
jobs when uncertain (`frontend/src/browser/jobs.ts:83`); do not conflate flows.

## Change and rationale

Preserve fail-closed admission and existing manual-resolution checks. Derive an
optional waiting diagnostic on Python API reads from one current jobs snapshot.
Use `waiting: {blockers: [{id, status, resolve_command?}], message}`. Commands
exist only for needs_attention blockers, using the parser form
`marcostudio jobs --server STUDIO_URL resolve ID --confirm-not-running`; explain
that STUDIO_URL must be replaced with the same server used for list/show. Never
execute commands or resolve the selected preparing job automatically.
For preparing jobs blocked by active jobs, include every blocker ID/status and
resolve guidance only for needs_attention blockers. Do not imply resolving one
blocker clears other active work. Present the reason on the selected studio job;
CLI receives it through existing JSON output. Decorate list, detail and new-job
responses consistently, including regeneration and idempotent POST via shared
enqueue. Derive the target and blockers from the same snapshot; preserve detail
404 by raising the existing KeyError when its ID is absent. Use a small pure helper, no new service/framework.

## Assumptions and verification

- Snapshot dictionaries are fresh decoded data (`src/marcostudio/core/store.py:71-81`); test
  decorator does not mutate supplied values or persisted bytes/timestamps.
- Blocking criterion must match the scheduler, not just needs_attention; tests
  cover healthy running, multiple blockers, terminal and preparing-only controls.
- Optional payload preserves old/browser responses (`frontend/src/api.ts:54-66`);
  test missing-field UI compatibility and no offered resolve for healthy work.
- Existing explicit resolution requires reconciliation and queue checks
  (`src/marcostudio/core/jobs.py:278-318`); retain zero submissions while uncertain, and prove
  waiting data disappears after blockers become terminal.
- CLI emits API JSON (`src/marcostudio/cli.py:20-21,190-208,263-270`); exercise list/show with the
  normal caller, not a formatting reimplementation.

## Order, rollout and rollback

1. Review this plan through compatibility, blast-radius, existing-code and
   sequencing lenses. Revise before implementation.
2. Add helper/API/UI with isolated fake-runtime tests. No DB migrations or real
   downloads. Roll back with a normal revert if checks fail.
3. Run Python and frontend suites, mutation/legitimate controls, and local UI
   against isolated state. Commit, push and open PR. Roll back via PR revert.
4. Merge only reviewed exact head with required CI and merge commit. Hosted
   landing pin/deployment remains a separate Luke-approved operation.

## Success measures

A queued preparing job identifies all blockers in the returned snapshot in API and studio;
CLI JSON exposes matching IDs/statuses and guarded command guidance. Clearing a
blocker removes its derived explanation. Scheduler submissions remain zero under
uncertainty. No persisted status/error/receipt/timestamp changes from reads.

## Questions, dependencies and limits

No user choice is required for the safe diagnostic alternative explicitly offered
in issue #3. Validate field shape and UI placement in review. Depends on existing
fake-runtime/API/frontend test harnesses and repository dependencies. Do not loosen
admission, auto-resolve/cancel/retry jobs, change FIFO order, migrate SQLite, touch
credentials/endpoints, or deploy hosted assets. FIFO-only waiting diagnostics are
outside this change. Show only a short count in the selected-job view with an expandable complete
blocker list outside the role=status live region. Link/select blockers by their
own IDs and reuse label(status); never reuse the selected preparing job's resolve
action. Preserve all blocker IDs. Scan once: O(N) derivation, O(P*B) serialized
output for N jobs, P preparing jobs and B blockers. Detail reads newly scan all
history; accept this bounded local-history cost rather than persist stale state.
Absence of diagnostics never promises immediate execution: scheduler admission
can wait for its next poll. No store lock or runtime query on API read.

## Review revisions and concrete test gates

All four lenses returned; revisions address their findings before code changes.
Cover submitting/queued/running/cancel_requested/needs_attention and unknown
nonterminal statuses using the scheduler predicate, mixed uncertain+healthy
blockers, no resolve command for healthy work, terminal/empty snapshots, and
preserved detail404. Test current-snapshot clearing without immediate-start
claims. Preserve the baseline worker reproduction as a real regression test with
nonzero reconciliation and zero execute calls. Exercise real CLI main list/show
with mocked HTTP and captured JSON; no new formatter. Use existing API tempStore
and frontend uncertain-resolution harnesses. Check regenerate/idempotent POST and
old/browser payload compatibility. Reverting a merged PR uses git revert -m 1;
rollback never attempts to repair or rewrite job states.

## Implementation verification

All four revised-plan lenses returned SOLID. Source/caller review found a blocker
created after initial history could lack a Review button. Corrected by fetching
its detail inside the existing guarded openJob path; the regression omits that
blocker from startup history and confirms navigation causes no POST. Re-review
returned CLEAR. Canonical source checks: Python179passed/16skipped, frontend125
passed, Ruff and frontend build pass. Platform-specific coverage remains for CI.
Isolated mutations removing diagnostics, giving healthy blockers resolution
commands, or weakening uncertainty admission fail8,7,1 checks respectively;
adding an unrelated terminal status remains green25checks. Playwright desktop
1280x800 and mobile390x844 fixtures verify compact/expanded details, unseen blocker
navigation, no horizontal overflow and zero mutation requests.

Consumer-registry lookup reports UNVERIFIED because marcostudio is not a
registered node; it is not evidence of no consumers. Known direct API consumers
(CLI and frontend/browser compatibility) are covered by caller tests. No remote
consumer inventory completeness is claimed. TestClient emits a dependency
deprecation warning tracked separately as ledger9302; tests pass without hiding it.

An additional actual-API/browser run used the built bundle, a temporary SQLite
Store seeded with validated job settings, fake readiness, disabled worker, and a
read-only fixture middleware. Desktop/mobile both displayed two real API-derived
blockers, reviewed the uncertain job, and left jobs unchanged with zero mutation
requests, page errors or horizontal overflow. No ComfyUI was contacted.
