import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useBrowserRuntime } from "./api";
import { wantsBrowserRuntime } from "./runtimeHint";

async function start() {
  let local = false;
  if (!wantsBrowserRuntime(location.search, location.hostname)) {
    try {
      const response = await fetch("/api/settings", {signal: AbortSignal.timeout(2000)});
      const settings = await response.json();
      local = response.ok && typeof settings.comfy_url === "string" && typeof settings.transport === "string" && "data_dir" in settings;
    } catch { /* A static website uses ComfyUI directly. */ }
  }
  if (!local) useBrowserRuntime((await import("./browser/runtime")).browserApi);
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
}
void start();
