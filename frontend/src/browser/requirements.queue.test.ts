import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRequirements } from "./requirements";

const model = {key: "model", filename: "model.safetensors", loader: "Loader", field: "name", url: "https://example.com/model"};
vi.mock("./catalog", () => ({
  getFeature: () => ({models: {flash: [model]}, variants: [{mode: "flash", graph: {}}], defaults: {}}),
  resolveTemplate: (graph: unknown) => graph,
}));
vi.mock("./connection", () => ({
  endpoint: () => "http://127.0.0.1:8188",
  currentConnectionGeneration: () => 0,
  probe: async () => {},
  request: async (_address: string, path: string) => path === "/object_info/Loader"
    ? {Loader: {input: {required: {name: [["model.safetensors"]]}}}} : {},
}));
vi.mock("./manager", () => ({installTasks: () => [], reconcileInstalls: async () => [], saveInstallTasks: () => {}}));

afterEach(() => vi.unstubAllGlobals());

describe("Manager queue readiness", () => {
  it("blocks a queue active in another browser and allows idle or unsupported Manager", async () => {
    // Provide a model-free feature to isolate the global queue behavior from loader checks.
    const catalog = await import("./catalog");
    vi.spyOn(catalog, "getFeature").mockReturnValue({models: {flash: []}, variants: [], defaults: {}} as never);
    let status: unknown = {pending_count: 4, in_progress_count: 1, is_processing: true};
    let code = 200;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(status), {status: code}));
    vi.stubGlobal("fetch", fetchMock);
    expect((await checkRequirements("relight", "flash")).ready).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:8188/v2/manager/queue/status");
    status = {pending_count: 0, in_progress_count: 0, is_processing: false};
    expect((await checkRequirements("relight", "flash")).ready).toBe(true);
    code = 404;
    expect((await checkRequirements("relight", "flash")).ready).toBe(true);
    code = 500;
    expect((await checkRequirements("relight", "flash")).ready).toBe(false);
    code = 200; status = {};
    expect((await checkRequirements("relight", "flash")).ready).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect((await checkRequirements("relight", "flash")).ready).toBe(false);
    vi.restoreAllMocks();
  });

  it("does not trust a partial filename while another client is downloading", async () => {
    const catalog = await import("./catalog");
    vi.spyOn(catalog, "getFeature").mockReturnValue({models: {flash: [model]}, defaults: {},
      variants: [{mode: "flash", slots: [], graph: {one: {class_type: "Loader", inputs: {name: "model.safetensors"}}}}]} as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({pending_count: 0, in_progress_count: 1, is_processing: true}), {status: 200})));
    const result = await checkRequirements("relight", "flash");
    expect(result.model_requirements[0].available).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({name: "manager:queue", status: "fail"}));
    vi.restoreAllMocks();
  });
});
