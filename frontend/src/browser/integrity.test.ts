import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { catalog } from "./catalog";
import { pairIntegrity, unpairIntegrity, verifiedSnapshots, verifyModelSnapshots } from "./integrity";

const address = "http://127.0.0.1:8196";
const model = catalog[0].models.flash[0];
const job = "a".repeat(24);
afterEach(() => { unpairIntegrity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
