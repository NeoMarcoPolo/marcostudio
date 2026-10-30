// Whether this page should skip looking for the local MarcoStudio service and
// run ComfyUI from the browser. `marcostudio serve` only listens on 127.0.0.1,
// so a page loaded from any other host has no local service to find, and
// probing would only send a request that fails. The URL can also ask for the
// browser runtime explicitly (?runtime=browser).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function wantsBrowserRuntime(search: string, hostname: string): boolean {
  if (new URLSearchParams(search).get("runtime") === "browser") return true;
  return !LOOPBACK_HOSTS.has(hostname);
}
