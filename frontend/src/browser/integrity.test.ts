import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "./catalog";
import { selectConnection } from "./connection";
import { allowUnverified, allowsUnverified, clearUnverified, currentIntegrityPair, failureScope, integrityBusy, pairIntegrity, unpairIntegrity, verifiedSnapshots, verifyModelSnapshots } from "./integrity";

const address = "http://127.0.0.1:8196";
const model = catalog[0].models.flash[0];
const job = "a".repeat(24);
beforeEach(() => {
  const values = new Map<string, string>([["marcostudio.connection.v1", address]]);
  vi.stubGlobal("localStorage", {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)});
  clearUnverified(); unpairIntegrity();
});
afterEach(() => { clearUnverified(); unpairIntegrity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires a paired verification and rechecks each snapshot before allowing it", async () => {
  let state = "checksum_matched";
  const requests: {url: string; init?: RequestInit}[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({url: String(url), init});
    return new Response(JSON.stringify(String(url).includes("/integrity-failures?") ? {failed: []} : String(url).endsWith("/integrity") ? {state: "accepted", job} : {state, checked_at: "2026-10-30T18:00:00+00:00"}), {status: 200});
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
  selectConnection("http://127.0.0.1:8197");
  selectConnection(address);
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
  selectConnection("http://127.0.0.1:8197");
  expect(currentIntegrityPair("http://127.0.0.1:8197")).toBeUndefined();
  selectConnection(address);
  expect(currentIntegrityPair(address)).toBeUndefined();
  pairIntegrity(address, "owner-secret");
  unpairIntegrity();
  expect(currentIntegrityPair(address)).toBeUndefined();
});


it("invalidates consent when the connection or helper instance changes", async () => {
  const other = catalog[0].models.flash[4];
  let instance = "instance_a";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({version: 1, integrity_verification: 0, integrity_busy: false, integrity_instance: instance}), {status: 200})));
  await allowUnverified(address, [other]);
  expect(allowsUnverified(address, other.sha256)).toBe(true);
  instance = "instance_b";
  expect((await integrityBusy(address)).state).toBe("idle");
  expect(allowsUnverified(address, other.sha256)).toBe(false);
  instance = "instance_a";
  await integrityBusy(address);
  expect(allowsUnverified(address, other.sha256)).toBe(false);
  await allowUnverified(address, [other]);
  selectConnection("http://127.0.0.1:8197");
  currentIntegrityPair("http://127.0.0.1:8197");
  selectConnection(address);
  currentIntegrityPair(address);
  expect(allowsUnverified(address, other.sha256)).toBe(false);
});

it("requires pairing and blocks the selected model when another tab recorded a failure", async () => {
  const other = catalog[0].models.flash[1];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/integrity-failures?") ? {failed: [other.sha256]} : {version: 1, integrity_verification: 1, integrity_busy: false, integrity_failure_lookup: 1, integrity_instance: "instance_a"}), {status: 200})));
  await expect(allowUnverified(address, [other])).rejects.toThrow(/Pair the helper/);
  pairIntegrity(address, "owner-secret");
  await expect(allowUnverified(address, [other])).rejects.toThrow(/failed or active/);
  expect(allowsUnverified(address, other.sha256)).toBe(false);
});

it("allows a paired user to continue for models disjoint from another failure", async () => {
  const failedModel = catalog[0].models.flash[1], other = catalog[0].models.flash[4];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    const body = path.includes("/integrity-failures?") ? {failed: path.includes(failedModel.sha256) ? [failedModel.sha256] : []}
      : {version: 1, integrity_verification: 1, integrity_busy: false, integrity_failure_lookup: 1, integrity_instance: "instance_a"};
    return new Response(JSON.stringify(body), {status: 200});
  }));
  pairIntegrity(address, "owner-secret");
  await allowUnverified(address, [other]);
  expect(allowsUnverified(address, other.sha256)).toBe(true);
});

it("uses independent persisted keys for distinct model failures", async () => {
  const first = catalog[0].models.flash[1], second = catalog[0].models.flash[2];
  const writes = vi.spyOn(localStorage, "setItem");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/integrity-failures?") ? {failed: []} : String(url).endsWith("/integrity") ? {state: "accepted", job} : {state: "hash_mismatch"}), {status: 200})));
  pairIntegrity(address, "owner-secret");
  await Promise.allSettled([verifyModelSnapshots(address, [first], () => {}), verifyModelSnapshots(address, [second], () => {})]);
  const keys = writes.mock.calls.map(([key]) => key).filter(key => key.startsWith("marcostudio.integrity.failure.v2:"));
  expect(new Set(keys).size).toBe(2);
});

it("lets an authenticated helper failure override an earlier matching job", async () => {
  const other = catalog[0].models.flash[0];
  let failed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    const body = path.includes("/integrity-failures?") ? {failed: failed ? [other.sha256] : []}
      : path.endsWith("/integrity") ? {state: "accepted", job}
      : {state: "checksum_matched", checked_at: "2026-10-30T18:00:00+00:00"};
    return new Response(JSON.stringify(body), {status: 200});
  }));
  pairIntegrity(address, "owner-secret");
  await verifyModelSnapshots(address, [other], () => {});
  expect((await verifiedSnapshots(address, [other])).has(other.sha256)).toBe(true);
  failed = true;
  expect((await verifiedSnapshots(address, [other])).size).toBe(0);
});


it("does not restore stale consent after a deferred A→B→A connection change", async () => {
  const other = {...catalog[0].models.flash[2], sha256: "d".repeat(64)};
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {release = resolve;})));
  const pending = allowUnverified(address, [other]);
  selectConnection("http://127.0.0.1:8197");
  selectConnection(address);
  release(new Response(null, {status: 404}));
  await expect(pending).rejects.toThrow(/connection or pairing changed/);
  expect(allowsUnverified(address, other.sha256)).toBe(false);
});


it("does not let a deferred A failure lookup unpair a newer B connection", async () => {
  const firstModel = {...model, sha256: "e".repeat(64)};
  const otherAddress = "http://127.0.0.1:8197";
  let release!: (response: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => {started = resolve;});
  vi.stubGlobal("fetch", vi.fn(() => {started(); return new Promise<Response>(resolve => {release = resolve;});}));
  pairIntegrity(address, "first-secret");
  const pending = failureScope(address, [firstModel]);
  await requestStarted;
  selectConnection(otherAddress);
  pairIntegrity(otherAddress, "second-secret");
  release(new Response(JSON.stringify({failed: [firstModel.sha256]}), {status: 200}));
  expect(await pending).toBe("unknown");
  expect(currentIntegrityPair(otherAddress)?.token).toBe("second-secret");
  expect(localStorage.getItem("marcostudio.integrity.failure.v2:" + encodeURIComponent(address) + ":" + firstModel.sha256)).toBeNull();
});

it("does not let a late A capability failure clear B's consent", async () => {
  const other = {...model, sha256: "f".repeat(64)};
  const b = "http://127.0.0.1:8197";
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => String(url).startsWith(address)
    ? new Promise<Response>(resolve => {release = resolve;})
    : Promise.resolve(new Response(null, {status: 404}))));
  const stale = integrityBusy(address);
  selectConnection(b);
  await allowUnverified(b, [other]);
  expect(allowsUnverified(b, other.sha256)).toBe(true);
  release(new Response(null, {status: 503}));
  expect((await stale).state).toBe("unknown");
  expect(allowsUnverified(b, other.sha256)).toBe(true);
});
