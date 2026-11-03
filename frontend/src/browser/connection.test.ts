import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discover, endpoint, probe, runtimeInfo, selectConnection } from "./connection";
const address = "http://127.0.0.1:8188";
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key)});
});
afterEach(() => vi.unstubAllGlobals());
it("preserves address discovery and one request while returning metadata separately", async () => {
  const data = {system: {comfyui_version: "0.43.0", pytorch_version: "2.13.0"}, devices: []};
  const fetcher = vi.fn(async () => new Response(JSON.stringify(data), {status: 200}));
  vi.stubGlobal("fetch", fetcher);
  expect(await probe(address)).toBe(address);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await runtimeInfo(address)).toEqual(data);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await discover(address)).toEqual([address]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("propagates an explicit abort instead of changing the selected connection", async () => {
  selectConnection("http://127.0.0.1:9999");
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {throw init?.signal?.reason;});
  vi.stubGlobal("fetch", fetcher);
  await expect(runtimeInfo(address, controller.signal)).rejects.toMatchObject({name: "AbortError"});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(endpoint()).toBe("http://127.0.0.1:9999");
});
it("keeps the supplied timeout active in the metadata probe", async () => {
  const fetcher = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), {once: true});
  }));
  vi.stubGlobal("fetch", fetcher);
  await expect(runtimeInfo(address, undefined, 1)).rejects.toThrow("Couldn't connect to ComfyUI.");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
