import { active, type FeatureId, type Job } from "../api";
import { getAsset, inputName, mediaMetadata, saveAsset, viewUrl, type StoredAsset } from "./assets";
import { compile, getFeature, validateSettings } from "./catalog";
import { clientId, endpoint, request, send } from "./connection";
import { checkRequirements } from "./requirements";
import { read, write } from "./storage";

type SavedJob = Job & {prompt_id?: string; sent?: boolean};
export type Submission = {request_id: string; feature: FeatureId; source_id: string | null; inputs?: Record<string, string>; settings: Job["settings"]};
type QueueItem = [number, string, unknown, {marcostudio?: {request_id: string}}];
type History = {prompt?: QueueItem; outputs?: Record<string, Record<string, unknown>>; status?: {status_str: string; completed: boolean; messages?: [string, Record<string, unknown>][]}};
type Queue = {queue_running: QueueItem[]; queue_pending: QueueItem[]};
export const listJobs = (address = endpoint()) => read<SavedJob[]>(address, "jobs", []);
function save(address: string, job: SavedJob) {
  job.updated_at = new Date().toISOString();
  write(address, "jobs", [job, ...listJobs(address).filter(item => item.id !== job.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  return job;
}
function owned(item: QueueItem, job: SavedJob) {
  return item[1] === job.prompt_id || item[3]?.marcostudio?.request_id === job.id;
}

export async function refreshJob(id: string, address = endpoint()): Promise<SavedJob> {
  const job = listJobs(address).find(item => item.id === id);
  if (!job) throw new Error("Generation not found in this browser.");
  if (!active(job)) return job;
  if (["preparing", "submitting"].includes(job.status) && submitting.has(`${address}:${id}`)) return job;
  const [queue, histories] = await Promise.all([
    request<Queue>(address, "/queue"),
    request<Record<string, History>>(address, job.prompt_id ? `/history/${encodeURIComponent(job.prompt_id)}` : "/history"),
  ]);
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || !histories || typeof histories !== "object")
    throw new Error("Couldn't read ComfyUI job status.");
  const entry = Object.entries(histories).find(([key, value]) => key === job.prompt_id || (value.prompt && owned(value.prompt, job)));
  if (entry) {
    const [promptId, history] = entry; job.prompt_id = promptId;
    if (history.status?.status_str === "error") {
      const error = history.status.messages?.find(([kind]) => kind === "execution_error" || kind === "execution_interrupted");
      job.status = error?.[0] === "execution_interrupted" ? "cancelled" : "failed";
      job.error = String(error?.[1]?.exception_message ?? "ComfyUI couldn't complete this generation.");
    } else if (history.status?.completed || history.outputs) {
      const files = Object.values(history.outputs ?? {}).flatMap(output => Object.values(output).flatMap(value => Array.isArray(value) ? value : []))
        .filter((file): file is {filename: string; subfolder?: string; type?: string} => !!file && typeof file.filename === "string" && file.type === "output");
      const unique = [...new Map(files.map(file => [`${file.subfolder}/${file.filename}`, file])).values()];
      const outputs: StoredAsset[] = [];
      for (const [index, file] of unique.entries()) {
        if (!/\.(png|jpe?g|webp|mp4)$/i.test(file.filename)) continue;
        const url = viewUrl(address, file);
        try {
          const response = await fetch(url, {credentials: "omit"});
          if (!response.ok) throw new Error();
          const blob = await response.blob();
          const media_type = /\.mp4$/i.test(file.filename) ? "video/mp4" : blob.type || "image/png";
          const metadata = await mediaMetadata(new Blob([blob], {type: media_type}));
          outputs.push(saveAsset(address, {id: `${job.id}-${index}`, url, filename: file.filename, media_type, ...metadata,
            comfy: {filename: file.filename, subfolder: file.subfolder ?? "", type: "output"}}));
        } catch { job.error = "Result unavailable in ComfyUI."; }
      }
      job.outputs = outputs;
      job.status = outputs.length ? "succeeded" : "result_unavailable";
      if (!outputs.length) job.error = "Result unavailable in ComfyUI.";
    }
    return save(address, job);
  }
  const running = queue.queue_running.find(item => owned(item, job));
  const pending = queue.queue_pending.find(item => owned(item, job));
  if (running || pending) {
    job.prompt_id = (running || pending)![1]; job.status = running ? "running" : "queued"; job.error = null;
  } else {
    job.status = "needs_attention";
    job.error = "ComfyUI no longer reports this request. Check its queue and history before stopping tracking.";
  }
  return save(address, job);
}

const submitting = new Map<string, Promise<SavedJob>>();
export async function submitJob(body: Submission): Promise<SavedJob> {
  const address = endpoint(), key = `${address}:${body.request_id}`;
  if (submitting.has(key)) return submitting.get(key)!;
  const perform = async () => {
    const existing = listJobs(address).find(job => job.id === body.request_id);
    if (existing) return active(existing) ? refreshJob(existing.id, address) : existing;
    if (listJobs(address).some(job => job.status === "needs_attention")) throw new Error("Resolve the uncertain generation first.");
    const feature = getFeature(body.feature);
    const settings = {...feature.defaults, ...body.settings} as Job["settings"];
    validateSettings(feature, settings);
    // Save identity before any asynchronous preparation or upstream submission.
    const now = new Date().toISOString();
    const job = save(address, {id: body.request_id, feature: body.feature, settings, source_id: body.source_id, inputs: body.inputs ?? {},
      status: "preparing", outputs: [], error: null, created_at: now, updated_at: now, progress: null, elapsed_seconds: null, queue_seconds: null} as SavedJob);
    try {
      const report = await checkRequirements(body.feature, settings.mode);
      if (report.address !== address) throw new Error("The connection changed. Try again on the selected ComfyUI.");
      if (!report.ready) throw new Error("This tool still needs setup in ComfyUI.");
      const source = body.source_id ? await getAsset(body.source_id, address) : null;
      if (feature.source_kind !== "none" && !source?.media_type.startsWith(`${feature.source_kind}/`)) throw new Error(`Add a source ${feature.source_kind}.`);
      if (feature.source_kind === "none" && source) throw new Error("This tool doesn't accept a source.");
      if (feature.min_source_frames && (source?.duration ?? 0) * 24 < feature.min_source_frames) throw new Error("The source video is too short.");
      const names: Record<string, string> = {};
      for (const [slot, id] of Object.entries(body.inputs ?? {})) {
        const definition = feature.input_slots?.find(input => input.key === slot);
        const asset = await getAsset(id, address);
        if (!definition || !asset.media_type.startsWith(`${definition.kind}/`)) throw new Error(`Invalid ${slot} input.`);
        names[slot] = await inputName(asset, address);
      }
      if (feature.id === "keyframes" && "guide_frames" in settings && settings.guide_frames?.length !== Object.keys(names).length) throw new Error("Set one frame number per guide image.");
      const graph = compile(feature, settings, source ? await inputName(source, address) : null, names, report.models, `MarcoStudio/${job.id}`);
      if (listJobs(address).find(item => item.id === job.id)?.status === "abandoned") return listJobs(address).find(item => item.id === job.id)!;
      job.status = "submitting"; job.sent = true; save(address, job);
      const response = await send<{prompt_id: string}>(address, "/prompt", {prompt: graph, prompt_id: job.id, client_id: clientId(),
        extra_data: {marcostudio: {request_id: job.id, feature: body.feature, version: feature.version}}});
      if (!response?.prompt_id) throw new Error("ComfyUI didn't return a generation ID.");
      job.prompt_id = response.prompt_id; job.status = "queued";
    } catch (error) {
      job.error = error instanceof Error ? error.message : "Generation failed.";
      // Definitive validation errors can be shown as failed. Network/5xx and
      // malformed acknowledgements remain uncertain, never automatically retried.
      const rejected = error instanceof Error && "uncertain" in error && error.uncertain === false;
      job.status = job.sent && !rejected ? "needs_attention" : "failed";
    }
    return save(address, job);
  };
  const promise: Promise<SavedJob> = (async () => navigator.locks ? await navigator.locks.request(`marcostudio:${key}`, perform) : await perform())();
  submitting.set(key, promise);
  try { return await promise; } finally { submitting.delete(key); }
}

export async function cancelJob(id: string) {
  const address = endpoint(), job = await refreshJob(id, address);
  if (!active(job)) return job;
  if (job.status !== "queued" || !job.prompt_id) throw new Error("Open ComfyUI to cancel this running generation.");
  await send(address, "/queue", {delete: [job.prompt_id]});
  const queue = await request<Queue>(address, "/queue");
  if (queue.queue_running.some(item => owned(item, job))) throw new Error("The generation started. Open ComfyUI to cancel it.");
  if (queue.queue_pending.some(item => owned(item, job))) throw new Error("ComfyUI still reports this generation as queued.");
  job.status = "cancelled"; return save(address, job);
}

export async function resolveJob(id: string, confirmed: boolean) {
  if (!confirmed) throw new Error("Check ComfyUI before stopping tracking.");
  const address = endpoint(), job = await refreshJob(id, address);
  if (job.status === "needs_attention") { job.status = "abandoned"; job.error = null; save(address, job); }
  return job;
}
