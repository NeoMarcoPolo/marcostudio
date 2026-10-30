import { describe, expect, it } from "vitest";
import type { InstallTask } from "./browser/manager";
import { createDownloadSnapshots, observeDownloadTasks, shouldAnnounceConnection } from "./notificationEvents";

const task = (id: string, state: InstallTask["state"], submittedAt?: number, observedFinishedAt?: number) => ({
  id, state, submittedAt, observedFinishedAt, model: {filename: `${id}.safetensors`},
}) as InstallTask;

describe("download notifications", () => {
  it("announces explicit A to B to A connections but suppresses automatic repeats", () => {
    expect(shouldAnnounceConnection("a", "b", false)).toBe(true);
    expect(shouldAnnounceConnection("b", "a", false)).toBe(true);
    expect(shouldAnnounceConnection("a", "a", true)).toBe(false);
  });
  it("ignores old history and announces a pending completion exactly once across polls", () => {
    const state = createDownloadSnapshots();
    expect(observeDownloadTasks(state, "a", [task("old", "succeeded"), task("new", "queued", 1000)])).toEqual([]);
    const finished = task("new", "succeeded", 1000, 201000);
    expect(observeDownloadTasks(state, "a", [task("old", "succeeded"), finished])).toEqual([
      {text: "Model download complete: new.safetensors (observed after 200s)", failure: false},
    ]);
    expect(observeDownloadTasks(state, "a", [finished])).toEqual([]);
  });
  it("separates endpoints, suppresses unknown outcomes and doesn't invent missing time", () => {
    const state = createDownloadSnapshots();
    observeDownloadTasks(state, "a", [task("one", "queued")]);
    observeDownloadTasks(state, "b", [task("one", "queued")]);
    expect(observeDownloadTasks(state, "a", [task("one", "unknown")])).toEqual([]);
    expect(observeDownloadTasks(state, "a", [task("one", "failed")])).toEqual([
      {text: "Model download failed: one.safetensors. Check setup for details.", failure: true},
    ]);
    expect(observeDownloadTasks(state, "b", [task("one", "succeeded")])).toHaveLength(1);
    expect(observeDownloadTasks(state, "a", [task("failed-immediately", "failed"), task("fast", "succeeded"), task("old", "succeeded")], ["failed-immediately", "fast"])).toHaveLength(2);
  });
  it("reports an explicitly submitted terminal task even on the first snapshot", () => {
    const state = createDownloadSnapshots();
    expect(observeDownloadTasks(state, "a", [task("fast", "succeeded")], ["fast"])).toHaveLength(1);
    expect(observeDownloadTasks(state, "a", [task("fast", "succeeded")], ["fast"])).toEqual([]);
  });
});
