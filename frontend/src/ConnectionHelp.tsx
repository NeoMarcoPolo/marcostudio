import { useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink } from "lucide-react";
import type { ConnectionFailure } from "./browser/connection";

export type FailureDetail = Pick<ConnectionFailure, "reason" | "tried" | "answered">;

export const INSTALL_URL = "https://comfy.org/download";

export function ConnectionHelp({address, error, failure, busy, retry, connectTo}: {
  address: string; error: string; failure?: FailureDetail | null; busy: boolean; retry: () => void;
  connectTo?: (address: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const option = `--enable-cors-header ${location.origin}`;
  const [showFix, setShowFix] = useState(failure?.reason === "cors");
  const [launcher, setLauncher] = useState<"Desktop" | "Portable" | "Terminal">();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(option);
      setCopied(true); setCopyFailed(false);
    } catch { setCopyFailed(true); }
  };

  if (failure?.reason === "permission") return <section className="connection-help">
    <p className="failure-text" role="alert">Your browser blocked this page from reaching ComfyUI.</p>
    <p>Allow local-network access for this site in your browser’s site settings, then try again.</p>
    <div className="setup-actions">
      <button autoFocus className="setup-primary" disabled={busy} onClick={retry}>{busy ? "Connecting…" : "Try again"}</button>
    </div>
  </section>;

  if (!showFix) return <section className="connection-help">
    <p className="failure-text" role="alert">{error && !failure && error !== "Couldn't connect to ComfyUI." ? error : "Can’t reach ComfyUI."}</p>
    {failure?.tried.length ? <p>Tried {failure.tried.join(" and ")}.</p> : null}
    <p>Start ComfyUI, then try again. <a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">Don’t have ComfyUI? Install it <ExternalLink size={13}/></a></p>
    <div className="setup-actions">
      <button autoFocus className="setup-primary" disabled={busy} onClick={retry}>{busy ? "Connecting…" : "Try again"}</button>
      <a href={address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
    </div>
    {connectTo && failure?.reason === "unreachable" && <form className="connection-other" onSubmit={event => {event.preventDefault(); if (custom.trim()) connectTo(custom.trim());}}>
      <label htmlFor="comfy-address-other">ComfyUI uses another address?</label>
      <input id="comfy-address-other" type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        placeholder="127.0.0.1:8188" value={custom} disabled={busy} onChange={event => setCustom(event.target.value)}/>
      <button disabled={busy || !custom.trim()}>Connect</button>
    </form>}
    <button className="setup-link" onClick={() => setShowFix(true)}>It's already running</button>
  </section>;

  return <section className="connection-help">
    {failure?.reason !== "cors" && <button autoFocus className="setup-link setup-back" onClick={() => setShowFix(false)}><ArrowLeft size={14}/> Back</button>}
    {failure?.reason === "cors" && <>
      <p className="failure-text" role="alert">Something is running at {failure.answered.join(" and ")}, but it doesn’t let this page connect.</p>
      <p>If that is ComfyUI, add one startup option so it allows this page. <a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">Don’t have ComfyUI? Install it <ExternalLink size={13}/></a></p>
      <button className="setup-link" onClick={() => setShowFix(false)}>That isn’t ComfyUI</button>
    </>}
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
