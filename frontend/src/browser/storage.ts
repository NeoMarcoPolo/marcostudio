export function read<T>(address: string, kind: string, fallback: T): T {
  const raw = localStorage.getItem(`marcostudio.v1:${address}:${kind}`);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error("Saved studio data couldn't be read. Keep this browser data while recovering your jobs."); }
}
export function write(address: string, kind: string, value: unknown) {
  try { localStorage.setItem(`marcostudio.v1:${address}:${kind}`, JSON.stringify(value)); }
  catch { throw new Error("Browser storage is full or unavailable. Free some space before continuing."); }
}

let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("marcostudio-media", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("blobs");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error("Allow browser storage to keep uploaded media.")); };
  });
}
export async function saveBlob(id: string, blob: Blob) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("blobs", "readwrite");
    transaction.objectStore("blobs").put(blob, id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("Couldn't save this upload in browser storage."));
  });
}
export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("blobs").objectStore("blobs").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
