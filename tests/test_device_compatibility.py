import json
from pathlib import Path

import pytest

from marcostudio.comfy.compatibility import RELIGHT_PROFILE, device_compatibility
from marcostudio.features import get_feature

CASES = json.loads((Path(__file__).parent / "fixtures/relight_device.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_device_policy_parity(case):
    assert (
        device_compatibility(case["feature"], case["profile"], case["runtime"]) == case["expected"]
    )


def test_current_relight_profile_requires_deliberate_policy_review_on_change():
    tool = get_feature("relight")
    assert tool.manifest.WORKFLOW_VERSION == RELIGHT_PROFILE
    assert tool.modes == ("flash",)
