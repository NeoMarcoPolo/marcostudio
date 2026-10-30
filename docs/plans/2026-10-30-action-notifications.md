# Action notifications

## Baseline and objective

The setup dialog selects a discovered connection in `frontend/src/Onboarding.tsx:169-175`, reconciles download tasks while open in `frontend/src/Onboarding.tsx:144-160`, and persists task observation timestamps in `frontend/src/browser/manager.ts:47-84`. The application retains an error banner in `frontend/src/App.tsx:522-539` and polls jobs in `frontend/src/App.tsx:251-270`. Add nonblocking in-app notifications for confirmed connection, completed/failed model downloads, and observed terminal generation failures. Keep durable errors and setup state available after transient notifications disappear.

## Assumptions to verify

Verify the native dialog top layer does not hide notifications, task reconciliation happens before notifications are derived, and job updates can be distinguished from the initial history load. Verify timestamps represent time from submission to observation, not exact transfer time. Determine behavior when the modal closes, the browser refreshes, or a task changes while a different tool is selected. A saved terminal task alone must not be announced as a new event.

## Rollout and rollback

Implement in the isolated feature worktree, verify in a local browser against the isolated test server and with focused interaction and lifecycle tests, then run the full frontend gate and CI on the updated PR. No deployment is implied. Revert the notification commit if necessary; no server migration is required.

## Success measures

Each observed transition produces at most one relevant notice; the connection notice identifies the verified server; a completion names the model; a failure names the task and reports elapsed time only when known, labeled as observation time. Notifications are legible with the modal open and in the main app, dismissible, keyboard accessible, and do not obscure progress. Verify active-to-terminal, polling, reload, modal close/reopen, old history, and unknown timestamp cases.

## Open questions and dependencies

Browser notifications depend on the tab being open; no OS permission or background push is requested. Manager's existing task history and job polling determine what can be observed. If background download monitoring cannot be added without risky duplicate requests, preserve truthful on-return reporting and disclose that limitation rather than inventing events.

Use one application-owned notification queue and one live region in the active layer: inside the native dialog while it is open and in the app otherwise. Switching layers must not repeat announcements. Do not move focus. Use polite success notices and persistent, dismissible failures with an assertive announcement; bound the visible queue and preserve failures rather than silently discarding them. Respect reduced motion. Keep existing persistent error details.

Retain a previous-by-endpoint-and-task-ID snapshot across the entire refresh/reconcile operation, since `refresh()` can already persist transitions. Initialize historical terminal records without announcing them; initialize pending records so later observed completions are announced once. Poll downloads from one owner while the app tab is open, coordinating the dialog's existing polling; never claim OS-background or cross-tab delivery. Use job-ID active-to-failed transitions from existing polling, not initial history or `needs_attention`. Display `elapsed_seconds` only if valid; when calculating from stored timestamps say `observed after`, and omit unknown durations. Keep connection notices tied to a confirmed endpoint and avoid repeat notices from automatic focus reconnects.

Tests cover multiple simultaneous completions, bounded overflow, failures and unknown status, endpoint changes, timing absent or invalid, old history, reload, closed/reopened dialog, reconnects, and the real refresh-before-reconcile sequence. Check live modal-open and modal-closed presentation plus keyboard dismissal and screen reader roles.

## Non-goals and trade-offs

No OS-level push, external telemetry, implicit generation, or fabricated elapsed duration. Prefer the existing app state and one small reusable notification surface over a new event framework. Existing failures remain visible in persistent error surfaces.
