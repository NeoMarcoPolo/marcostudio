import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { api, post, useBrowserRuntime, type Job } from "../api";
import { catalog, compile, getFeature } from "./catalog";
import { CONNECTION_KEY, discover, selectConnection } from "./connection";
import { installTasks, managerAvailable, reconcileInstalls, startDownloads } from "./manager";
import { checkRequirements } from "./requirements";
import { allowUnverified, clearUnverified, integrityStates } from "./integrity";
import { browserApi } from "./runtime";
import { getAsset, uploadAsset } from "./assets";

// These tests exercise the surrounding runtime with integrity already verified.
// Integrity's missing/invalid paths are covered by its dedicated tests.
vi.mock("./integrity", async original => ({...await original<typeof import("./integrity")>(),
  integrityStates: vi.fn(async (_address: string, models: {sha256: string}[]) => new Map(models.map(model => [model.sha256, "matched"]))),
}));

const blobs = vi.hoisted(() => new Map<string, Blob>());
vi.mock("./storage", async importOriginal => ({...await importOriginal<typeof import("./storage")>(),
  saveBlob: vi.fn(async (id: string, blob: Blob) => {blobs.set(id, blob);}),
  getBlob: vi.fn(async (id: string) => blobs.get(id)),
}));

vi.mock("./assets", async importOriginal => ({...await importOriginal<typeof import("./assets")>(),
  mediaMetadata: vi.fn(async () => ({width: 1024, height: 1024})),
}));
const address = "http://127.0.0.1:8188";
let missing = false, available = true, manager = false, losePrompt = false, loseDownload = false;
let managerQueue: "idle" | "active" | "unknown" = "idle";
let pending: unknown[][], history: Record<string, unknown>, taskHistory: Record<string, unknown>;
let batchOperations: unknown[];
let calls: {path: string; method: string; body: any}[];

// A small native API fixture. Generation/history and Manager responses use their
// upstream wire formats; no MarcoStudio server routes are served by this fake.
function definitions() {
  const result: Record<string, {input: {required: Record<string, unknown[]>}}> = {};
  for (const id of ["relight", "create-image"] as const) {
    const feature = getFeature(id);
    const settings = {...feature.defaults, instruction: "A cedar tree"} as Job["settings"];
    const graph = compile(feature, settings, id === "relight" ? "source.png" : null, {},
      Object.fromEntries(feature.models[settings.mode].map(model => [model.key, model.filename])), "test");
    for (const node of Object.values(graph)) {
      const fields = result[node.class_type]?.input.required ?? {};
      for (const [key, value] of Object.entries(node.inputs)) fields[key] = [typeof value === "number" ? Number.isInteger(value) ? "INT" : "FLOAT" : typeof value === "string" ? "STRING" : "ANY"];
      result[node.class_type] = {input: {required: fields}};
    }
  }
  for (const model of catalog.flatMap(feature => Object.values(feature.models).flat())) {
    if (result[model.loader]) result[model.loader].input.required[model.field] = [[...new Set(catalog.flatMap(feature => Object.values(feature.models).flat())
      .filter(item => item.loader === model.loader && item.field === model.field && !(missing && item.key === "relight"))
      .map(item => item.filename))]];
  }
  return result;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json"}});
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key)});
  useBrowserRuntime(browserApi);
  blobs.clear(); clearUnverified();
  vi.mocked(integrityStates).mockImplementation(async (_address, models) => new Map(models.map(model => [model.sha256, "matched"])));
  managerQueue = "idle";
  missing = false; available = true; manager = false; losePrompt = false; loseDownload = false;
  pending = []; history = {}; taskHistory = {}; batchOperations = []; calls = [];
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable: true, value: function(this: HTMLDialogElement) {this.setAttribute("open", "");}});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname, method = init?.method ?? "GET", body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, method, body});
    if (url.port === "8000" || !available) throw new TypeError("Failed to fetch");
    if (path === "/system_stats") return json({system: {comfyui_version: "0.18.0"}, devices: []});
    if (path === "/marcostudio/capabilities") return json({error: "Not found"}, 404);
    if (path.startsWith("/object_info/")) {
      const name = decodeURIComponent(path.split("/").pop()!); const value = definitions()[name];
      return json(value ? {[name]: value} : {});
    }
    if (path === "/queue") return json({queue_running: [], queue_pending: pending});
    if (path.startsWith("/history")) return json(history);
    if (path === "/view") return new Response(new Blob(["image"], {type: "image/png"}));
    if (path === "/upload/image") return json({name: (body.get("image") as File).name, subfolder: body.get("subfolder"), type: "input"});
    if (path === "/prompt") {
      pending.push([0, "upstream-id", body.prompt, body.extra_data]);
      if (losePrompt) throw new TypeError("Lost acknowledgement");
      return json({prompt_id: "upstream-id"});
    }
    if (path.startsWith("/v2/manager/queue/")) {
      if (!manager) return json({error: "Not found"}, 404);
      if (path.endsWith("/status")) return managerQueue === "unknown" ? json({error: "unavailable"}, 503) : json({total_count: 0, pending_count: managerQueue === "active" ? 1 : 0, in_progress_count: 0, is_processing: false});
      if (path.endsWith("/history_list")) return json({ids: batchOperations.length ? ["completed-batch"] : []});
      if (path.endsWith("/history")) return json(url.searchParams.has("id") ? {operations: batchOperations} : {history: taskHistory});
      if (path.endsWith("/install_model")) {
        if (loseDownload) throw new TypeError("Lost acknowledgement");
        return new Response(null, {status: 200});
      }
      if (path.endsWith("/start")) return new Response(null, {status: 200});
    }
    throw new Error(`Unexpected native request ${path}`);
  }));
});
afterEach(() => {useBrowserRuntime(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe("direct ComfyUI onboarding", () => {
  it("connects, detects a manual fix on focus, and opens the studio without submitting anything", async () => {
    missing = true;
    const view = render(<App/>);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", {name: "Connect"})[0]);
    await within(dialog).findByText("ComfyUI connected");
    await within(dialog).findByText("1 model missing");
    expect(within(dialog).queryByRole("button", {name: "Open studio"})).not.toBeInTheDocument();
    missing = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(within(dialog).getByRole("button", {name: "Open studio"})).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", {name: "Open studio"}));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter(call => call.method === "POST")).toEqual([]);
    expect(screen.getByRole("link", {name: "GitHub"})).toBeVisible();
    fireEvent.change(screen.getByLabelText("Seed"), {target: {value: "123"}});
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`marcostudio.v1:${address}:draft`)!).settings.seed).toBe(123));
    view.unmount(); render(<App/>);
    await waitFor(() => expect(screen.getByLabelText("Seed")).toHaveValue(123));
  });

  it("rechecks a returning connection without requiring Manager or reopening completed setup", async () => {
    selectConnection(address); localStorage.setItem(`marcostudio.entered:${address}`, "true");
    render(<App/>);
    await screen.findByText("ComfyUI connected");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await managerAvailable()).toBe(false);
    expect((await checkRequirements("relight", "flash")).ready).toBe(true);
  });

  it("keeps a failed connection on the current step and shows only the selected launcher fix", async () => {
    selectConnection("http://127.0.0.1:9000"); available = false;
    await expect(discover()).rejects.toThrow("Couldn't connect");
    expect(localStorage.getItem(CONNECTION_KEY)).toBe("http://127.0.0.1:9000");
    expect(calls.filter(call => call.path === "/system_stats")).toHaveLength(1);
    render(<App/>);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Connect to check")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", {name: "Open studio"})).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole("button", {name: "Connect"})[0]);
    const help = await within(dialog).findByRole("button", {name: "It's already running"});
    expect(within(dialog).queryByText(`--enable-cors-header ${location.origin}`)).not.toBeInTheDocument();
    fireEvent.click(help);
    expect(within(dialog).queryByText(`--enable-cors-header ${location.origin}`)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", {name: "Desktop"}));
    expect(within(dialog).getByText(/Startup Arguments/)).toBeVisible();
    expect(within(dialog).queryByText(/Edit your .bat launcher/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(`--enable-cors-header ${location.origin}`)).toBeVisible();
    expect(within(dialog).getByRole("button", {name: "Copy launch option"})).toBeVisible();
    expect(within(dialog).getByRole("button", {name: "Try again"})).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", {name: "Portable"}));
    expect(within(dialog).getByText(/Edit your .bat launcher/)).toBeVisible();
    expect(within(dialog).queryByText(/Startup Arguments/)).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== "GET")).toEqual([]);
  });

  it("remembers a blocked custom address across refresh and reconnects there after returning from ComfyUI", async () => {
    available = false;
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {clipboard: {writeText: copy}}));
    const view = render(<App/>);
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", {name: "Connect"})[0]);
    await within(dialog).findByRole("button", {name: "Try again"});
    fireEvent.click(within(dialog).getByText("Change address"));
    fireEvent.change(within(dialog).getByLabelText("ComfyUI address"), {target: {value: "http://127.0.0.1:9194/"}});
    fireEvent.submit(within(dialog).getByLabelText("ComfyUI address").closest("form")!);
    await waitFor(() => expect(within(dialog).getByRole("button", {name: "Try again"})).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", {name: "It's already running"}));
    fireEvent.click(within(dialog).getByRole("button", {name: "Terminal"}));
    fireEvent.click(within(dialog).getByRole("button", {name: "Copy launch option"}));
    await within(dialog).findByRole("button", {name: "Copied"});
    expect(copy).toHaveBeenCalledWith(`--enable-cors-header ${location.origin}`);
    expect(localStorage.getItem(CONNECTION_KEY)).toBeNull();
    view.unmount(); render(<App/>);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", {name: "Change address"}));
    expect(within(dialog).getByLabelText("ComfyUI address")).toHaveValue("http://127.0.0.1:9194");
    fireEvent.click(within(dialog).getByRole("button", {name: /Back to setup/}));
    available = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await within(dialog).findByText("ComfyUI connected");
    await waitFor(() => expect(within(dialog).getByRole("button", {name: "Open studio"})).toBeEnabled());
    expect(localStorage.getItem(CONNECTION_KEY)).toBe("http://127.0.0.1:9194");
    expect(within(dialog).queryByRole("button", {name: "Copy launch option"})).not.toBeInTheDocument();
    expect(calls.filter(call => call.method !== "GET")).toEqual([]);
  });
});

describe("native generation and installation recovery", () => {
  it("allows an explicitly consented manual install to submit while preserving the unverified warning", async () => {
    selectConnection(address);
    vi.mocked(integrityStates).mockImplementation(async (_address, models) => new Map(models.map(model => [model.sha256, "unverified"])));
    const feature = getFeature("create-image"), mode = feature.defaults.mode;
    const before = await checkRequirements("create-image", mode);
    await allowUnverified(address, before.model_requirements.filter(model => model.available));
    const after = await checkRequirements("create-image", mode);
    expect(after.ready).toBe(true);
    expect(after.checks.some(check => check.name.startsWith("integrity-unverified:") && check.status === "warn")).toBe(true);
    const body = {request_id: crypto.randomUUID(), feature: "create-image", source_id: null,
      inputs: {}, settings: {...feature.defaults, instruction: "A cedar tree"}};
    expect((await post<Job>("/api/jobs", body)).status).toBe("queued");
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(1);
  });
  it("requires explicit session consent for manual models and still blocks active or unknown queues", async () => {
    selectConnection(address);
    vi.mocked(integrityStates).mockImplementation(async (_address, models) => new Map(models.map(model => [model.sha256, "unverified"])));
    const mode = getFeature("create-image").defaults.mode;
    const before = await checkRequirements("create-image", mode);
    expect(before.ready).toBe(false);
    await allowUnverified(address, before.model_requirements.filter(model => model.available));
    const accepted = await checkRequirements("create-image", mode);
    expect(accepted.ready).toBe(true);
    expect(accepted.checks.some(check => check.status === "warn" && check.name.startsWith("integrity-unverified:"))).toBe(true);
    manager = true; managerQueue = "active";
    const request = {request_id: crypto.randomUUID(), feature: "create-image", source_id: null,
      inputs: {}, settings: {...getFeature("create-image").defaults, instruction: "A cedar tree"}};
    expect((await post<Job>("/api/jobs", request)).status).toBe("failed");
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(0);
    const active = await checkRequirements("create-image", mode);
    expect(active.ready).toBe(false);
    expect(active.checks.find(check => check.name === "manager:queue")?.status).toBe("fail");
    managerQueue = "unknown";
    expect((await checkRequirements("create-image", mode)).ready).toBe(false);
    manager = false;
    // Observed queue activity invalidates the prior fallback consent.
    expect((await checkRequirements("create-image", mode)).ready).toBe(false);
  });
  it("stores normalized uploads before sending them to ComfyUI and restores their metadata", async () => {
    selectConnection(address);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({width: 640, height: 480, close: vi.fn()})));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage: vi.fn()} as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["normalized"], {type: "image/png"})));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:uploaded");
    const asset = await uploadAsset(new File(["jpeg"], "portrait.jpg", {type: "image/jpeg"}));
    const upload = calls.find(call => call.path === "/upload/image")!;
    expect(upload.body.get("image").type).toBe("image/png");
    expect(upload.body.get("image").name).not.toContain("portrait");
    expect(blobs.get(`${address}:${asset.id}`)?.type).toBe("image/png");
    expect(await getAsset(asset.id)).toMatchObject({id: asset.id, width: 640, height: 480, filename: "portrait.png"});
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(0);
  });
  it("refuses generation when a verified snapshot changes before submission", async () => {
    selectConnection(address);
    vi.mocked(integrityStates)
      .mockImplementationOnce(async (_address, models) => new Map(models.map(model => [model.sha256, "matched"])))
      .mockImplementationOnce(async (_address, models) => new Map(models.map(model => [model.sha256, "unverified"])));
    const body = {request_id: crypto.randomUUID(), feature: "create-image", source_id: null,
      inputs: {}, settings: {...getFeature("create-image").defaults, instruction: "A cedar tree"}};
    const result = await post<Job>("/api/jobs", body);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/verification changed/i);
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(0);
  });
  it("recovers a lost prompt acknowledgement by request identity and survives a page reload", async () => {
    selectConnection(address); losePrompt = true;
    const body = {request_id: crypto.randomUUID(), feature: "create-image", source_id: null,
      inputs: {}, settings: {...getFeature("create-image").defaults, instruction: "A cedar tree"}};
    const first = await post<Job>("/api/jobs", body);
    expect(first.status).toBe("needs_attention");
    useBrowserRuntime(undefined); useBrowserRuntime(browserApi);
    expect((await api<Job[]>("/api/jobs"))[0].id).toBe(body.request_id);
    const recovered = await post<Job>("/api/jobs", body);
    expect(recovered.status).toBe("queued");
    const queued = pending[0]; pending = [];
    history = {"upstream-id": {prompt: queued, status: {status_str: "success", completed: true}, outputs: {"12": {images: [{filename: "test.png", type: "output", subfolder: "MarcoStudio"}]}}}};
    const complete = await api<Job>(`/api/jobs/${body.request_id}`);
    expect(complete.status).toBe("succeeded");
    expect(complete.outputs[0].url).toContain(`${address}/view?`);
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(1);
    expect(calls.every(call => !call.path.startsWith("/api/"))).toBe(true);
  });

  it("keeps an unreported job uncertain and doesn't resubmit it", async () => {
    selectConnection(address); losePrompt = true;
    const body = {request_id: crypto.randomUUID(), feature: "create-image", source_id: null, settings: {...getFeature("create-image").defaults, instruction: "A cedar tree"}};
    await post("/api/jobs", body); pending = [];
    const recovered = await post<Job>("/api/jobs", body);
    expect(recovered.status).toBe("needs_attention");
    expect(calls.filter(call => call.path === "/prompt")).toHaveLength(1);
  });

  it("persists model task IDs before submission, reconciles unknown outcomes, and retries only a confirmed failure", async () => {
    selectConnection(address); manager = true; loseDownload = true;
    const model = getFeature("relight").models.flash[0];
    const [task] = await startDownloads([model, model]);
    expect(task.state).toBe("unknown");
    await startDownloads([model]);
    expect(calls.filter(call => call.path.endsWith("install_model"))).toHaveLength(1);
    taskHistory[task.id] = {ui_id: task.id, result: "Disk full", status: {status_str: "failed", completed: true, messages: ["Disk full"]}};
    expect((await reconcileInstalls())[0].error).toContain("ComfyUI reports: Disk full.");
    loseDownload = false;
    await startDownloads([model]);
    const submissions = calls.filter(call => call.path.endsWith("install_model"));
    expect(submissions).toHaveLength(2);
    expect(submissions[1].body).toMatchObject({save_path: "default", type: "diffusion_model", url: model.url});
    expect(submissions[1].body.ui_id).not.toBe(task.id);
    expect(calls.filter(call => call.path.endsWith("/start"))).toHaveLength(1);
  });

  it("keeps an acknowledged download queued when an older status poll finishes later", async () => {
    selectConnection(address); manager = true;
    const nativeFetch = fetch;
    let acceptDownload!: () => void;
    let finishPoll!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acceptDownload = resolve; });
    const historyResponse = new Promise<void>(resolve => { finishPoll = resolve; });
    let pollStarted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      const url = new URL(String(input));
      if (url.pathname.endsWith("/install_model")) await acknowledgement;
      if (url.pathname.endsWith("/history") && url.searchParams.has("ui_id")) {
        pollStarted = true;
        await historyResponse;
      }
      return response;
    }));
    const model = getFeature("relight").models.flash[0];
    const download = startDownloads([model]);
    await waitFor(() => expect(installTasks()[0]?.state).toBe("submitting"));
    const poll = reconcileInstalls();
    await waitFor(() => expect(pollStarted).toBe(true));
    acceptDownload();
    await download;
    expect(installTasks()[0].state).toBe("queued");
    finishPoll();
    expect((await poll)[0].state).toBe("queued");
    expect(installTasks()[0].state).toBe("queued");
    await startDownloads([model]);
    expect(calls.filter(call => call.path.endsWith("/install_model"))).toHaveLength(1);
  });

  it("doesn't declare a tool ready while a newly visible model is still downloading", async () => {
    selectConnection(address); manager = true;
    const model = getFeature("relight").models.flash[0];
    const [task] = await startDownloads([model]);
    const during = await checkRequirements("relight", "flash");
    expect(during.ready).toBe(false);
    expect(during.checks.some(check => check.name.startsWith("download:"))).toBe(true);
    // A ComfyUI restart cleared the session history, but Manager retained the batch.
    batchOperations = [{operation_id: task.id, result: "success", end_time: new Date().toISOString()}];
    expect((await checkRequirements("relight", "flash")).ready).toBe(true);
  });
});
