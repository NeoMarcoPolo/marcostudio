import { useState } from "react";
import { ExternalLink } from "lucide-react";

export function ConnectionHelp({address, error, busy, retry}: {
  address: string; error: string; busy: boolean; retry: () => void;
}) {
  const option = `--enable-cors-header ${location.origin}`;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(option);
      setCopied(true); setCopyFailed(false);
    } catch { setCopyFailed(true); }
  };

  return <section className="connection-help" aria-labelledby="connection-help-title">
    {error && <p role="alert">{error}</p>}
    <a href={address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
    <h3 id="connection-help-title">Allow this website in ComfyUI</h3>
    <p>If ComfyUI is running, add this launch option once:</p>
    <code>{option}</code>
    <button onClick={() => void copy()}>{copied ? "Copied" : "Copy launch option"}</button>
    {copyFailed && <p role="status">Select and copy the option above.</p>}
    <details>
      <summary>Where do I add it?</summary>
      <p><strong>Comfy Desktop:</strong> Open your instance’s ⋮ menu → Manage → Startup Args. Append it to Startup Arguments.</p>
      <p><strong>Windows portable:</strong> Edit the .bat file you use to start ComfyUI. Append it to the line containing <span className="inline-code">ComfyUI\main.py</span>, keeping the existing options.</p>
      <p><strong>Terminal:</strong> Append it to your usual ComfyUI launch command.</p>
      <a href="https://docs.comfy.org/development/comfyui-server/startup-flags" target="_blank" rel="noopener noreferrer">ComfyUI launch options <ExternalLink size={13}/></a>
    </details>
    <p>Restart ComfyUI when its queue is idle, then return here. We’ll check again.</p>
    <button className="setup-primary" disabled={busy} onClick={retry}>{busy ? "Connecting…" : "Try again"}</button>
    <details>
      <summary>Still can’t connect?</summary>
      <p>Allow local-network access for this website in your browser’s site settings, then retry.</p>
      <p>Using another computer or a phone? Choose “Use another address” and enter the address that opens ComfyUI on this device.</p>
    </details>
  </section>;
}
