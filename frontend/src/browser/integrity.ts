import { catalog, type Model } from "./catalog";
import { request } from "./connection";
import { canPairStorage } from "./modelSpace";

// The owner code and job IDs live only in this page's memory; no URLs or storage.
let paired: {address: string; token: string} | undefined;
const jobs = new Map<string, string>();

export function pairIntegrity(address: string, token: string) {
  if (!canPairStorage(address) || !token) throw new Error("Verification pairing unavailable.");
  if (paired?.address !== address || paired.token !== token) jobs.clear();
  paired = {address, token};
}
export function unpairIntegrity() { paired = undefined; jobs.clear(); }

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

async function status(address: string, token: string, job: string, signal?: AbortSignal): Promise<string> {
  if (!canPairStorage(address) || !/^[A-Za-z0-9_-]{24}$/.test(job)) return "unavailable";
  const result = await request<{state?: string}>(address, `/marcostudio/integrity/${job}`, {headers: {Authorization: `Bearer ${token}`}, signal});
  return typeof result?.state === "string" ? result.state : "unavailable";
}

export async function verifiedSnapshots(address: string, models: Model[], signal?: AbortSignal): Promise<Set<string>> {
  const result = new Set<string>();
  if (!paired || paired.address !== address || !canPairStorage(address)) return result;
  const token = paired.token;
  await Promise.all(models.map(async model => {
    const job = jobs.get(model.sha256);
    if (!job) return;
    try { if (await status(address, token, job, signal) === "snapshot_verified" && paired?.address === address && paired.token === token) result.add(model.sha256); }
    catch (error) { if (signal?.aborted) throw error; }
  }));
  return result;
}

export async function verifyModelSnapshots(address: string, models: Model[], progress: (message: string) => void, signal?: AbortSignal) {
  if (!paired || paired.address !== address || !canPairStorage(address)) throw new Error("Pair the verification helper first.");
  const token = paired.token, digest = await digestCatalog();
  const alreadyVerified = await verifiedSnapshots(address, models, signal);
  const pending = models.filter(model => !alreadyVerified.has(model.sha256));
  for (const [index, model] of pending.entries()) {
    if (signal?.aborted || paired?.address !== address || paired.token !== token) throw new Error("Verification cancelled.");
    progress(`Verifying model ${index + 1} of ${pending.length}: ${model.filename}…`);
    const response = await request<{state?: string; job?: string}>(address, "/marcostudio/integrity", {
      method: "POST", headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({id: model.sha256, catalog: digest}), signal,
    });
    if (response?.state !== "accepted" || !response.job || !/^[A-Za-z0-9_-]{24}$/.test(response.job)) throw new Error(`Couldn't verify ${model.filename}.`);
    const job = response.job;
    jobs.set(model.sha256, job);
    try {
      while (true) {
        if (signal?.aborted || paired?.address !== address || paired.token !== token) throw new Error("Verification cancelled.");
        const current = await status(address, token, job, signal);
        if (current === "snapshot_verified") break;
        if (current !== "queued" && current !== "running") throw new Error(`Verification of ${model.filename} did not complete (${current}).`);
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      jobs.delete(model.sha256);
      void request(address, `/marcostudio/integrity/${job}/cancel`, {method: "POST", headers: {Authorization: `Bearer ${token}`}}).catch(() => { console.warn("Could not cancel model verification."); });
      throw error;
    }
  }
  progress("Models verified at this moment. Files can change afterward.");
}
