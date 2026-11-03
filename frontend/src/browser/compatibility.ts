import type { Doctor } from "../api";

export const RELIGHT_PROFILE = "qwen2509-relight-flash-v1";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function deviceCompatibility(feature: string, profile: unknown, runtime: unknown): Doctor["checks"][number] | undefined {
  if (feature !== "relight") return undefined;
  const result = {name: "device:relight", status: "fail" as const, message: ""};
  const devices = object(runtime) ? runtime.devices : undefined;
  const primary = Array.isArray(devices) ? devices[0] : undefined;
  const kind = object(primary) && typeof primary.type === "string" ? primary.type.trim().toLowerCase() : undefined;
  if (kind === "cpu" || kind === "cuda") return {...result, status: "pass", message: `Selected ComfyUI device: ${kind}.`};
  if (kind !== "mps") return {...result, message: "Couldn't verify ComfyUI's selected device for Relight. Check the connected runtime's device metadata before generating."};
  if (profile !== RELIGHT_PROFILE) return {...result, message: "This Relight workflow's MPS compatibility has not been validated. Review its runtime profile before generating."};
  const system = object(runtime) && object(runtime.system) ? runtime.system : undefined;
  const raw = system?.pytorch_version;
  const version = typeof raw === "string" && raw.length <= 64 && /^[A-Za-z0-9.+_-]+$/.test(raw) ? raw : undefined;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:(?:a|b|rc)\d+|(?:\.dev|\.post)\d+)?(?:\+[A-Za-z0-9._-]+)?$/.exec(version ?? "");
  let message: string;
  if (!match) message = "Relight's current FP8 models and LoRAs are not validated on MPS, and its PyTorch version could not be verified. Choose a compatible runtime before generating.";
  else if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 15))
    message = `PyTorch 2.15 added MPS FP8 support (detected ${version}), but this Relight profile and its memory use remain unvalidated on MPS. MarcoStudio cannot mark it Ready.`;
  else message = `Relight's current FP8 models and LoRAs have known MPS failures with older PyTorch (detected ${version}). A validated Mac profile is not available yet. Choose a compatible runtime before generating.`;
  return {...result, message};
}
