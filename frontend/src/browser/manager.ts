import { ServiceError } from "../api";
import type { Model } from "./catalog";
import { clientId, endpoint, request, send } from "./connection";
import { read, write } from "./storage";

const ROOT = "/v2/manager/queue";
// Manager resolves these types through folder_paths, honoring extra model paths.
// Categories without a supported mapping use manual downloads, never models/etc.
const types: Record<string, string> = {diffusion_models: "diffusion_model", text_encoders: "text_encoders", vae: "vae", loras: "lora", controlnet: "controlnet"};
export const managerType = (model: Model) => types[model.category];
export const canInstall = (model: Model) => !!managerType(model);
export interface InstallTask {id: string; model: Model; state: "submitting" | "queued" | "succeeded" | "failed" | "unknown"; error?: string; sawMissingFile?: boolean; batchId?: string; submittedAt?: number; observedFinishedAt?: number}
interface Status {total_count: number; in_progress_count: number; pending_count: number; is_processing: boolean}
interface TaskResult {ui_id: string; result: string; status?: {status_str: string; completed: boolean; messages: string[]}}
interface BatchOperation {operation_id: string; result: string; client_id?: string; error_message?: string; end_time?: string}
const batchCache = new Map<string, BatchOperation[]>();
// Manager can collapse the underlying error (including ENOSPC) into a generic
// installation failure, so offer possible remedies without claiming a cause.
const downloadFailure = "Download failed. Check free space on the drive used by ComfyUI and your internet connection. Check for an incomplete model file before retrying.";
function failureGuidance(detail?: string) {
  // Only repeat a recognized error; arbitrary Manager output can contain URLs or paths.
  return detail && /^(disk full|no space left on device|enospc)$/i.test(detail.trim())
    ? `ComfyUI reports: Disk full. ${downloadFailure}` : downloadFailure;
}
export const installTasks = (address = endpoint()) => read<InstallTask[]>(address, "installs", []);
export function saveInstallTasks(address: string, updates: InstallTask[]) {
  const tasks = new Map(installTasks(address).map(task => [task.id, task]));
  for (const task of updates) {
    const previous = tasks.get(task.id);
    if (previous && ["failed", "succeeded"].includes(previous.state) && !["failed", "succeeded"].includes(task.state)) continue;
    if (previous?.state === "queued" && ["submitting", "unknown"].includes(task.state)) continue;
    tasks.set(task.id, {...previous, ...task});
  }
  write(address, "installs", [...tasks.values()]);
}

export async function managerAvailable(address = endpoint()) {
  if (!address) return false;
  try {
    const [status, history] = await Promise.all([
      request<Status>(address, `${ROOT}/status?client_id=${encodeURIComponent(clientId())}`),
      request<{history: unknown}>(address, `${ROOT}/history?client_id=${encodeURIComponent(clientId())}&max_items=1`),
    ]);
    return typeof status?.pending_count === "number" && typeof status.in_progress_count === "number" && !!history && "history" in history;
  } catch { return false; }
}

export async function reconcileInstalls(address = endpoint()) {
  const tasks = installTasks(address);
  const unresolved: InstallTask[] = [];
  for (const task of tasks) {
    if (["succeeded", "failed"].includes(task.state)) continue;
    const response = await request<{history: Record<string, TaskResult> | TaskResult | null}>(address, `${ROOT}/history?ui_id=${encodeURIComponent(task.id)}`);
    const data = response?.history;
    const result = data && ("ui_id" in data ? data as TaskResult : (data as Record<string, TaskResult>)[task.id]);
    if (!result?.status?.completed) { unresolved.push(task); continue; }
    task.state = ["success", "skipped", "skip"].includes(result.status.status_str) ? "succeeded" : "failed";
    task.observedFinishedAt ??= Date.now();
    if (task.state === "failed") console.warn("ComfyUI model download failed; see ComfyUI logs for details.");
    task.error = task.state === "failed" ? failureGuidance(result.status.messages?.join("; ") || result.result) : undefined;
  }
  if (unresolved.length) {
    // Manager's in-memory history disappears on restart; completed batches are
    // retained separately. Resolve by task identity, never by filename alone.
    const status = await request<Status>(address, `${ROOT}/status?client_id=${encodeURIComponent(clientId())}`);
    if (status.total_count === 0) {
      try {
        const batches = await request<{ids?: string[]}>(address, `${ROOT}/history_list`);
        const ids = batches.ids ?? [];
        const unseen = ids.filter(id => !batchCache.has(`${address}:${id}`)).slice(0, 20);
        for (const id of unseen) {
          const batch = await request<{operations?: BatchOperation[]}>(address, `${ROOT}/history?id=${encodeURIComponent(id)}`);
          batchCache.set(`${address}:${id}`, batch.operations ?? []);
        }
        for (const id of ids) {
          for (const operation of batchCache.get(`${address}:${id}`) ?? []) {
            const task = unresolved.find(task => task.id === operation.operation_id);
            if (!task || !operation.end_time || (operation.client_id && operation.client_id !== clientId())) continue;
            task.state = ["success", "skipped", "skip"].includes(operation.result) ? "succeeded" : "failed";
            task.observedFinishedAt ??= Date.now();
            if (task.state === "failed") console.warn("ComfyUI model download failed; see ComfyUI logs for details.");
            task.error = task.state === "failed" ? failureGuidance(operation.error_message) : undefined;
          }
        }
      } catch { /* Missing batch history leaves the request uncertain, not retryable. */ }
    }
  }
  saveInstallTasks(address, tasks);
  return installTasks(address);
}

export async function startDownloads(models: Model[]) {
  const address = endpoint();
  const run = () => installModels(address, models);
  return navigator.locks ? await navigator.locks.request(`marcostudio:downloads:${address}`, run) : run();
}

async function installModels(address: string, models: Model[]) {
  if (!await managerAvailable(address)) throw new Error("Open ComfyUI to enable model downloads.");
  const tasks = await reconcileInstalls(address);
  const unique = [...new Map(models.map(model => [model.url, model])).values()];
  // Recheck the whole queue immediately before a batch. Another browser can
  // start a task after the last readiness poll; client-filtered counts miss it.
  let status: Status;
  try { status = await request<Status>(address, `${ROOT}/status`); }
  catch { throw new Error("Couldn't check the ComfyUI Manager queue. Check the connection and try again."); }
  if (!Number.isInteger(status?.pending_count) || status.pending_count < 0
    || !Number.isInteger(status?.in_progress_count) || status.in_progress_count < 0
    || typeof status?.is_processing !== "boolean")
    throw new Error("Couldn't check the ComfyUI Manager queue. Check the connection and try again.");
  if (status.pending_count > 0 || status.in_progress_count > 0 || status.is_processing)
    throw new Error("ComfyUI Manager has setup tasks in progress. Wait for its queue to finish, then try again.");
  let queued = false;
  const batchId = crypto.randomUUID();
  const submittedAt = Date.now();
  for (const model of unique) {
    if (!canInstall(model)) continue;
    if (tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state))) continue;
    const task: InstallTask = {id: crypto.randomUUID(), model, state: "submitting", batchId, submittedAt};
    tasks.push(task); saveInstallTasks(address, [task]);
    try {
      await send(address, `${ROOT}/install_model`, {name: model.filename, filename: model.filename,
        type: types[model.category], save_path: "default", url: model.url, client_id: clientId(), ui_id: task.id});
      task.state = "queued"; queued = true;
    } catch (error) {
      task.state = error instanceof ServiceError && !error.uncertain ? "failed" : "unknown";
      if (task.state === "failed") task.observedFinishedAt = Date.now();
      if (task.state === "failed") console.warn("ComfyUI model download request failed; see ComfyUI logs for details.");
      task.error = task.state === "failed" ? downloadFailure : error instanceof Error ? error.message : "Couldn't confirm this download.";
    }
    saveInstallTasks(address, [task]);
    if (task.state === "unknown") break;
  }
  if (queued) await resumeDownloads(address);
  return tasks;
}

export async function resumeDownloads(address = endpoint()) {
  // Starting the existing Manager queue never resubmits a model download.
  await send(address, `${ROOT}/start`, {});
}
