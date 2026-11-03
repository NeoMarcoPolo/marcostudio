# Queue waiting diagnostics for issue #3

## Baseline and filed diagnosis

Baseline: origin/main ac085b7d2326b91821701b5f15bcdc8fd67a9eec.
`core/jobs.py:326-347` treats every nonterminal, non-preparing job as active;
`core/store.py:12` excludes needs_attention from TERMINAL. The filed diagnosis is
confirmed in an isolated temporary Store running the actual worker for one
iteration: uncertain prior job reconciled once, pending job remains preparing,
zero execute calls, error null, no waiting explanation. No real runtime contacted.
`api.py:204-206,239-241` returns undecorated store list/detail. CLI jobs list/show
prints API JSON (`cli.py:190-208`). `frontend/src/App.tsx:697-723` displays status
and error but no blocker explanation. The browser runtime separately rejects new
jobs when uncertain (`frontend/src/browser/jobs.ts:83`); do not conflate flows.

## Change and rationale

Preserve fail-closed admission and existing manual-resolution checks. Derive an
optional waiting diagnostic on Python API reads from one current jobs snapshot.
For preparing jobs blocked by active jobs, include every blocker ID/status and
resolve guidance only for needs_attention blockers. Do not imply resolving one
blocker clears other active work. Present the reason on the selected studio job;
CLI receives it through existing JSON output. Decorate list, detail and new-job
responses consistently. Use a small pure helper, no new service/framework.

## Assumptions and verification

- Snapshot dictionaries are fresh decoded data (`core/store.py:71-81`); test
  decorator does not mutate supplied values or persisted bytes/timestamps.
- Blocking criterion must match the scheduler, not just needs_attention; tests
  cover healthy running, multiple blockers, terminal and preparing-only controls.
- Optional payload preserves old/browser responses (`frontend/src/api.ts:54-66`);
  test missing-field UI compatibility and no offered resolve for healthy work.
- Existing explicit resolution requires reconciliation and queue checks
  (`core/jobs.py:278-318`); retain zero submissions while uncertain, and prove
  waiting data disappears after blockers become terminal.
- CLI emits API JSON (`cli.py:20-21,190-208,263-270`); exercise list/show with the
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

A queued preparing job identifies all actual active blockers in API and studio;
CLI JSON exposes matching IDs/statuses and guarded command guidance. Clearing a
blocker removes its derived explanation. Scheduler submissions remain zero under
uncertainty. No persisted status/error/receipt/timestamp changes from reads.

## Questions, dependencies and limits

No user choice is required for the safe diagnostic alternative explicitly offered
in issue #3. Validate field shape and UI placement in review. Depends on existing
fake-runtime/API/frontend test harnesses and repository dependencies. Do not loosen
admission, auto-resolve/cancel/retry jobs, change FIFO order, migrate SQLite, touch
credentials/endpoints, or deploy hosted assets. FIFO-only waiting diagnostics are
outside this change. Long blocker lists may require compact rendering; preserve
all IDs in API data and offer details in UI rather than silently truncating.
