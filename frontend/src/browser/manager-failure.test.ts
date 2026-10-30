import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFeature } from "./catalog";
import { selectConnection } from "./connection";
import { installTasks, reconcileInstalls, saveInstallTasks, type InstallTask } from "./manager";

const address = "http://127.0.0.1:8192";
const model = getFeature("relight").models.flash[0];
const response = (body: unknown) => new Response(JSON.stringify(body), {status: 200});

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key)});
  selectConnection(address);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Manager download failure guidance", () => {
  it("treats a generic completed Manager failure as a possible disk or network issue", async () => {
    const task: InstallTask = {id: "failure-task", model, state: "queued"};
    saveInstallTasks(address, [task]);
    vi.stubGlobal("fetch", vi.fn(async () => response({history: {"failure-task": {
      ui_id: "failure-task", result: "Model installation error", status: {status_str: "error", completed: true, messages: ["Model installation error"]},
    }}})));
    await reconcileInstalls(address);
    const result = installTasks(address)[0];
    expect(result.state).toBe("failed");
    expect(result.error).toContain("Check free space");
    expect(result.error).toContain("internet connection");
    expect(result.error).toContain("incomplete model file");
    expect(result.error).not.toContain("disk is full");
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("does not report a failure for a completed successful download", async () => {
    saveInstallTasks(address, [{id: "success-task", model, state: "queued"}]);
    vi.stubGlobal("fetch", vi.fn(async () => response({history: {"success-task": {
      ui_id: "success-task", result: "success", status: {status_str: "success", completed: true, messages: []},
    }}})));
    await reconcileInstalls(address);
    expect(installTasks(address)[0].state).toBe("succeeded");
    expect(installTasks(address)[0].error).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("retains an explicit disk-full cause without treating generic failures as disk-full", async () => {
    saveInstallTasks(address, [{id: "full-task", model, state: "queued"}]);
    vi.stubGlobal("fetch", vi.fn(async () => response({history: {"full-task": {
      ui_id: "full-task", result: "failed", status: {status_str: "error", completed: true, messages: ["Disk full"]},
    }}})));
    await reconcileInstalls(address);
    expect(installTasks(address)[0].error).toContain("ComfyUI reports: Disk full.");
  });
});
