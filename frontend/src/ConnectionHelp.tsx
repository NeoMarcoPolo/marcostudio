import { useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink } from "lucide-react";

export function ConnectionHelp({address, error, busy, retry}: {
  address: string; error: string; busy: boolean; retry: () => void;
}) {
  const option = `--enable-cors-header ${location.origin}`;
  const [showFix, setShowFix] = useState(false);
  const [launcher, setLauncher] = useState<"Desktop" | "Portable" | "Terminal">();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(option);
      setCopied(true); setCopyFailed(false);
    } catch { setCopyFailed(true); }
  };

  if (!showFix) return <section className="connection-help">
    <p className="failure-text" role="alert">{error && error !== "Couldn't connect to ComfyUI." ? error : "Can’t reach ComfyUI."}</p>
    <p>Start ComfyUI, then try again.</p>
    <div className="setup-actions">
      <button autoFocus className="setup-primary" disabled={busy} onClick={retry}>{busy ? "Connecting…" : "Try again"}</button>
      <a href={address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
    </div>
    <button className="setup-link" onClick={() => setShowFix(true)}>It's already running</button>
  </section>;

  return <section className="connection-help">
    <button autoFocus className="setup-link setup-back" onClick={() => setShowFix(false)}><ArrowLeft size={14}/> Back</button>
    <fieldset className="launcher-picker">
      <legend>How do you start ComfyUI?</legend>
      <div>{(["Desktop", "Portable", "Terminal"] as const).map(value =>
        <button key={value} aria-pressed={launcher === value} onClick={() => setLauncher(value)}>{value}</button>)}</div>
    </fieldset>
    {launcher && <div className="launcher-fix">
      {launcher === "Desktop" && <p>Add this in <strong>Instance ⋮ → Manage → Startup Args → Startup Arguments.</strong></p>}
      {launcher === "Portable" && <p>Edit your .bat launcher. Append this to the <span className="inline-code">ComfyUI\main.py</span> line, keeping its existing options.</p>}
      {launcher === "Terminal" && <p>Add this to your ComfyUI start command.</p>}
      <div className="launch-option"><code>{option}</code><button aria-label={copied ? "Copied" : "Copy launch option"} onClick={() => void copy()}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span>{copied ? "Copied" : "Copy"}</span></button></div>
      {copyFailed && <p role="status">Select and copy the option above.</p>}
      <p>Restart ComfyUI when idle, then return here.</p>
      <button className="setup-primary" disabled={busy} onClick={retry}>{busy ? "Connecting…" : "Try again"}</button>
    </div>}
    <details className="browser-permission"><summary>Browser permission</summary><p>Allow local-network access in this website’s browser settings, then try again.</p></details>
  </section>;
}
