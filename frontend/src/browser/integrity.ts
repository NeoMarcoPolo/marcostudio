import { catalog, type Model } from "./catalog";
import { currentConnectionGeneration, endpoint, request } from "./connection";
import { canPairStorage } from "./modelSpace";

type Pair = {address: string; token: string};
type CheckState = "matched" | "unverified" | "blocked" | "active";
type Job = {id: string; active: boolean};
const BAD_PREFIX = "marcostudio.integrity.failure.v2:";
let persistenceUnsafe = false;
let paired: Pair | undefined;
let allowed: {address: string; ids: Set<string>; instance?: string; connection: number} | undefined;
let consentGeneration = 0;
let observedAddress: string | undefined;
let observedInstance: {address: string; instance?: string} | undefined;
const jobs = new Map<string, Job>();
const memoryBad = new Map<string, string>();
const keyFor = (address: string, id: string) => JSON.stringify([address, id]);
const badStates = new Set(["hash_mismatch", "size_mismatch", "changed"]);
const storageKey = (address: string, id: string) => BAD_PREFIX + encodeURIComponent(address) + ":" + id;

function rememberBad(address: string, id: string, state: string) {
  memoryBad.set(keyFor(address, id), state);
  try { localStorage.setItem(storageKey(address, id), state); }
  catch { persistenceUnsafe = true; console.warn("Could not persist a model verification failure."); }
}
function clearBad(address: string, id: string) {
  try { localStorage.removeItem(storageKey(address, id)); memoryBad.delete(keyFor(address, id)); }
  catch { persistenceUnsafe = true; console.warn("Could not clear a saved model verification failure."); }
}
function isBad(address: string, id: string): boolean {
  try {
    if (persistenceUnsafe || memoryBad.has(keyFor(address, id))) return true;
    const stored = localStorage.getItem(storageKey(address, id));
    // Any unknown stored value is a failure, not permission to proceed.
    return stored !== null;
  } catch { console.warn("Could not read saved model verification failures."); return true; }
}

// Pairing code and consent are held in page memory only; a reload resets consent.
export function pairIntegrity(address: string, token: string) {
  if (!canPairStorage(address) || !token) throw new Error("Verification pairing unavailable.");
  if (!paired || paired.address !== address || paired.token !== token) {
    clearUnverified();
    if (paired) unpairIntegrity();
  }
  observedAddress = address;
  paired = {address, token};
}
export function currentIntegrityPair(address: string): Pair | undefined {
  // A late result from a previous endpoint must never unpair the current one.
  if (endpoint() !== address) return undefined;
  if (observedAddress !== undefined && observedAddress !== address) clearUnverified();
  observedAddress = address;
  if (paired && paired.address !== address) unpairIntegrity();
  return paired?.address === address ? paired : undefined;
}
export function unpairIntegrity() {
  clearUnverified();
  paired = undefined;
  // Retain only outstanding jobs to avoid silently bypassing active work.
  for (const [key, job] of jobs) if (!job.active) jobs.delete(key);
}
export function clearUnverified() { allowed = undefined; observedInstance = undefined; consentGeneration++; }
export function allowsUnverified(address: string, id: string, instance?: string | null): boolean {
  return allowed?.address === address && allowed.connection === currentConnectionGeneration() && allowed.ids.has(id) && !isBad(address, id)
    && (instance === undefined || allowed.instance === (instance ?? undefined));
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

function captureContext(address: string) {
  return {address, pair: paired, connection: currentConnectionGeneration(), consent: consentGeneration};
}
function contextCurrent(context: ReturnType<typeof captureContext>): boolean {
  return endpoint() === context.address && currentConnectionGeneration() === context.connection
    && consentGeneration === context.consent && paired === context.pair;
}

async function remoteFailureSet(address: string, models: Model[], signal?: AbortSignal): Promise<Set<string> | null> {
  const pair = currentIntegrityPair(address);
  if (!pair || !models.length) return null;
  const context = captureContext(address);
  try {
    const ids = [...new Set(models.map(model => model.sha256))];
    const query = new URLSearchParams({ids: ids.join(","), catalog: await digestCatalog()});
    if (!contextCurrent(context)) return null;
    const result = await request<{failed?: unknown}>(address, `/marcostudio/integrity-failures?${query}`, {headers: {Authorization: `Bearer ${pair.token}`}, signal});
    if (!Array.isArray(result?.failed) || result.failed.some(id => typeof id !== "string" || !ids.includes(id)) || !contextCurrent(context)) return null;
    const failed = new Set(result.failed as string[]);
    for (const id of failed) rememberBad(address, id, "changed");
    return failed;
  } catch (error) { if (signal?.aborted) throw error; console.warn("Could not check model failure history."); return null; }
}
export async function integrityStates(address: string, models: Model[], signal?: AbortSignal): Promise<Map<string, CheckState>> {
  const states = new Map<string, CheckState>();
  const pair = currentIntegrityPair(address);
  const context = captureContext(address);
  const remoteFailures = pair && models.length ? await remoteFailureSet(address, models, signal) : null;
  await Promise.all(models.map(async model => {
    const key = keyFor(address, model.sha256), job = jobs.get(key);
    let state: CheckState = isBad(address, model.sha256) ? "blocked" : job?.active ? "active" : "unverified";
    if (job && pair && remoteFailures && contextCurrent(context) && !remoteFailures.has(model.sha256)) {
      try {
        const result = await status(address, pair.token, job.id, signal);
        if (!contextCurrent(context)) { states.set(model.sha256, "unverified"); return; }
        if (result.state === "checksum_matched") { job.active = false; clearBad(address, model.sha256); state = isBad(address, model.sha256) ? "blocked" : "matched"; }
        else if (badStates.has(result.state)) { job.active = false; rememberBad(address, model.sha256, result.state); state = "blocked"; }
        else if (result.state === "queued" || result.state === "running") { job.active = true; state = "active"; }
        else { job.active = false; state = isBad(address, model.sha256) ? "blocked" : "unverified"; }
      } catch (error) { if (signal?.aborted) throw error; console.warn("Could not check model verification status."); }
    }
    states.set(model.sha256, state);
  }));
  return states;
}
export async function verifiedSnapshots(address: string, models: Model[], signal?: AbortSignal): Promise<Set<string>> {
  const states = await integrityStates(address, models, signal);
  return new Set([...states].filter(([, state]) => state === "matched").map(([id]) => id));
}

function noteInstance(address: string, instance?: string) {
  if (observedInstance && (observedInstance.address !== address || observedInstance.instance !== instance)) clearUnverified();
  observedInstance = {address, instance};
}

// A helper without integrity support cannot run an integrity job. Unknown
// capability state is not assumed idle; a 404 denotes the manual-only case.
export async function integrityBusy(address: string, signal?: AbortSignal): Promise<{state: "idle" | "active" | "unknown"; instance?: string; helper?: boolean}> {
  const context = captureContext(address);
  if (!contextCurrent(context)) return {state: "unknown"};
  try {
    const response = await fetch(`${address}/marcostudio/capabilities`, {credentials: "omit", cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
    if (!contextCurrent(context)) return {state: "unknown"};
    if (response.status === 404) { noteInstance(address); return {state: "idle", helper: false}; }
    if (!response.ok) { clearUnverified(); return {state: "unknown"}; }
    const value = await response.json();
    if (!contextCurrent(context)) return {state: "unknown"};
    if (value?.version !== 1) { clearUnverified(); return {state: "unknown"}; }
    const instance = typeof value.integrity_instance === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.integrity_instance) ? value.integrity_instance : undefined;
    noteInstance(address, instance);
    if (value.integrity_verification !== 1) return {state: "idle", instance, helper: false};
    if (typeof value.integrity_busy !== "boolean" || value.integrity_failure_lookup !== 1 || !instance) { clearUnverified(); return {state: "unknown"}; }
    if (value.integrity_busy) clearUnverified();
    return {state: value.integrity_busy ? "active" : "idle", instance, helper: true};
  } catch (error) { if (contextCurrent(context)) clearUnverified(); if (signal?.aborted) throw error; return {state: "unknown"}; }
}
export async function failureScope(address: string, models: Model[], signal?: AbortSignal): Promise<"clear" | "failed" | "unknown"> {
  const failures = await remoteFailureSet(address, models, signal);
  return failures === null ? "unknown" : failures.size ? "failed" : "clear";
}
export async function allowUnverified(address: string, models: Model[]) {
  currentIntegrityPair(address);
  const generation = consentGeneration, connection = currentConnectionGeneration();
  if (endpoint() !== address) throw new Error("The ComfyUI connection changed. Review setup again.");
  const capability = await integrityBusy(address);
  if (connection !== currentConnectionGeneration() || endpoint() !== address) throw new Error("The ComfyUI connection or pairing changed. Review setup again.");
  if (!models.length || capability.state !== "idle") throw new Error("Wait for model verification to finish or restore the ComfyUI connection.");
  if (generation !== consentGeneration) throw new Error("The ComfyUI connection or pairing changed. Review setup again.");
  const states = await integrityStates(address, models);
  if (generation !== consentGeneration || connection !== currentConnectionGeneration() || endpoint() !== address) throw new Error("The ComfyUI connection or pairing changed. Review setup again.");
  if ([...states.values()].some(state => state === "blocked" || state === "active")) throw new Error("A model has a failed or active verification. Resolve it before continuing.");
  if (capability.helper && await failureScope(address, models) !== "clear") throw new Error("Pair the helper to check selected model failures before continuing.");
  if (generation !== consentGeneration || connection !== currentConnectionGeneration() || endpoint() !== address) throw new Error("The ComfyUI connection or pairing changed. Review setup again.");
  allowed = {address, instance: capability.instance, connection, ids: new Set(models.filter(model => states.get(model.sha256) === "unverified").map(model => model.sha256))};
}

export async function verifyModelSnapshots(address: string, models: Model[], progress: (message: string) => void, signal?: AbortSignal) {
  const pair = currentIntegrityPair(address);
  if (!pair || !canPairStorage(address)) throw new Error("Pair the verification helper first.");
  const context = captureContext(address);
  const token = pair.token, digest = await digestCatalog();
  if (!contextCurrent(context)) throw new Error("Verification cancelled.");
  const alreadyVerified = await verifiedSnapshots(address, models, signal);
  const pending = models.filter(model => !alreadyVerified.has(model.sha256));
  for (const [index, model] of pending.entries()) {
    if (signal?.aborted || !contextCurrent(context)) throw new Error("Verification cancelled.");
    progress(`Verifying model ${index + 1} of ${pending.length}: ${model.filename}…`);
    const response = await request<{state?: string; job?: string}>(address, "/marcostudio/integrity", {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({id: model.sha256, catalog: digest}), signal,
    });
    if (response?.state !== "accepted" || !response.job || !/^[A-Za-z0-9_-]{24}$/.test(response.job)) throw new Error(`Couldn't verify ${model.filename}.`);
    if (!contextCurrent(context)) {
      void request(address, `/marcostudio/integrity/${response.job}/cancel`, {method: "POST", headers: {Authorization: `Bearer ${token}`}}).catch(() => { console.warn("Could not cancel model verification."); });
      throw new Error("Verification cancelled.");
    }
    const job = response.job, key = keyFor(address, model.sha256);
    jobs.set(key, {id: job, active: true});
    try {
      while (true) {
        if (signal?.aborted || !contextCurrent(context)) throw new Error("Verification cancelled.");
        const current = await status(address, token, job, signal);
        if (!contextCurrent(context)) throw new Error("Verification cancelled.");
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
