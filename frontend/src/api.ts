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
export type CreativeFeatureId = "create-image" | "edit-image" | "ai-stylist" | "product-scene"
  | "create-video" | "animate-image" | "transition" | "restyle-video" | "character-swap" | "keyframes" | "motion-control";
export type FeatureId = "relight" | "remove-background" | CreativeFeatureId;
export interface CreativeSettings {
  mode: "standard" | "flash";
  seed: number;
  instruction: string;
  width: number;
  height: number;
  negative_prompt?: "";
  resolution?: number;
  duration?: number;
  guide_frames?: number[];
  control_type?: "canny" | "preprocessed";
  strength?: number;
}
export interface RemoveBackgroundSettings {
  mode: "standard";
  seed: number;
}

export function videoFrames(duration: number) {
  return duration * 24 + ((5 - (duration * 24) % 17 + 17) % 17);
}

export interface Asset {
  id: string;
  url: string;
  width: number;
  height: number;
  media_type: string;
  filename: string;
  duration?: number;
  fps?: number;
}
interface JobBase {
  id: string;
  status: string;
  source_id: string | null;
  inputs?: Record<string, string>;
  outputs: Asset[];
  error: string | null;
  created_at: string;
  updated_at: string;
  progress: number | null;
  elapsed_seconds: number | null;
  queue_seconds: number | null;
}
export type Job = JobBase &
  (
    | { feature: "relight"; settings: RelightSettings }
    | { feature: "remove-background"; settings: RemoveBackgroundSettings }
    | { feature: CreativeFeatureId; settings: CreativeSettings }
  );
export interface Feature {
  id: FeatureId;
  name: string;
  supported_modes: string[];
  defaults: RelightSettings | RemoveBackgroundSettings | CreativeSettings;
  source_kind?: "image" | "video" | "none";
  source_label?: string;
  output_kind?: "image" | "video";
  input_slots?: {key: string; label: string; kind: "image" | "video"; required: boolean}[];
}
export interface StudioSettings {
  comfy_url: string;
  proxy_url: string | null;
  comfy_dir: string | null;
  data_dir: string;
  transport: string;
  restore_connection?: {comfy_url: string; proxy_url: string} | null;
}
export interface Doctor {
  ready: boolean;
  checks: { name: string; status: "pass" | "fail" | "warn"; message: string }[];
  model_requirements?: {filename: string; category: string; url: string; size: number; available: boolean}[];
}
export class ServiceError extends Error {
  constructor(
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
let browserTransport: (<T>(url: string, init?: RequestInit) => Promise<T>) | undefined;
export const isBrowserRuntime = () => !!browserTransport;
export function useBrowserRuntime(transport: typeof browserTransport) { browserTransport = transport; }
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  if (browserTransport) return browserTransport<T>(url, init);
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
