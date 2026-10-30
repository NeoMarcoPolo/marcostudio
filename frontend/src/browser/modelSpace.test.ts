import { describe, expect, it, vi, afterEach } from "vitest";
import { canPairStorage, checkStorage, spaceGroups, supportsStoragePairing } from "./modelSpace";
import type { Model } from "./catalog";
const model = (id: string, size = 20) => ({sha256: id.repeat(64), size, filename: `${id}.safetensors`} as Model);
afterEach(() => vi.unstubAllGlobals());
describe("model destination space", () => {
  it("only permits HTTPS or literal loopback HTTP for bearer tokens", () => {
    for (const address of ["http://127.0.0.1:8188", "http://[::1]:8188", "https://comfy.example"]) expect(canPairStorage(address)).toBe(true);
    for (const address of ["http://127.1:8188", "http://localhost:8188", "http://192.168.1.2:8188", "https://user:password@comfy.example", "file:///etc"]) expect(canPairStorage(address)).toBe(false);
  });
  it("does not offer pairing without explicit helper capability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({version: 1, h3_pdd: true}), {status: 200})));
    expect(await supportsStoragePairing("http://127.0.0.1:8188")).toBe(false);
  });
  it("uses bearer authorization, refuses redirects, and validates IDs", async () => {
    const id = "a".repeat(64);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({version: 1, models: [{id, status: "available", available_bytes: 100, volume: "opaque"}]}), {status: 200}));
    vi.stubGlobal("fetch", fetch);
    const result = await checkStorage("http://127.0.0.1:8188", "secret", [model("a")]);
    expect(result.models[0].available_bytes).toBe(100);
    expect(fetch.mock.calls[0][1]).toMatchObject({headers: {Authorization: "Bearer secret"}, redirect: "error", credentials: "omit", cache: "no-store"});
    expect(fetch.mock.calls[0][0]).not.toContain("secret");
    await expect(checkStorage("http://192.168.1.2:8188", "secret", [model("a")])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed reports and does not undercount destination requirements", async () => {
    const id = "a".repeat(64);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({version: 1, models: [{id, status: "available", available_bytes: 100, volume: "/private/path"}]}), {status: 200}));
    vi.stubGlobal("fetch", fetch);
    await expect(checkStorage("http://127.0.0.1:8188", "secret", [model("a")])).rejects.toThrow();
    const result = spaceGroups([model("a", 60), model("b", 50)], {version: 1, models: [
      {id, status: "available", available_bytes: 100, volume: "one"}, {id: "b".repeat(64), status: "available", available_bytes: 100, volume: "one"},
    ]});
    expect(result.groups[0]).toMatchObject({available: 100, needed: 110});
    expect(result.unknown).toBe(false);
    expect(spaceGroups([model("a")], {version: 1, models: []}).unknown).toBe(true);
  });
});
