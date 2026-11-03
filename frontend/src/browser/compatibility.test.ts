import { describe, expect, it } from "vitest";
import cases from "../../../tests/fixtures/relight_device.json";
import { deviceCompatibility, RELIGHT_PROFILE } from "./compatibility";
import { getFeature } from "./catalog";

describe("Relight device policy parity", () => {
  for (const item of cases) it(item.name, () => {
    expect(deviceCompatibility(item.feature, item.profile, item.runtime) ?? null).toEqual(item.expected);
  });
  it("requires deliberate review when the pinned profile changes", () => {
    expect(getFeature("relight").version).toBe(RELIGHT_PROFILE);
    expect(getFeature("relight").supported_modes).toEqual(["flash"]);
  });
});
