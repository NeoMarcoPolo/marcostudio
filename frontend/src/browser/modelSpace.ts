import type { Model } from "./catalog";
import { request } from "./connection";

export interface SpaceEntry {id: string; status: "available" | "unavailable"; available_bytes?: number; volume?: string}
export interface SpaceReport {version: 1; models: SpaceEntry[]}

// A bearer token is only sent over TLS or to literal loopback HTTP. Do not
// let URL's IP normalization silently admit alternate spellings of loopback.
export function canPairStorage(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(address);
  } catch { return false; }
}

export async function supportsStoragePairing(address: string): Promise<boolean> {
  if (!canPairStorage(address)) return false;
  try {
    const capability = await request<{version: number; storage_pairing?: number}>(address, "/marcostudio/capabilities");
    return capability?.version === 1 && capability.storage_pairing === 1;
  } catch { return false; }
}

export async function checkStorage(address: string, token: string, models: Model[]): Promise<SpaceReport> {
  if (!canPairStorage(address) || !token || !models.length) throw new Error("Disk space check unavailable.");
  const ids = [...new Set(models.map(model => model.sha256))];
  if (ids.some(id => !/^[0-9a-f]{64}$/.test(id))) throw new Error("Disk space check unavailable.");
  const query = new URLSearchParams({ids: ids.join(",")});
  const response = await request<SpaceReport>(address, `/marcostudio/storage?${query}`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  if (response?.version !== 1 || !Array.isArray(response.models) || response.models.length !== ids.length) throw new Error("Disk space check unavailable.");
  const seen = new Set<string>();
  for (const entry of response.models) {
    if (!entry || !ids.includes(entry.id) || seen.has(entry.id) || !["available", "unavailable"].includes(entry.status)) throw new Error("Disk space check unavailable.");
    if (entry.status === "available" && (!Number.isSafeInteger(entry.available_bytes) || entry.available_bytes! < 0 || typeof entry.volume !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.volume))) throw new Error("Disk space check unavailable.");
    seen.add(entry.id);
  }
  return response;
}

export function spaceGroups(models: Model[], report: SpaceReport) {
  const groups = new Map<string, {available: number; needed: number; names: string[]}>();
  let unknown = false;
  for (const model of models) {
    const entry = report.models.find(item => item.id === model.sha256);
    if (!entry || entry.status !== "available" || !entry.volume || entry.available_bytes === undefined) { unknown = true; continue; }
    const previous = groups.get(entry.volume);
    const group = previous ?? {available: entry.available_bytes, needed: 0, names: []};
    group.available = Math.min(group.available, entry.available_bytes);
    group.needed += model.size; group.names.push(model.filename); groups.set(entry.volume, group);
  }
  return {groups: [...groups.values()], unknown};
}
