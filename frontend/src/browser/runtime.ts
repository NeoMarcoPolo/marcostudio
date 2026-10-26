import type { FeatureId, StudioSettings } from "../api";
import { getAsset, uploadAsset } from "./assets";
import { catalog } from "./catalog";
import { endpoint } from "./connection";
import { cancelJob, listJobs, refreshJob, resolveJob, submitJob, type Submission } from "./jobs";
import { checkRequirements } from "./requirements";

export function browserSettings(): StudioSettings {
  return {comfy_url: endpoint(), proxy_url: null, comfy_dir: null, data_dir: "", transport: "browser"};
}

export async function browserApi<T>(url: string, init?: RequestInit): Promise<T> {
  const target = new URL(url, location.origin), path = target.pathname;
  const body = () => JSON.parse(String(init?.body ?? "{}"));
  let result: unknown;
  if (path === "/api/features") result = catalog;
  else if (path === "/api/settings") result = browserSettings();
  else if (path === "/api/doctor") result = await checkRequirements((target.searchParams.get("feature") ?? "relight") as FeatureId, target.searchParams.get("mode") ?? "flash", init?.signal ?? undefined);
  else if (path === "/api/assets" && init?.body instanceof FormData) {
    const file = init.body.get("file");
    if (!(file instanceof File)) throw new Error("Choose an input file.");
    result = await uploadAsset(file);
  } else if (/^\/api\/assets\/[^/]+\/meta$/.test(path)) result = await getAsset(decodeURIComponent(path.split("/")[3]));
  else if (path === "/api/jobs") result = init?.method === "POST" ? await submitJob(body() as Submission) : listJobs();
  else if (/^\/api\/jobs\/[^/]+/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    result = path.endsWith("/cancel") ? await cancelJob(id) : path.endsWith("/resolve") ? await resolveJob(id, body().confirm_not_running === true) : await refreshJob(id);
  } else throw new Error("This action isn't supported by the direct connection.");
  return result as T;
}
