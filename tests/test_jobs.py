import io

import httpx
import pytest
from PIL import Image


def picture():
    stream = io.BytesIO()
    Image.new("RGB", (48, 32), "white").save(stream, format="PNG")
    return stream.getvalue()


def test_asset_decoding_and_safe_storage(tmp_path):
    from marcostudio.core.assets import Assets
    from marcostudio.core.store import Store

    store = Store(tmp_path)
    assets = Assets(store)
    asset = assets.add(picture(), "../../unsafe.png")
    assert asset["width"] == 48
    assert asset["height"] == 32
    assert ".." not in asset["filename"]
    assert assets.path(asset["id"]).is_relative_to(tmp_path)
    assert assets.add(picture(), "again.png")["id"] == asset["id"]
    with pytest.raises(ValueError):
        assets.add(b"not an image", "x.png")
    with pytest.raises(KeyError):
        assets.path("../../outside")


def test_job_idempotency_survives_restart_and_rejects_changed_payload(tmp_path):
    from marcostudio.core.assets import Assets
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "one-key")
    reopened = Store(tmp_path)
    assert (
        reopened.create_job(source["id"], RelightSettings().model_dump(), "one-key")["id"]
        == job["id"]
    )
    with pytest.raises(ValueError, match="different"):
        reopened.create_job(
            source["id"], RelightSettings(direction="right").model_dump(), "one-key"
        )


@pytest.mark.asyncio
async def test_lost_submit_response_is_never_retried(tmp_path):
    from marcostudio.config import Settings
    from marcostudio.core.assets import Assets
    from marcostudio.core.jobs import JobService
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    class LostResponse:
        submitted = 0

        async def upload(self, *args):
            return "source.png"

        async def submit(self, *args):
            self.submitted += 1
            raise httpx.ReadTimeout("lost response")

        async def find(self, *args):
            return None

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "request")
    transport = LostResponse()
    service = JobService(Settings(data_dir=tmp_path), store, transport)
    await service.execute(job["id"], readiness={"ready": True, "models": {}, "identities": {}})
    assert store.job(job["id"])["status"] == "needs_attention"
    await service.execute(job["id"], readiness={"ready": True, "models": {}, "identities": {}})
    assert transport.submitted == 1


@pytest.mark.asyncio
async def test_authoritative_success_requires_decodable_output(tmp_path):
    from marcostudio.config import Settings
    from marcostudio.core.assets import Assets
    from marcostudio.core.jobs import JobService
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    class Completed:
        async def state(self, jid):
            return {
                "status": "succeeded",
                "outputs": [{"node_id": "12", "id": "asset", "job_id": jid}],
                "history": {"status": {"completed": True}},
            }

        async def output(self, *args):
            return b"broken PNG"

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "request")
    store.update_job(job["id"], status="running", upstream_id="known")
    service = JobService(Settings(data_dir=tmp_path), store, Completed())
    await service.reconcile(job["id"])
    assert store.job(job["id"])["status"] == "needs_attention"
    assert store.job(job["id"])["outputs"] == []


@pytest.mark.asyncio
async def test_queued_cancellation_recovers_after_restart(tmp_path):
    from marcostudio.config import Settings
    from marcostudio.core.assets import Assets
    from marcostudio.core.jobs import JobService
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    class Removed:
        async def state(self, jid):
            return {"status": "unknown"}

        async def native_json(self, path):
            return {"queue_running": [], "queue_pending": []} if path == "/queue" else {}

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "request")
    store.update_job(
        job["id"],
        status="cancel_requested",
        upstream_id="known",
        cancel_acknowledged=True,
        cancel_phase="queued",
    )
    service = JobService(Settings(data_dir=tmp_path), Store(tmp_path), Removed())
    await service.reconcile(job["id"])
    assert store.job(job["id"])["status"] == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("already_acknowledged", [False, True])
async def test_cancel_uses_native_phase_and_preserves_previous_acknowledgment(
    tmp_path, already_acknowledged
):
    from marcostudio.config import Settings
    from marcostudio.core.assets import Assets
    from marcostudio.core.jobs import JobService
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    class ScopedCancellation:
        removed = already_acknowledged

        async def native_json(self, path):
            if path == "/queue":
                return {
                    "queue_running": [],
                    "queue_pending": [] if self.removed else [[0, "known", {}]],
                }
            return {}

        async def cancel(self, jid):
            assert jid == "known"
            self.removed = True
            return True

        async def state(self, jid):
            return {"status": "unknown"}

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "request")
    store.update_job(
        job["id"],
        status="needs_attention",
        upstream_id="known",
        cancel_acknowledged=already_acknowledged,
        cancel_phase="queued" if already_acknowledged else None,
    )
    service = JobService(Settings(data_dir=tmp_path), store, ScopedCancellation())
    result = await service.cancel(job["id"])
    assert result["status"] == "cancelled"
    assert result["cancel_phase"] == "queued"


@pytest.mark.asyncio
async def test_manual_resolution_never_dismisses_running_job(tmp_path):
    from marcostudio.config import Settings
    from marcostudio.core.assets import Assets
    from marcostudio.core.jobs import JobService
    from marcostudio.core.store import Store
    from marcostudio.features.relight.settings import RelightSettings

    class Uncertain:
        running = True

        async def find(self, prefix):
            return "known" if self.running else None

        async def state(self, jid):
            return {"status": "unknown"}

        async def native_json(self, path):
            return {
                "queue_running": [[0, "known", {}]] if self.running else [],
                "queue_pending": [],
            }

    store = Store(tmp_path)
    source = Assets(store).add(picture(), "source.png")
    job = store.create_job(source["id"], RelightSettings().model_dump(), "request")
    store.update_job(job["id"], status="needs_attention")
    transport = Uncertain()
    service = JobService(Settings(data_dir=tmp_path), store, transport)
    with pytest.raises(ValueError, match="running"):
        await service.resolve(job["id"])
    transport.running = False
    assert (await service.resolve(job["id"]))["status"] == "abandoned"
