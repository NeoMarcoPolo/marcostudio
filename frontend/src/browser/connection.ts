import { ServiceError } from "../api";

export const CONNECTION_KEY = "marcostudio.connection.v1";
export const CONNECTION_DRAFT_KEY = "marcostudio.connection.draft.v1";
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

export async function probe(address: string, signal?: AbortSignal, timeout = 4000) {
  const data = await request<{system?: {comfyui_version?: string}; devices?: unknown[]}>(address, "/system_stats", {signal}, timeout);
  if (!data?.system || typeof data.system.comfyui_version !== "string" || !Array.isArray(data.devices))
    throw new Error("This address didn't respond as ComfyUI.");
  return address;
}

export async function discover(address?: string) {
  const saved = endpoint();
  const candidates = address ? [normalizeAddress(address)] : saved ? [saved]
    : ["http://127.0.0.1:8188", "http://127.0.0.1:8000"];
  const results = await Promise.allSettled(candidates.map(value => probe(value, undefined, 30000)));
  const found = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (!found.length) throw new Error("Couldn't connect to ComfyUI.");
  return found;
}

export function selectConnection(address: string) {
  localStorage.setItem(CONNECTION_KEY, normalizeAddress(address));
  localStorage.removeItem(CONNECTION_DRAFT_KEY);
}

export function clientId() {
  const key = "marcostudio.client.v1";
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}
