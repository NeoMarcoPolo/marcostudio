import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "./catalog";
import { allowUnverified, allowsUnverified, clearUnverified, currentIntegrityPair, pairIntegrity, unpairIntegrity, verifiedSnapshots, verifyModelSnapshots } from "./integrity";

const address = "http://127.0.0.1:8196";
const model = catalog[0].models.flash[0];
const job = "a".repeat(24);
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value)});
  clearUnverified(); unpairIntegrity();
});
afterEach(() => { clearUnverified(); unpairIntegrity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires a paired verification and rechecks each snapshot before allowing it", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let state = "checksum_matched";
  const requests: {url: string; init?: RequestInit}[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({url: String(url), init});
    return new Response(JSON.stringify(String(url).endsWith("/integrity") ? {state: "accepted", job} : {state, checked_at: "2026-10-30T18:00:00+00:00"}), {status: 200});
  }));
  expect((await verifiedSnapshots(address, [model])).size).toBe(0);
  pairIntegrity(address, "owner-secret");
  await verifyModelSnapshots(address, [model], () => {});
  expect((await verifiedSnapshots(address, [model])).has(model.sha256)).toBe(true);
  expect(requests.every(call => !call.url.includes("owner-secret"))).toBe(true);
  expect(requests.every(call => (call.init?.headers as Record<string, string>).Authorization === "Bearer owner-secret")).toBe(true);
  expect(String(requests[0].init?.body)).not.toContain("owner-secret");
  state = "changed";
  expect((await verifiedSnapshots(address, [model])).size).toBe(0);
  expect((await verifiedSnapshots("http://127.0.0.1:8197", [model])).size).toBe(0);
});

it("refuses a pairing code over non-loopback plain HTTP", () => {
  expect(() => pairIntegrity("http://192.0.2.5:8188", "owner-secret")).toThrow();
});


it("allows unverified use only after explicit consent for this address and models", async () => {
  const otherModel = catalog[0].models.flash[1];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {status: 404})));
  expect(allowsUnverified(address, otherModel.sha256)).toBe(false);
  await allowUnverified(address, [otherModel]);
  expect(allowsUnverified(address, otherModel.sha256)).toBe(true);
  expect((await verifiedSnapshots(address, [otherModel])).size).toBe(0);
  expect(allowsUnverified("http://127.0.0.1:8197", otherModel.sha256)).toBe(false);
  expect(allowsUnverified(address, model.sha256)).toBe(false);
  vi.resetModules();
  const freshSession = await import("./integrity");
  expect(freshSession.allowsUnverified(address, otherModel.sha256)).toBe(false);
  clearUnverified();
  expect(allowsUnverified(address, otherModel.sha256)).toBe(false);
});

it("rejects fallback when helper work is active or capability is unknown", async () => {
  const otherModel = catalog[0].models.flash[2];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({version: 1, integrity_verification: 1, integrity_busy: true}), {status: 200})));
  await expect(allowUnverified(address, [otherModel])).rejects.toThrow(/Wait for model verification/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {status: 503})));
  await expect(allowUnverified(address, [otherModel])).rejects.toThrow(/Wait for model verification/);
  expect(allowsUnverified(address, otherModel.sha256)).toBe(false);
});

it("keeps a known checksum failure blocked after unpairing", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const otherModel = catalog[0].models.flash[3];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith("/integrity") ? {state: "accepted", job} : {state: "hash_mismatch"}), {status: 200})));
  pairIntegrity(address, "owner-secret");
  await expect(verifyModelSnapshots(address, [otherModel], () => {})).rejects.toThrow(/hash_mismatch/);
  unpairIntegrity();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {status: 404})));
  await expect(allowUnverified(address, [otherModel])).rejects.toThrow(/failed or active/);
  expect(allowsUnverified(address, otherModel.sha256)).toBe(false);
  vi.resetModules();
  const freshSession = await import("./integrity");
  await expect(freshSession.allowUnverified(address, [otherModel])).rejects.toThrow(/failed or active/);
});

it("keeps a pair across modal lifetimes and clears it on unpair or address change", () => {
  pairIntegrity(address, "owner-secret");
  expect(currentIntegrityPair(address)?.token).toBe("owner-secret");
  expect(currentIntegrityPair("http://127.0.0.1:8197")).toBeUndefined();
  expect(currentIntegrityPair(address)).toBeUndefined();
  pairIntegrity(address, "owner-secret");
  unpairIntegrity();
  expect(currentIntegrityPair(address)).toBeUndefined();
});
