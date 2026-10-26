import type { Asset } from "../api";
import { endpoint, request } from "./connection";
import { getBlob, read, saveBlob, write } from "./storage";

export interface StoredAsset extends Asset {comfy?: {filename: string; subfolder: string; type: string}}
const objectUrls = new Map<string, string>();
export function viewUrl(address: string, file: {filename: string; subfolder?: string; type?: string}) {
  return `${address}/view?${new URLSearchParams({filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output"})}`;
}
export function saveAsset(address: string, asset: StoredAsset) {
  write(address, `asset:${asset.id}`, {...asset, url: asset.comfy ? viewUrl(address, asset.comfy) : ""});
  return asset;
}
export async function getAsset(id: string, address = endpoint()): Promise<StoredAsset> {
  const asset = read<StoredAsset | null>(address, `asset:${id}`, null);
  if (!asset) throw new Error("This input is no longer saved in this browser.");
  const blob = await getBlob(`${address}:${id}`);
  if (blob) {
    if (!objectUrls.has(id)) objectUrls.set(id, URL.createObjectURL(blob));
    return {...asset, url: objectUrls.get(id)!};
  }
  return asset;
}

export async function mediaMetadata(blob: Blob): Promise<{width: number; height: number; duration?: number}> {
  if (!blob.type.startsWith("video/")) {
    const bitmap = await createImageBitmap(blob, {imageOrientation: "from-image"});
    const result = {width: bitmap.width, height: bitmap.height}; bitmap.close(); return result;
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const timer = setTimeout(() => finish(new Error("This MP4 couldn't be read.")), 15000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        const metadata = {width: video.videoWidth, height: video.videoHeight, duration: video.duration};
        video.removeAttribute("src"); video.load();
        error ? reject(error) : resolve(metadata);
      };
      video.onloadedmetadata = () => finish();
      video.onerror = () => finish(new Error("Use a browser-readable MP4 video."));
      video.preload = "metadata"; video.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export async function uploadAsset(file: File): Promise<StoredAsset> {
  const address = endpoint();
  if (!address) throw new Error("Connect ComfyUI before adding an input.");
  const video = file.type === "video/mp4";
  if (!["image/png", "image/jpeg", "video/mp4"].includes(file.type)) throw new Error("Use a PNG, JPEG or MP4.");
  if (!file.size || file.size > (video ? 96 : 32) * 1024 * 1024) throw new Error(video ? "Use an MP4 under 96 MiB." : "Use an image under 32 MiB.");
  const metadata = await mediaMetadata(file);
  if (video ? metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > 3840 * 2160
    || !Number.isFinite(metadata.duration) || metadata.duration! <= 0 || metadata.duration! > 15.1
    : metadata.width * metadata.height > 32_000_000) throw new Error(video ? "Use an MP4 up to 15 seconds and 4K." : "Use an image under 32 megapixels.");
  let blob: Blob = file;
  if (!video) {
    const bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); throw new Error("Couldn't prepare this image."); }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Couldn't prepare this image.")), "image/png"));
  }
  const id = crypto.randomUUID(), filename = `${id}${video ? ".mp4" : ".png"}`;
  await saveBlob(`${address}:${id}`, blob);
  const form = new FormData(); form.append("image", blob, filename); form.append("type", "input"); form.append("subfolder", "marcostudio");
  const uploaded = await request<{name: string; subfolder: string; type: string}>(address, "/upload/image", {method: "POST", body: form}, 120000);
  if (!uploaded?.name) throw new Error("ComfyUI didn't confirm the upload.");
  const url = URL.createObjectURL(blob); objectUrls.set(id, url);
  return saveAsset(address, {id, url, ...metadata, media_type: blob.type, filename: file.name.replace(/\.[^.]+$/, video ? ".mp4" : ".png"),
    comfy: {filename: uploaded.name, subfolder: uploaded.subfolder || "", type: uploaded.type || "input"}});
}

export async function inputName(asset: StoredAsset, address: string) {
  if (asset.comfy?.type === "input") return [asset.comfy.subfolder, asset.comfy.filename].filter(Boolean).join("/");
  // Outputs reused as inputs are copied through ComfyUI's upload API. This also
  // works with LoadVideo versions that don't accept annotated output paths.
  const blob = (await getBlob(`${address}:${asset.id}`)) ?? await fetch(asset.url, {credentials: "omit"}).then(response => {
    if (!response.ok) throw new Error("Result unavailable in ComfyUI."); return response.blob();
  });
  if (!blob) throw new Error("Input unavailable in this browser.");
  const form = new FormData(); form.append("image", blob, `${asset.id}${asset.media_type.startsWith("video") ? ".mp4" : ".png"}`);
  form.append("type", "input"); form.append("subfolder", "marcostudio");
  const uploaded = await request<{name: string; subfolder: string; type: string}>(address, "/upload/image", {method: "POST", body: form}, 120000);
  if (!uploaded?.name) throw new Error("ComfyUI didn't confirm the input copy.");
  return [uploaded.subfolder, uploaded.name].filter(Boolean).join("/");
}

export async function downloadAsset(asset: Asset) {
  const response = await fetch(asset.url, {credentials: "omit"});
  if (!response.ok) throw new Error("Result unavailable in ComfyUI.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = asset.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
