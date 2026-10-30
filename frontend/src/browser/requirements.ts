import type { Doctor, FeatureId } from "../api";
import { getFeature, resolveTemplate, type Graph, type Model } from "./catalog";
import { endpoint, probe, request } from "./connection";
import { installTasks, reconcileInstalls, saveInstallTasks } from "./manager";
import { allowsUnverified, clearUnverified, failureScope, integrityBusy, integrityStates } from "./integrity";

type Spec = [unknown, Record<string, unknown>?];
type Definition = {input?: {required?: Record<string, Spec>; optional?: Record<string, Spec>}};
export interface Requirements extends Doctor {
  connected: boolean;
  address: string;
  model_requirements: (Model & {available: boolean; resolved?: string; installable: boolean})[];
  missing_nodes: string[];
  models: Record<string, string>;
}

// The loader lists a filename as soon as Manager creates it, before download
// completion. Query the whole Manager queue, not the current browser's client
// ID: another browser may have started the download. A 404 is the supported
// manual-install case; other failures do not prove the queue is idle.
async function checkManagerQueue(address: string, signal?: AbortSignal): Promise<"idle" | "active" | "unsupported" | "unknown"> {
  try {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(`${address}/v2/manager/queue/status`, {
      credentials: "omit", cache: "no-store", redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 404) return "unsupported";
    if (!response.ok) return "unknown";
    const status = await response.json();
    if (!Number.isInteger(status?.pending_count) || status.pending_count < 0
      || !Number.isInteger(status?.in_progress_count) || status.in_progress_count < 0
      || typeof status?.is_processing !== "boolean") return "unknown";
    return status.pending_count > 0 || status.in_progress_count > 0 || status.is_processing ? "active" : "idle";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unknown";
  }
}

function validateNode(node: Graph[string], definition: Definition, models: Model[]) {
  const fields = {...definition.input?.required, ...definition.input?.optional};
  const required = new Set(Object.keys(definition.input?.required ?? {}));
  const pending = Object.keys(fields);
  while (pending.length) {
    const key = pending.pop()!, spec = fields[key];
    if (!Array.isArray(spec) || !spec.length) throw new Error(`Invalid input definition: ${key}`);
    if (spec[0] === "COMFY_AUTOGROW_V3") {
      const template = spec[1]?.template as {input: {required: Record<string, Spec>}; names?: string[]; prefix: string; max: number; min?: number};
      const names = (template.names ?? Array.from({length: template.max}, (_, i) => `${template.prefix}${i}`)).map(name => `${key}.${name}`);
      delete fields[key]; required.delete(key);
      for (const name of names) fields[name] = Object.values(template.input.required)[0];
      if (names.filter(name => name in node.inputs).length < (template.min ?? 0)) throw new Error(`Missing ${key} inputs`);
    } else if (spec[0] === "COMFY_DYNAMICCOMBO_V3") {
      const options = spec[1]?.options as {key: string; inputs?: Definition["input"]}[];
      fields[key] = ["COMBO", {options: options.map(o => o.key)}];
      const selected = options.find(option => option.key === node.inputs[key]);
      if (!selected) continue;
      for (const group of ["required", "optional"] as const) {
        for (const [name, field] of Object.entries(selected.inputs?.[group] ?? {})) {
          const child = `${key}.${name}`; fields[child] = field; pending.push(child);
          if (group === "required") required.add(child);
        }
      }
    }
  }
  for (const key of required) if (!(key in node.inputs)) throw new Error(`Required input changed: ${key}`);
  for (const [key, value] of Object.entries(node.inputs)) {
    const spec = fields[key];
    if (!spec) throw new Error(`Input not supported: ${key}`);
    if (Array.isArray(value) || models.some(m => m.loader === node.class_type && m.field === key)
      || (node.class_type === "LoadImage" && key === "image") || (node.class_type === "LoadVideo" && key === "file")) continue;
    const [kind, limits = {}] = spec;
    const choices = Array.isArray(kind) ? kind : kind === "COMBO" ? limits.options as unknown[] : undefined;
    if (choices && !choices.includes(value)) throw new Error(`Unsupported ${key}: ${value}`);
    if (kind === "INT" && !Number.isInteger(value)) throw new Error(`Invalid ${key}`);
    if (typeof value === "number" && (value < Number(limits.min ?? -Infinity) || value > Number(limits.max ?? Infinity))) throw new Error(`Unsupported ${key} range`);
  }
}

export async function checkRequirements(id: FeatureId, mode: string, signal?: AbortSignal): Promise<Requirements> {
  const address = endpoint(), feature = getFeature(id);
  const selected = feature.models[mode];
  const result: Requirements = {ready: false, connected: false, address, checks: [], model_requirements: [], missing_nodes: [], models: {}};
  if (!selected) { result.checks.push({name: "mode", status: "fail", message: "Unsupported mode."}); return result; }
  try { await probe(address, signal); result.connected = true; }
  catch (error) {
    if (signal?.aborted) throw error;
    result.checks.push({name: "runtime", status: "fail", message: "Couldn't connect to ComfyUI."});
    return result;
  }
  const variants = feature.variants.filter(v => v.mode === mode);
  const classes = [...new Set(variants.flatMap(v => Object.values(v.graph).map(node => node.class_type)))];
  const definitions: Record<string, Definition> = {};
  await Promise.all(classes.map(async name => {
    try {
      const data = await request<Record<string, Definition>>(address, `/object_info/${encodeURIComponent(name)}`, {signal});
      if (data?.[name]?.input) definitions[name] = data[name];
      else result.missing_nodes.push(name);
    } catch (error) {
      if (signal?.aborted) throw error;
      // A failed capability query must never be interpreted as ready.
      result.missing_nodes.push(name);
    }
  }));
  for (const name of result.missing_nodes) result.checks.push({name: `node:${name}`, status: "fail", message:
    name.startsWith("MarcoStudio") ? "Add the MarcoStudio nodes in ComfyUI, then restart ComfyUI when idle." : "Update or enable this node in ComfyUI, then restart ComfyUI when idle."});
  for (const model of selected) {
    const definition = definitions[model.loader];
    const spec = definition?.input?.required?.[model.field] ?? definition?.input?.optional?.[model.field];
    const choices = spec && (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options);
    const matches = Array.isArray(choices) ? choices.filter((name): name is string => typeof name === "string"
      && name.replaceAll("\\", "/").split("/").pop() === model.filename) : [];
    const resolved = matches.includes(model.filename) ? model.filename : matches.length === 1 ? matches[0] : undefined;
    result.model_requirements.push({...model, available: !!resolved, resolved, installable: Array.isArray(choices) && !matches.length});
    if (resolved) result.models[model.key] = resolved;
    else result.checks.push({name: `model:${model.key}`, status: "fail", message: matches.length > 1
      ? `Multiple copies of ${model.filename}; choose one location in ComfyUI.` : model.filename});
  }
  const failures = new Map<string, string>();
  for (const variant of variants) {
    const graph = resolveTemplate(variant.graph, {
      settings: {...feature.defaults, frames: 124, actual_duration: 124 / 24, guide_frames: [24, 48, 72]},
      prompt: "readiness", source: "source", prefix: "readiness",
      inputs: Object.fromEntries(variant.slots.map(slot => [slot, "reference.png"])),
      models: Object.fromEntries(selected.map(m => [m.key, m.filename])),
    }) as Graph;
    for (const node of Object.values(graph)) {
      if (!definitions[node.class_type]) continue;
      try { validateNode(node, definitions[node.class_type], selected); }
      catch (error) { failures.set(node.class_type, error instanceof Error ? error.message : "Incompatible node."); }
    }
  }
  for (const [name, message] of failures) result.checks.push({name: `node:${name}`, status: "fail", message});
  if (id === "restyle-video" && mode === "flash") {
    try {
      const capability = await request<{version: number; h3_pdd: boolean}>(address, "/marcostudio/capabilities", {signal});
      if (capability.version !== 1 || !capability.h3_pdd) throw new Error();
    } catch {
      result.checks.push({name: "h3_pdd", status: "fail", message: "Update ComfyUI and MarcoStudio nodes for FastH3 support."});
    }
  }
  const queue = await checkManagerQueue(address, signal);
  if (queue === "active" || queue === "unknown") clearUnverified();
  if (queue === "active") result.checks.push({name: "manager:queue", status: "fail",
    message: "ComfyUI Manager has downloads or other setup tasks in progress. Wait for its queue to finish, then check again."});
  if (queue === "unknown") result.checks.push({name: "manager:queue", status: "fail",
    message: "Couldn't check the ComfyUI Manager queue. Check the connection and try again."});
  let tasks = installTasks(address).filter(task => selected.some(model => model.url === task.model.url));
  if (tasks.some(task => !["succeeded", "failed"].includes(task.state))) {
    try { tasks = (await reconcileInstalls(address)).filter(task => selected.some(model => model.url === task.model.url)); }
    catch { /* Keep unresolved downloads blocked until their outcomes are known. */ }
  }
  for (const model of result.model_requirements) {
    const task = tasks.filter(task => task.model.url === model.url).at(-1);
    if (!task || task.state === "succeeded") continue;
    if (task.state === "failed" && !model.available) {
      task.sawMissingFile = true; saveInstallTasks(address, [task]);
    }
    if (task.state === "failed" && task.sawMissingFile) continue;
    model.available = false; model.installable = false;
    result.checks.push({name: "download:" + model.key, status: "fail", message: task.state === "failed"
      ? "Download failed. Remove the incomplete model in ComfyUI before retrying."
      : "Waiting for ComfyUI to confirm the download finished."});
  }
  const present = result.model_requirements.filter(model => model.available);
  const states = await integrityStates(address, present, signal);
  const unchecked = present.some(model => states.get(model.sha256) === "unverified");
  // Checksum checks need the opt-in helper. Without one (including when its
  // capability can't be read), a matching name is the only evidence available,
  // so unchecked files are noted instead of blocking readiness.
  const busy = unchecked ? await integrityBusy(address, signal) : {state: "unknown" as const};
  const helper = busy.helper === true;
  const requestedFallback = helper && present.some(model => states.get(model.sha256) === "unverified" && allowsUnverified(address, model.sha256));
  const scope = requestedFallback && busy.state === "idle" ? await failureScope(address, present, signal) : "clear";
  if (unchecked && !helper) result.checks.push({name: "integrity-unchecked", status: "warn",
    message: "Model files were found by name. Their checksums weren't checked because this ComfyUI has no MarcoStudio checksum helper enabled."});
  for (const model of present) {
    const state = states.get(model.sha256);
    if (state === "matched") continue;
    if (state === "blocked" || state === "active") {
      result.checks.push({name: `integrity:${model.key}`, status: "fail", message: state === "blocked"
        ? `${model.filename} failed or changed during verification. Resolve it before continuing.`
        : `${model.filename} is still being verified.`});
    } else if (!helper) {
      continue;
    } else if (allowsUnverified(address, model.sha256, busy.instance ?? null) && busy.state === "idle" && scope === "clear") {
      result.checks.push({name: `integrity-unverified:${model.key}`, status: "warn", message: `${model.filename} has not been verified in this session.`});
    } else {
      result.checks.push({name: `integrity:${model.key}`, status: "fail", message: `${model.filename} was found but its checksum has not matched during a check in this session.`});
    }
  }
  result.ready = !result.checks.some(check => check.status === "fail");
  return result;
}
