import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFeature } from "./catalog";
import { selectConnection } from "./connection";
import { installTasks, reconcileInstalls, saveInstallTasks, startDownloads, type InstallTask } from "./manager";

const address = "http://127.0.0.1:8192";
const model = getFeature("relight").models.flash[0];
const response = (body: unknown) => new Response(JSON.stringify(body), {status: 200});

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key)});
  selectConnection(address);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("download submission queue recheck", () => {
  const idle = {total_count: 0, pending_count: 0, in_progress_count: 0, is_processing: false};
  function installFixture(globalStatus: unknown, statusCode = 200) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) return response({history: {}});
      if (url.pathname.endsWith("/status")) return url.searchParams.has("client_id")
        ? response(idle) : new Response(JSON.stringify(globalStatus), {status: statusCode});
      if (init?.method === "POST") return new Response(null, {status: 200});
      throw new Error(`Unexpected request ${url.pathname}`);
    });
  }
  it("blocks a newly active queue from a different browser without submitting", async () => {
    const fetch = installFixture({...idle, pending_count: 1}); vi.stubGlobal("fetch", fetch);
    await expect(startDownloads([model])).rejects.toThrow("setup tasks in progress");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(installTasks(address)).toEqual([]);
  });
  it.each([[{}, 200], [null, 503]])("blocks an unknown global queue response", async (status, code) => {
    const fetch = installFixture(status, code); vi.stubGlobal("fetch", fetch);
    await expect(startDownloads([model])).rejects.toThrow("Couldn't check the ComfyUI Manager queue");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("does not submit when Manager is unavailable", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {status: 404})); vi.stubGlobal("fetch", fetch);
    await expect(startDownloads([model])).rejects.toThrow("Open ComfyUI to enable model downloads");
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(installTasks(address)).toEqual([]);
  });
  it("submits the selected batch when the unfiltered queue is idle", async () => {
    const fetch = installFixture(idle); vi.stubGlobal("fetch", fetch);
    const tasks = await startDownloads([model]);
    expect(tasks[0].state).toBe("queued");
    expect(fetch.mock.calls.filter(([input, init]) => String(input).endsWith("/install_model") && init?.method === "POST")).toHaveLength(1);
  });
  it("persists batch identity and request time for all selected files", async () => {
    const fetch = installFixture(idle); vi.stubGlobal("fetch", fetch);
    const models = getFeature("relight").models.flash.slice(0, 2);
    const start = Date.now();
    await startDownloads(models);
    const persisted = installTasks(address);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].batchId).toBeTruthy();
    expect(persisted[1].batchId).toBe(persisted[0].batchId);
    expect(persisted[0].submittedAt).toBeGreaterThanOrEqual(start);
    expect(persisted[1].submittedAt).toBe(persisted[0].submittedAt);
  });
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
    expect(installTasks(address)[0].observedFinishedAt).toEqual(expect.any(Number));
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
