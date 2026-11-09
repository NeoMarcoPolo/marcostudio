import { ServiceError } from "../api";

export const CONNECTION_KEY = "marcostudio.connection.v1";
export const CONNECTION_DRAFT_KEY = "marcostudio.connection.draft.v1";
let connectionGeneration = 0;
export const currentConnectionGeneration = () => connectionGeneration;
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === CONNECTION_KEY) connectionGeneration++;
});
export const endpoint = () => localStorage.getItem(CONNECTION_KEY) || "";
export function normalizeAddress(address: string) {
  const url = new URL(address.includes("://") ? address : `http://${address}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Use a ComfyUI HTTP or HTTPS address without credentials.");
  return url.href.replace(/\/+$/, "");
}

export async function request<T>(address: string, path: string, init: RequestInit = {}, timeout = 15000): Promise<T> {
  if (!address) throw new ServiceError("Connect ComfyUI first.");
  let response: Response;
  const timer = AbortSignal.timeout(timeout);
  try {
    response = await fetch(`${address}${path}`, {
      ...init, credentials: "omit", cache: "no-store", redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, timer]) : timer,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ServiceError("Couldn't connect to ComfyUI.", init.method === "POST");
  }
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) {
    const reason = typeof body === "string" ? body.slice(0, 500)
      : body?.error?.message || body?.error || body?.detail;
    throw new ServiceError(typeof reason === "string" ? reason : `ComfyUI returned ${response.status}.`,
      init.method === "POST" && response.status >= 500);
  }
  return body as T;
}

export function send<T>(address: string, path: string, body: unknown) {
  return request<T>(address, path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
}

export async function runtimeInfo(address: string, signal?: AbortSignal, timeout = 4000) {
  const data = await request<{system?: {comfyui_version?: string; pytorch_version?: unknown}; devices?: unknown[]}>(address, "/system_stats", {signal}, timeout);
  if (!data?.system || typeof data.system.comfyui_version !== "string" || !Array.isArray(data.devices))
    throw new Error("This address didn't respond as ComfyUI.");
  return data;
}

export async function probe(address: string, signal?: AbortSignal, timeout = 4000) {
  await runtimeInfo(address, signal, timeout);
  return address;
}

export const DEFAULT_ADDRESSES = ["http://127.0.0.1:8188", "http://127.0.0.1:8000"];
const CONNECT_FAILED = "Couldn't connect to ComfyUI.";

// Why a connection failed, named only when the browser gives evidence for it:
// "permission" when local-network access is denied, "cors" when something
// answers a no-cors request but the readable request fails, else "unreachable".
// A no-cors answer proves only that some server listens there, so callers name
// the answering address instead of asserting it is ComfyUI.
export type ConnectionReason = "permission" | "cors" | "unreachable";
export class ConnectionFailure extends Error {
  constructor(readonly reason: ConnectionReason, readonly tried: string[], readonly answered: string[] = []) {
    super(CONNECT_FAILED);
    this.name = "ConnectionFailure";
  }
}

// Chrome 156 accepts all three names; other browsers throw for unknown names.
const PERMISSION_NAMES = ["loopback-network", "local-network", "local-network-access"];
async function localNetworkDenied() {
  for (const name of PERMISSION_NAMES) {
    try {
      if ((await navigator.permissions.query({name} as unknown as PermissionDescriptor)).state === "denied") return true;
    } catch { /* Unsupported name or no Permissions API. */ }
  }
  return false;
}

async function answersWithoutCors(address: string) {
  try {
    await fetch(`${address}/system_stats`, {mode: "no-cors", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(3000)});
    return true;
  } catch { return false; }
}

export async function diagnose(tried: string[]) {
  if (await localNetworkDenied()) return new ConnectionFailure("permission", tried);
  const answers = await Promise.all(tried.map(answersWithoutCors));
  const answered = tried.filter((_, index) => answers[index]);
  return new ConnectionFailure(answered.length ? "cors" : "unreachable", tried, answered);
}

export async function discover(address?: string) {
  const saved = endpoint();
  const candidates = address ? [normalizeAddress(address)] : saved ? [saved] : DEFAULT_ADDRESSES;
  const results = await Promise.allSettled(candidates.map(value => probe(value, undefined, 30000)));
  const found = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (found.length) return found;
  // One chosen address that answered as something other than ComfyUI has a
  // more useful message than a network diagnosis. Default ports are skipped:
  // an unrelated server on port 8000 must not hide a stopped ComfyUI on 8188.
  const [only] = results;
  if (candidates.length === 1 && only.status === "rejected" && only.reason instanceof Error
    && only.reason.message !== CONNECT_FAILED) throw only.reason;
  throw await diagnose(candidates);
}

export function selectConnection(address: string) {
  connectionGeneration++;
  localStorage.setItem(CONNECTION_KEY, normalizeAddress(address));
  localStorage.removeItem(CONNECTION_DRAFT_KEY);
}

export function clientId() {
  const key = "marcostudio.client.v1";
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}
