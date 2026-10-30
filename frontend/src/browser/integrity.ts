import { catalog, type Model } from "./catalog";
import { request } from "./connection";
import { canPairStorage } from "./modelSpace";

type Pair = {address: string; token: string};
type CheckState = "matched" | "unverified" | "blocked" | "active";
type Job = {id: string; active: boolean};
const BAD_KEY = "marcostudio.integrity.failures.v1";
let persistenceUnsafe = false;
let paired: Pair | undefined;
let allowed: {address: string; ids: Set<string>} | undefined;
const jobs = new Map<string, Job>();
const memoryBad = new Map<string, string>();
const keyFor = (address: string, id: string) => JSON.stringify([address, id]);
const badStates = new Set(["hash_mismatch", "size_mismatch", "changed"]);

function readBad(): Record<string, string> | null {
  try {
    if (persistenceUnsafe) return null;
    const raw = localStorage.getItem(BAD_KEY);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => typeof item !== "string" || !badStates.has(item))) return null;
    return value as Record<string, string>;
  } catch { console.warn("Could not read saved model verification failures."); return null; }
}
function rememberBad(address: string, id: string, state: string) {
  const key = keyFor(address, id);
  memoryBad.set(key, state);
  const records = readBad();
  if (!records) return;
  try { records[key] = state; localStorage.setItem(BAD_KEY, JSON.stringify(records)); }
  catch { persistenceUnsafe = true; console.warn("Could not persist a model verification failure."); }
}
function clearBad(address: string, id: string) {
  const key = keyFor(address, id), records = readBad();
  if (!records) return;
  try { delete records[key]; localStorage.setItem(BAD_KEY, JSON.stringify(records)); memoryBad.delete(key); }
  catch { persistenceUnsafe = true; console.warn("Could not clear a saved model verification failure."); }
}
function isBad(address: string, id: string): boolean {
  const records = readBad(), key = keyFor(address, id);
  return records === null || memoryBad.has(key) || !!records[key];
}

// Pairing code and consent are held in page memory only; a reload resets consent.
export function pairIntegrity(address: string, token: string) {
  if (!canPairStorage(address) || !token) throw new Error("Verification pairing unavailable.");
  if (paired && (paired.address !== address || paired.token !== token)) unpairIntegrity();
  paired = {address, token};
}
export function currentIntegrityPair(address: string): Pair | undefined {
  if (paired && paired.address !== address) unpairIntegrity();
  return paired?.address === address ? paired : undefined;
}
export function unpairIntegrity() {
  paired = undefined;
  // Retain only outstanding jobs to avoid silently bypassing active work.
  for (const [key, job] of jobs) if (!job.active) jobs.delete(key);
}
export function clearUnverified() { allowed = undefined; }
export function allowsUnverified(address: string, id: string): boolean {
  return allowed?.address === address && allowed.ids.has(id) && !isBad(address, id);
}

async function digestCatalog(): Promise<string> {
  const records = new Map<string, [string, string, string, number, string, string]>();
  for (const feature of catalog) for (const models of Object.values(feature.models)) for (const model of models) {
    const row: [string, string, string, number, string, string] = [model.sha256, model.filename, model.category, model.size, model.loader, model.field];
    const previous = records.get(model.sha256);
    if (!/^[0-9a-f]{64}$/.test(model.sha256) || (previous && JSON.stringify(previous) !== JSON.stringify(row))) throw new Error("Model verification unavailable.");
    records.set(model.sha256, row);
  }
  const canonical = JSON.stringify([...records.values()].sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}
async function status(address: string, token: string, job: string, signal?: AbortSignal): Promise<{state: string; checkedAt?: string}> {
  if (!canPairStorage(address) || !/^[A-Za-z0-9_-]{24}$/.test(job)) return {state: "unavailable"};
  const timer = AbortSignal.timeout(15000);
  const response = await fetch(`${address}/marcostudio/integrity/${job}`, {
    headers: {Authorization: `Bearer ${token}`}, credentials: "omit", cache: "no-store", redirect: "error",
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
  });
  // A restarted helper has no old job; unlike a network/auth failure, this
  // explicit response can safely clear the old in-flight job marker.
  if (response.status === 404) return {state: "unavailable"};
  if (!response.ok) throw new Error("Couldn't check model verification.");
  const result: {state?: string; checked_at?: string} = await response.json();
  if (typeof result?.state !== "string") return {state: "unavailable"};
  if (result.state === "checksum_matched" && (typeof result.checked_at !== "string" || !Number.isFinite(Date.parse(result.checked_at)))) return {state: "unavailable"};
  return {state: result.state, checkedAt: result.checked_at};
}

export async function integrityStates(address: string, models: Model[], signal?: AbortSignal): Promise<Map<string, CheckState>> {
  const states = new Map<string, CheckState>();
  const pair = currentIntegrityPair(address);
  await Promise.all(models.map(async model => {
    const key = keyFor(address, model.sha256), job = jobs.get(key);
    let state: CheckState = isBad(address, model.sha256) ? "blocked" : job?.active ? "active" : "unverified";
    if (job && pair) {
      try {
        const result = await status(address, pair.token, job.id, signal);
        if (result.state === "checksum_matched") { job.active = false; clearBad(address, model.sha256); state = isBad(address, model.sha256) ? "blocked" : "matched"; }
        else if (badStates.has(result.state)) { job.active = false; rememberBad(address, model.sha256, result.state); state = "blocked"; }
        else if (result.state === "queued" || result.state === "running") { job.active = true; state = "active"; }
        else { job.active = false; state = isBad(address, model.sha256) ? "blocked" : "unverified"; }
      } catch (error) { if (signal?.aborted) throw error; }
    }
    states.set(model.sha256, state);
  }));
  return states;
}
export async function verifiedSnapshots(address: string, models: Model[], signal?: AbortSignal): Promise<Set<string>> {
  const states = await integrityStates(address, models, signal);
  return new Set([...states].filter(([, state]) => state === "matched").map(([id]) => id));
}

// A helper without integrity support cannot run an integrity job. Unknown
// capability state is not assumed idle; a 404 denotes the manual-only case.
export async function integrityBusy(address: string, signal?: AbortSignal): Promise<"idle" | "active" | "unknown"> {
  try {
    const response = await fetch(`${address}/marcostudio/capabilities`, {credentials: "omit", cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
    if (response.status === 404) return "idle";
    if (!response.ok) return "unknown";
    const value = await response.json();
    if (value?.version !== 1) return "unknown";
    if (value.integrity_verification !== 1) return "idle";
    return typeof value.integrity_busy === "boolean" ? value.integrity_busy ? "active" : "idle" : "unknown";
  } catch (error) { if (signal?.aborted) throw error; return "unknown"; }
}
export async function allowUnverified(address: string, models: Model[]) {
  if (!models.length || await integrityBusy(address) !== "idle") throw new Error("Wait for model verification to finish or restore the ComfyUI connection.");
  const states = await integrityStates(address, models);
  if ([...states.values()].some(state => state === "blocked" || state === "active")) throw new Error("A model has a failed or active verification. Resolve it before continuing.");
  allowed = {address, ids: new Set(models.filter(model => states.get(model.sha256) === "unverified").map(model => model.sha256))};
}

export async function verifyModelSnapshots(address: string, models: Model[], progress: (message: string) => void, signal?: AbortSignal) {
  const pair = currentIntegrityPair(address);
  if (!pair || !canPairStorage(address)) throw new Error("Pair the verification helper first.");
  const token = pair.token, digest = await digestCatalog();
  const alreadyVerified = await verifiedSnapshots(address, models, signal);
  const pending = models.filter(model => !alreadyVerified.has(model.sha256));
  for (const [index, model] of pending.entries()) {
    if (signal?.aborted || currentIntegrityPair(address)?.token !== token) throw new Error("Verification cancelled.");
    progress(`Verifying model ${index + 1} of ${pending.length}: ${model.filename}…`);
    const response = await request<{state?: string; job?: string}>(address, "/marcostudio/integrity", {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({id: model.sha256, catalog: digest}), signal,
    });
    if (response?.state !== "accepted" || !response.job || !/^[A-Za-z0-9_-]{24}$/.test(response.job)) throw new Error(`Couldn't verify ${model.filename}.`);
    const job = response.job, key = keyFor(address, model.sha256);
    jobs.set(key, {id: job, active: true});
    try {
      while (true) {
        if (signal?.aborted || currentIntegrityPair(address)?.token !== token) throw new Error("Verification cancelled.");
        const current = await status(address, token, job, signal);
        if (current.state === "checksum_matched") {
          jobs.get(key)!.active = false;
          clearBad(address, model.sha256);
          progress(`Checksum matched for ${model.filename} during the check at ${new Date(current.checkedAt!).toLocaleString()}. Files can change during or afterward.`);
          break;
        }
        if (current.state !== "queued" && current.state !== "running") {
          jobs.get(key)!.active = false;
          if (badStates.has(current.state)) rememberBad(address, model.sha256, current.state);
          throw new Error(`Verification of ${model.filename} did not complete (${current.state}).`);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      void request(address, `/marcostudio/integrity/${job}/cancel`, {method: "POST", headers: {Authorization: `Bearer ${token}`}}).catch(() => { console.warn("Could not cancel model verification."); });
      throw error;
    }
  }
  progress("Checksums matched during their last checks. Files can change during or afterward.");
}
