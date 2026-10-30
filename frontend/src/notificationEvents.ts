import type { InstallTask } from "./browser/manager";

export type DownloadSnapshots = {byAddress: Map<string, Map<string, InstallTask>>; reported: Set<string>};
export const createDownloadSnapshots = (): DownloadSnapshots => ({byAddress: new Map(), reported: new Set()});
export function shouldAnnounceConnection(previous: string, address: string, automatic: boolean) {
  return !automatic || previous !== address;
}
export function observeDownloadTasks(snapshots: DownloadSnapshots, address: string, tasks: InstallTask[], newTaskIds: string[] = []) {
  if (!address) return [];
  let prior = snapshots.byAddress.get(address);
  if (!prior) { prior = new Map(); snapshots.byAddress.set(address, prior); }
  const events: {text: string; failure: boolean}[] = [];
  for (const task of tasks) {
    const before = prior.get(task.id);
    const terminal = task.state === "succeeded" || task.state === "failed";
    const eventKey = JSON.stringify([address, task.id]);
    if (terminal && !snapshots.reported.has(eventKey) && ((before && before.state !== "succeeded" && before.state !== "failed") || newTaskIds.includes(task.id))) {
      const duration = typeof task.submittedAt === "number" && typeof task.observedFinishedAt === "number"
        && Number.isFinite(task.submittedAt) && Number.isFinite(task.observedFinishedAt) && task.observedFinishedAt >= task.submittedAt
        ? ` (observed after ${Math.floor((task.observedFinishedAt - task.submittedAt) / 1000)}s)` : "";
      events.push({text: task.state === "succeeded" ? `Model download complete: ${task.model.filename}${duration}` : `Model download failed: ${task.model.filename}${duration}. Check setup for details.`, failure: task.state === "failed"});
      snapshots.reported.add(eventKey);
    }
    prior.set(task.id, {...task});
  }
  return events;
}
