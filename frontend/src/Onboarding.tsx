import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import type { Doctor, Feature, FeatureId } from "./api";
import { getFeature } from "./browser/catalog";
import { CONNECTION_DRAFT_KEY, discover, endpoint, normalizeAddress, selectConnection } from "./browser/connection";
import { ConnectionHelp } from "./ConnectionHelp";
import { canInstall, installTasks, managerAvailable, reconcileInstalls, resumeDownloads, startDownloads, type InstallTask } from "./browser/manager";
import type { Requirements } from "./browser/requirements";

export const enteredKey = () => `marcostudio.entered:${endpoint()}`;
const formatSize = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function Onboarding({feature, featureId, mode, doctor, checking, locked, refresh, connected, close}: {
  feature?: Feature; featureId: FeatureId; mode: string; doctor?: Doctor; checking: boolean; locked: boolean;
  refresh: () => Promise<void>; connected: () => Promise<void>; close: () => void;
}) {
  const report = doctor as Requirements | undefined;
  const [address, setAddress] = useState(() => localStorage.getItem(CONNECTION_DRAFT_KEY) || endpoint());
  const [connectionHelp, setConnectionHelp] = useState(() => !!localStorage.getItem(CONNECTION_DRAFT_KEY));
  const [candidates, setCandidates] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [manager, setManager] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [tasks, setTasks] = useState<InstallTask[]>(() => installTasks());
  const dialog = useRef<HTMLDialogElement>(null);
  const polling = useRef(false);
  const connectionPending = useRef(false);
  const current = useRef(true);
  const missing = report?.model_requirements?.filter(model => !model.available) ?? [];
  const downloadable = missing.filter(model => model.installable && canInstall(model));
  const unfinished = tasks.filter(task => missing.some(model => model.url === task.model.url) && !["failed", "succeeded"].includes(task.state));
  const toInstall = downloadable.filter(model => !tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state)));
  const failures = report?.checks.filter(check => check.status === "fail" && (check.name.startsWith("node:") || check.name === "h3_pdd")) ?? [];
  const connectedHere = !!report?.connected && !connectionHelp;
  const ready = !!report?.ready && !checking && connectedHere;

  useEffect(() => {
    current.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => { current.current = false; document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);

  const recheck = useCallback(async () => {
    if (!current.current || polling.current || connectionPending.current || !endpoint()) return;
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

  const choose = useCallback(async (value: string) => {
    selectConnection(value); setAddress(value); setCandidates([]); setTasks(installTasks(value));
    setConnectionHelp(false); setError("");
    await connected();
    const available = await managerAvailable(value);
    if (current.current) setManager(available);
  }, [connected]);
  const connect = useCallback(async (value?: string) => {
    if (!current.current || connectionPending.current || locked || installing || unfinished.length > 0) return;
    connectionPending.current = true;
    setConnecting(true); setError("");
    try {
      const target = value?.trim() ? normalizeAddress(value.trim()) : undefined;
      if (target) {
        localStorage.setItem(CONNECTION_DRAFT_KEY, target);
        setAddress(target);
      }
      const found = await discover(target);
      if (!current.current) return;
      if (found.length === 1) await choose(found[0]);
      else { setConnectionHelp(false); setCandidates(found); }
    } catch (error) {
      if (current.current) {
        setError(error instanceof Error ? error.message : "Couldn't connect to ComfyUI.");
        setConnectionHelp(true);
      }
    } finally { connectionPending.current = false; if (current.current) setConnecting(false); }
  }, [choose, locked, installing, unfinished.length]);

  useEffect(() => {
    if (!connectionHelp) return;
    const retry = () => {
      if (!document.hidden) void connect(localStorage.getItem(CONNECTION_DRAFT_KEY) || endpoint() || undefined);
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => { window.removeEventListener("focus", retry); document.removeEventListener("visibilitychange", retry); };
  }, [connectionHelp, connect]);
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
      <li className={connectedHere ? "complete" : ""}>
        <span className="step-mark">{connectedHere ? <Check size={16}/> : "1"}</span>
        <div><h3>{connectedHere ? "ComfyUI detected" : "ComfyUI"}</h3>
          {connectedHere ? <p className="connection-address">{report.address}</p> : !connectionHelp && <>
            <button className="setup-primary" disabled={connecting || locked} onClick={() => void connect(address)}>{connecting ? "Connecting…" : "Connect"}</button>
            <p>Allow local-network access if your browser asks.</p>
          </>}
          {connectionHelp && <ConnectionHelp address={localStorage.getItem(CONNECTION_DRAFT_KEY) || endpoint() || "http://127.0.0.1:8188"} error={error}
            busy={connecting || locked || installing || unfinished.length > 0} retry={() => void connect(address)}/>}
          {candidates.length > 1 && <div className="instance-choices"><p>Choose your ComfyUI</p>{candidates.map(value => <button key={value} onClick={() => void choose(value).catch(error => setError(String(error)))}>{value}</button>)}</div>}
          {(connectionHelp || error || report?.connected || endpoint()) && <details className="connection-options"><summary>Use another address</summary>
            <form onSubmit={event => {event.preventDefault(); void connect(address);}}><label htmlFor="comfy-address">ComfyUI address</label><input id="comfy-address" type="url" value={address} placeholder="http://127.0.0.1:8188" disabled={locked || connecting || installing || unfinished.length > 0} onChange={event => setAddress(event.target.value)}/>
              <button disabled={locked || connecting || installing || unfinished.length > 0 || !address.trim()}>Connect</button></form></details>}
        </div>
      </li>
      <li className={connectedHere && report?.ready ? "complete" : ""}>
        <span className="step-mark">{connectedHere && report?.ready ? <Check size={16}/> : "2"}</span>
        <div><h3>Models and nodes</h3>
          {!connectedHere ? <p>Connect to check</p> : checking ? <p>Checking {feature?.name}…</p> : report.ready ? <p>Installed</p> : <>
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
    {error && !connectionHelp && <div className="setup-error" role="alert"><p>{error}</p></div>}
    <footer><button onClick={close}>Browse tools</button><a href="https://github.com/NeoMarcoPolo/marcostudio" target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={13}/></a></footer>
  </dialog>;
}
