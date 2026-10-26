import { ServiceError } from "../api";
import type { Model } from "./catalog";
import { clientId, endpoint, request, send } from "./connection";
import { read, write } from "./storage";

const ROOT = "/v2/manager/queue";
// Manager resolves these types through folder_paths, honoring extra model paths.
// Categories without a supported mapping use manual downloads, never models/etc.
const types: Record<string, string> = {diffusion_models: "diffusion_model", text_encoders: "text_encoders", vae: "vae", loras: "lora", controlnet: "controlnet"};
export const canInstall = (model: Model) => !!types[model.category];
export interface InstallTask {id: string; model: Model; state: "submitting" | "queued" | "succeeded" | "failed" | "unknown"; error?: string; sawMissingFile?: boolean}
interface Status {total_count: number; in_progress_count: number; pending_count: number; is_processing: boolean}
interface TaskResult {ui_id: string; result: string; status?: {status_str: string; completed: boolean; messages: string[]}}
interface BatchOperation {operation_id: string; result: string; client_id?: string; error_message?: string; end_time?: string}
const batchCache = new Map<string, BatchOperation[]>();
export const installTasks = (address = endpoint()) => read<InstallTask[]>(address, "installs", []);
export function saveInstallTasks(address: string, updates: InstallTask[]) {
  const tasks = new Map(installTasks(address).map(task => [task.id, task]));
  for (const task of updates) {
    const previous = tasks.get(task.id);
    if (previous && ["failed", "succeeded"].includes(previous.state) && !["failed", "succeeded"].includes(task.state)) continue;
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
    task.error = task.state === "failed" ? result.status.messages?.join("; ") || result.result || "Download failed." : undefined;
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
            task.error = task.state === "failed" ? operation.error_message || "Download failed in ComfyUI." : undefined;
          }
        }
      } catch { /* Missing batch history leaves the request uncertain, not retryable. */ }
    }
  }
  saveInstallTasks(address, tasks);
  return tasks;
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
  let queued = false;
  for (const model of unique) {
    if (!canInstall(model)) continue;
    if (tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state))) continue;
    const task: InstallTask = {id: crypto.randomUUID(), model, state: "submitting"};
    tasks.push(task); saveInstallTasks(address, [task]);
    try {
      await send(address, `${ROOT}/install_model`, {name: model.filename, filename: model.filename,
        type: types[model.category], save_path: "default", url: model.url, client_id: clientId(), ui_id: task.id});
      task.state = "queued"; queued = true;
    } catch (error) {
      task.state = error instanceof ServiceError && !error.uncertain ? "failed" : "unknown";
      task.error = error instanceof Error ? error.message : "Couldn't confirm this download.";
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
