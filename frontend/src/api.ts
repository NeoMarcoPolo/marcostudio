export type Direction =
  | "top"
  | "front"
  | "right"
  | "left"
  | "back"
  | "bottom"
  | "custom";
export interface RelightSettings {
  direction: Direction;
  azimuth?: number;
  elevation?: number;
  softness: "soft" | "hard";
  brightness: number;
  color: string;
  mode: "flash";
  seed: number;
}
export interface Asset {
  id: string;
  url: string;
  width: number;
  height: number;
  media_type: string;
  filename: string;
}
export interface Job {
  id: string;
  status: string;
  settings: RelightSettings;
  source_id: string;
  outputs: Asset[];
  error: string | null;
  created_at: string;
  updated_at: string;
  progress: number | null;
  elapsed_seconds: number | null;
  queue_seconds: number | null;
}
export interface Feature {
  id: string;
  name: string;
  supported_modes: string[];
  defaults: RelightSettings;
}
export interface StudioSettings {
  comfy_url: string;
  proxy_url: string | null;
  comfy_dir: string | null;
  data_dir: string;
  transport: string;
}
export interface Doctor {
  ready: boolean;
  checks: { name: string; status: "pass" | "fail" | "warn"; message: string }[];
}
export class ServiceError extends Error {
  constructor(
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ServiceError(
      "Cannot reach the studio service. Check the connection and try again.",
      true,
    );
  }
  if (!response.ok) {
    let message = `The request could not be completed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      else if (Array.isArray(body.detail))
        message = body.detail
          .map((item: { msg?: string }) => item.msg || "Invalid value")
          .join("; ");
    } catch {
      /* Keep the HTTP fallback. */
    }
    throw new ServiceError(
      message,
      init?.method?.toUpperCase() === "POST" && response.status >= 500,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ServiceError(
      "The studio service returned an unreadable response.",
      true,
    );
  }
}
export function post<T>(url: string, body: unknown) {
  return api<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export const active = (job: Job) =>
  [
    "preparing",
    "submitting",
    "queued",
    "running",
    "cancel_requested",
    "needs_attention",
  ].includes(job.status);
