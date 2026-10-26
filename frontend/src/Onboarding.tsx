import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import type { Doctor, Feature, FeatureId } from "./api";
import { getFeature } from "./browser/catalog";
import { discover, endpoint, selectConnection } from "./browser/connection";
import { canInstall, installTasks, managerAvailable, reconcileInstalls, resumeDownloads, startDownloads, type InstallTask } from "./browser/manager";
import type { Requirements } from "./browser/requirements";

export const enteredKey = () => `marcostudio.entered:${endpoint()}`;
const formatSize = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function Onboarding({feature, featureId, mode, doctor, checking, locked, refresh, connected, close}: {
  feature?: Feature; featureId: FeatureId; mode: string; doctor?: Doctor; checking: boolean; locked: boolean;
  refresh: () => Promise<void>; connected: () => Promise<void>; close: () => void;
}) {
  const report = doctor as Requirements | undefined;
  const [address, setAddress] = useState(endpoint());
  const [candidates, setCandidates] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [manager, setManager] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [tasks, setTasks] = useState<InstallTask[]>(() => installTasks());
  const dialog = useRef<HTMLDialogElement>(null);
  const polling = useRef(false);
  const current = useRef(true);
  const missing = report?.model_requirements?.filter(model => !model.available) ?? [];
  const downloadable = missing.filter(model => model.installable && canInstall(model));
  const unfinished = tasks.filter(task => missing.some(model => model.url === task.model.url) && !["failed", "succeeded"].includes(task.state));
  const toInstall = downloadable.filter(model => !tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state)));
  const failures = report?.checks.filter(check => check.status === "fail" && (check.name.startsWith("node:") || check.name === "h3_pdd")) ?? [];
  const ready = !!report?.ready && !checking;

  useEffect(() => {
    current.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => { current.current = false; document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);

  const recheck = useCallback(async () => {
    if (polling.current || !endpoint()) return;
    polling.current = true;
    try {
      await refresh();
      const available = await managerAvailable();
      if (current.current) setManager(available);
      if (available && !installing) {
        const next = await reconcileInstalls();
        if (current.current) setTasks(next);
      }
    } catch (error) {
      if (current.current) setError(error instanceof Error ? error.message : "Couldn't check setup.");
    } finally { polling.current = false; }
  }, [refresh, installing]);

  useEffect(() => {
    void recheck();
    const timer = window.setInterval(() => { if (!document.hidden) void recheck(); }, 7000);
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [recheck]);

  const choose = async (value: string) => {
    selectConnection(value); setAddress(value); setCandidates([]); setTasks(installTasks(value));
    await connected();
    const available = await managerAvailable(value);
    if (current.current) setManager(available);
  };
  const connect = async (value?: string) => {
    setConnecting(true); setError("");
    try {
      const found = await discover(value);
      if (!current.current) return;
      if (found.length === 1) await choose(found[0]); else setCandidates(found);
    } catch (error) { if (current.current) setError(error instanceof Error ? error.message : "Couldn't connect to ComfyUI."); }
    finally { if (current.current) setConnecting(false); }
  };
  const install = async (resume = false) => {
    setInstalling(true); setError("");
    try {
      if (resume) await resumeDownloads();
      else await startDownloads(toInstall);
      if (current.current) setTasks(installTasks());
      await refresh();
    } catch (error) {
      if (current.current) { setTasks(installTasks()); setError(error instanceof Error ? error.message : "Download failed."); }
    } finally { if (current.current) setInstalling(false); }
  };
  const tool = getFeature(featureId);
  const allModels = tool.models[mode] ?? [];
  return <dialog ref={dialog} className="onboarding" aria-labelledby="onboarding-title" onCancel={event => {event.preventDefault(); close();}}>
    <div className="onboarding-heading"><h2 id="onboarding-title">Use your ComfyUI</h2><button aria-label="Close setup" onClick={close}><X size={19}/></button></div>
    <p className="onboarding-intro">Connect your running ComfyUI. We’ll check what {feature?.name ?? "Relight"} needs.</p>
    <ol className="onboarding-steps" aria-live="polite">
      <li className={report?.connected ? "complete" : ""}>
        <span className="step-mark">{report?.connected ? <Check size={16}/> : "1"}</span>
        <div><h3>{report?.connected ? "ComfyUI detected" : "ComfyUI"}</h3>
          {report?.connected ? <p className="connection-address">{report.address}</p> : <button className="setup-primary" disabled={connecting || locked} onClick={() => void connect()}>{connecting ? "Connecting…" : "Connect"}</button>}
          {candidates.length > 1 && <div className="instance-choices"><p>Choose your ComfyUI</p>{candidates.map(value => <button key={value} onClick={() => void choose(value).catch(error => setError(String(error)))}>{value}</button>)}</div>}
          {(error || report?.connected || endpoint()) && <details className="connection-options"><summary>Use another address</summary>
            <form onSubmit={event => {event.preventDefault(); void connect(address);}}><label htmlFor="comfy-address">ComfyUI address</label><input id="comfy-address" type="url" value={address} placeholder="http://127.0.0.1:8188" disabled={locked || connecting || installing || unfinished.length > 0} onChange={event => setAddress(event.target.value)}/>
              <button disabled={locked || connecting || installing || unfinished.length > 0 || !address.trim()}>Connect</button></form></details>}
        </div>
      </li>
      <li className={report?.ready ? "complete" : ""}>
        <span className="step-mark">{report?.ready ? <Check size={16}/> : "2"}</span>
        <div><h3>Models and nodes</h3>
          {!report?.connected ? <p>Connect to check</p> : checking ? <p>Checking {feature?.name}…</p> : report.ready ? <p>Installed</p> : <>
            <p>{missing.length > 0 && `${missing.length} model${missing.length === 1 ? "" : "s"} missing`}{missing.length > 0 && failures.length > 0 && " · "}{failures.length > 0 && `${failures.length} node check${failures.length === 1 ? "" : "s"} need attention`}</p>
            {missing.length > 0 && <p>{formatSize(missing.reduce((total, model) => total + model.size, 0))} model downloads</p>}
            <div className="setup-actions">
              {manager && toInstall.length > 0 && <button className="setup-primary" disabled={installing || checking} onClick={() => void install()}>{installing ? "Starting…" : "Install missing"}</button>}
              <a href={report.address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
            </div>
            {unfinished.length > 0 && <div className="install-status"><p>{unfinished.some(task => task.state === "unknown" || task.state === "submitting") ? "Checking whether ComfyUI accepted the downloads…" : `Waiting for ${unfinished.length} download${unfinished.length === 1 ? "" : "s"}`}</p><button disabled={installing} onClick={() => void install(true)}>Resume downloads</button></div>}
            {tasks.filter(task => task.state === "failed" && missing.some(model => model.url === task.model.url)).map(task => <p className="failure-text" key={task.id}>{task.model.filename}: {task.error}</p>)}
            {tasks.some(task => task.state === "succeeded" && missing.some(model => model.url === task.model.url)) && <p>Downloaded. Check the model in ComfyUI and restart ComfyUI when idle.</p>}
            {!manager && missing.length > 0 && <details><summary>Enable downloads in ComfyUI</summary><p>Enable ComfyUI-Manager for automatic model downloads. You can also add the files below yourself.</p><a href="https://docs.comfy.org/manager" target="_blank" rel="noopener noreferrer">ComfyUI-Manager help</a></details>}
            <details className="requirement-details"><summary>Details</summary>
              {failures.map(check => <p key={check.name}><strong>{check.name.replace("node:", "")}</strong><br/>{check.message}</p>)}
              {report?.checks.filter(check => check.name.startsWith("download:")).map(check => <p key={check.name}>{check.message}</p>)}
              {failures.some(check => check.name.includes("MarcoStudio") || check.name === "h3_pdd") && <p><a href="./marcostudio-nodes.zip" download>Download MarcoStudio nodes</a><br/>Extract the marcostudio folder into ComfyUI’s custom_nodes folder. Restart ComfyUI when idle.</p>}
              <ul>{allModels.map(model => <li key={model.key}><a href={model.url}>{model.filename}</a><span>{model.category} · {formatSize(model.size)}</span><a href={`https://huggingface.co/${model.repository}`} target="_blank" rel="noopener noreferrer">Source &amp; license</a></li>)}</ul>
              <a href={tool.workflow_url} target="_blank" rel="noopener noreferrer">View workflow</a>{" · "}<a href={tool.source_url} target="_blank" rel="noopener noreferrer">Upstream source</a>
            </details>
          </>}
        </div>
      </li>
      <li className={ready ? "complete" : ""}><span className="step-mark">{ready ? <Check size={16}/> : "3"}</span><div><h3>{ready ? "Ready" : "Studio"}</h3><p>{ready ? `${feature?.name ?? "Relight"} is ready` : "Waiting for setup"}</p><button className="setup-primary" disabled={!ready} onClick={() => {localStorage.setItem(enteredKey(), "true"); close();}}>Open studio</button></div></li>
    </ol>
    {error && <div className="setup-error" role="alert"><p>{error}</p>{!report?.connected && <details><summary>Connection help</summary><p>Keep ComfyUI running on this computer and allow local network access if your browser asks.</p><p>Add this to your existing ComfyUI launch options, then restart ComfyUI when idle:</p><code>--enable-cors-header {location.origin}</code><button onClick={() => void navigator.clipboard.writeText(`--enable-cors-header ${location.origin}`).catch(() => setError("Select and copy the launch option above."))}>Copy</button><p>Using a phone? Its localhost is the phone. Use your computer’s reachable ComfyUI address.</p><button disabled={connecting} onClick={() => void connect()}>Try again</button></details>}</div>}
    <footer><button onClick={close}>Browse tools</button><a href="https://github.com/NeoMarcoPolo/marcostudio" target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={13}/></a></footer>
  </dialog>;
}
