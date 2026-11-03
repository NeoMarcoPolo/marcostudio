from copy import deepcopy

import pytest

from marcostudio.core.jobs import JobService, jobs_with_waiting
from marcostudio.core.store import TERMINAL, Store


@pytest.mark.parametrize(
    "status",
    [
        "submitting",
        "queued",
        "running",
        "cancel_requested",
        "needs_attention",
        "future_state",
        *sorted(TERMINAL),
        "preparing",
    ],
)
def test_waiting_uses_scheduler_predicate_without_mutation(status):
    original = [
        {"id": "pending", "status": "preparing", "error": None},
        {"id": "other", "status": status},
    ]
    before = deepcopy(original)
    result = jobs_with_waiting(original)
    expected = deepcopy(before)
    if status not in TERMINAL | {"preparing"}:
        blocker = {"id": "other", "status": status}
        if status == "needs_attention":
            blocker["resolve_command"] = (
                "marcostudio jobs --server STUDIO_URL resolve other --confirm-not-running"
            )
        expected[0]["waiting"] = {
            "message": "Waiting for active jobs.",
            "blockers": [blocker],
        }
    assert result == expected
    assert original == before
    assert jobs_with_waiting([]) == []


def test_mixed_blockers_clear_independently_and_only_uncertain_has_resolution():
    snapshot = [
        {"id": "pending", "status": "preparing"},
        {"id": "uncertain", "status": "needs_attention"},
        {"id": "healthy", "status": "running"},
    ]
    blockers = jobs_with_waiting(snapshot)[0]["waiting"]["blockers"]
    assert blockers == [
        {
            "id": "uncertain",
            "status": "needs_attention",
            "resolve_command": "marcostudio jobs --server STUDIO_URL resolve uncertain --confirm-not-running",
        },
        {"id": "healthy", "status": "running"},
    ]
    snapshot[1]["status"] = "abandoned"
    assert jobs_with_waiting(snapshot)[0]["waiting"]["blockers"] == [
        {"id": "healthy", "status": "running"}
    ]
    snapshot[2]["status"] = "succeeded"
    assert jobs_with_waiting(snapshot) == snapshot


@pytest.mark.asyncio
async def test_uncertain_job_still_prevents_worker_submission(tmp_path):
    from marcostudio.config import Settings

    config = Settings(data_dir=tmp_path)
    store = Store(tmp_path)
    prior = store.create_job(None, {}, "prior")
    store.update_job(prior["id"], status="needs_attention", error="Uncertain outcome")
    pending = store.create_job(None, {}, "pending")
    before = store.jobs()
    service = JobService(config, store, object())
    reconciled, executed = [], []

    async def reconcile(job_id):
        reconciled.append(job_id)
        service.stopping.set()

    async def execute(job_id):
        executed.append(job_id)
        service.stopping.set()

    service.reconcile, service.execute = reconcile, execute
    await service.run()
    assert reconciled == [prior["id"]]
    assert executed == []
    assert store.jobs() == before
    assert store.job(pending["id"])["status"] == "preparing"
