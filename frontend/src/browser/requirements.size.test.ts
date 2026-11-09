import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkRequirements } from "./requirements";

// mp-marcostudio-qa#9: a zero-byte file under the expected name showed Ready.
const model = {key: "vae", filename: "model.safetensors", category: "vae", loader: "Loader", field: "name",
  url: "https://example.com/model", size: 254000000, sha256: "a".repeat(64)};
let listing: unknown = [];
let choices = ["model.safetensors"];
vi.mock("./catalog", () => ({
  getFeature: () => ({models: {flash: [model]}, defaults: {},
    variants: [{mode: "flash", slots: [], graph: {one: {class_type: "Loader", inputs: {name: "model.safetensors"}}}}]}),
  resolveTemplate: (graph: unknown) => graph,
}));
vi.mock("./connection", () => ({
  endpoint: () => "http://127.0.0.1:8188",
  currentConnectionGeneration: () => 0,
  runtimeInfo: async () => ({system: {comfyui_version: "0.43.0", pytorch_version: "2.13.0"}, devices: [{type: "cpu"}]}),
  request: async (_address: string, path: string) => {
    if (path === "/object_info/Loader") return {Loader: {input: {required: {name: [choices]}}}};
    if (path === "/experiment/models/vae") {
      if (listing instanceof Error) throw listing;
      return listing;
    }
    return {};
  },
}));
vi.mock("./manager", () => ({installTasks: () => [], reconcileInstalls: async () => [], saveInstallTasks: () => {}}));

beforeEach(() => {
  choices = ["model.safetensors"];
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key)});
  // Manager is idle; no checksum helper is installed.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v2/manager/queue/status")
    ? new Response(JSON.stringify({pending_count: 0, in_progress_count: 0, is_processing: false})) : new Response("", {status: 404})));
});
afterEach(() => vi.unstubAllGlobals());

it("blocks readiness for a zero-byte file with the expected name", async () => {
  listing = [{name: "model.safetensors", pathIndex: 0, size: 0}];
  const result = await checkRequirements("relight", "flash");
  expect(result.ready).toBe(false);
  expect(result.model_requirements[0]).toMatchObject({available: false, installable: false, actualSize: 0});
  expect(result.models).toEqual({});
  expect(result.checks).toContainEqual(expect.objectContaining({name: "size:vae", status: "fail"}));
});

it("stays ready when the file has the exact catalog size", async () => {
  listing = [{name: "model.safetensors", pathIndex: 0, size: model.size}];
  const result = await checkRequirements("relight", "flash");
  expect(result.ready).toBe(true);
  expect(result.models).toEqual({vae: "model.safetensors"});
});

it("keeps the name-only check when ComfyUI has no size listing", async () => {
  for (const value of [new Error("ComfyUI returned 404."), {}, [{name: "model.safetensors"}]]) {
    listing = value;
    const result = await checkRequirements("relight", "flash");
    expect(result.ready).toBe(true);
    expect(result.checks.some(check => check.name.startsWith("size:"))).toBe(false);
  }
});

it("matches Windows paths and uses the first model root that holds the name", async () => {
  choices = ["sub\\model.safetensors"];
  listing = [{name: "sub\\model.safetensors", pathIndex: 1, size: model.size}, {name: "sub\\model.safetensors", pathIndex: 0, size: 12}];
  const result = await checkRequirements("relight", "flash");
  expect(result.ready).toBe(false);
  expect(result.model_requirements[0].actualSize).toBe(12);
});
