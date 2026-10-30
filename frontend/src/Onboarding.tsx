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

export function Onboarding({feature, featureId, doctor, checking, locked, refresh, connected, close}: {
  feature?: Feature; featureId: FeatureId; doctor?: Doctor; checking: boolean; locked: boolean;
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
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState("");
  const [view, setView] = useState<"setup" | "requirements" | "connection" | string>("setup");
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const polling = useRef(false);
  const connectionPending = useRef(false);
  const current = useRef(true);
  const missing = report?.model_requirements?.filter(model => !model.available) ?? [];
  const downloadable = missing.filter(model => model.installable && canInstall(model));
  const unfinished = tasks.filter(task => missing.some(model => model.url === task.model.url) && !["failed", "succeeded"].includes(task.state));
  const toInstall = downloadable.filter(model => !tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state)));
  const queueBlocked = !!report?.checks.some(check => check.name === "manager:queue" && check.status === "fail");
  const eligibleKey = JSON.stringify([endpoint(), queueBlocked, toInstall.map(model => [model.url, model.size] as const).sort(([a], [b]) => a.localeCompare(b))]);
  const chosen = toInstall.filter(model => selected.includes(model.url));
  const selectionKey = JSON.stringify([eligibleKey, chosen.map(model => [model.url, model.size] as const).sort(([a], [b]) => a.localeCompare(b))]);
  const selectedSize = chosen.reduce((total, model) => total + model.size, 0);
  const allSelected = toInstall.length > 0 && chosen.length === toInstall.length;
  const failures = report?.checks.filter(check => check.status === "fail" && (check.name.startsWith("node:") || check.name === "h3_pdd")) ?? [];
  const connectedHere = !!report?.connected && report.address === endpoint() && !connectionHelp && !connecting;
  const ready = !!report?.ready && !checking && connectedHere;
  const step = connectedHere ? report.ready ? 2 : 1 : 0;
  const connectionBusy = connecting || locked || installing || unfinished.length > 0;

  useEffect(() => {
    current.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => { current.current = false; document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);

  useEffect(() => { heading.current?.focus(); }, [step, view]);
  useEffect(() => { setConfirmed(""); }, [eligibleKey]);

  const recheck = useCallback(async () => {
    if (!current.current || polling.current || connectionPending.current || connectionHelp || !endpoint()) return;
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
  }, [refresh, installing, connectionHelp]);

  useEffect(() => {
    void recheck();
    const timer = window.setInterval(() => { if (!document.hidden) void recheck(); }, 7000);
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [recheck]);

  const choose = useCallback(async (value: string) => {
    selectConnection(value); setAddress(value); setCandidates([]); setTasks(installTasks(value)); setSelected([]); setConfirmed("");
    setConnectionHelp(false); setError(""); setView("setup");
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
        setConnectionHelp(true); setView("setup");
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
      else {
        if (queueBlocked) throw new Error("Wait until the ComfyUI Manager queue is available and idle before starting new downloads.");
        if (!chosen.length || confirmed !== selectionKey) throw new Error("Select models and confirm the download first.");
        await startDownloads(chosen);
        if (current.current) { setSelected([]); setConfirmed(""); }
      }
      if (current.current) setTasks(installTasks());
      await refresh();
    } catch (error) {
      if (current.current) { setTasks(installTasks()); setError(error instanceof Error ? error.message : "Download failed."); }
    } finally { if (current.current) setInstalling(false); }
  };
  const tool = getFeature(featureId);
  const name = feature?.name ?? "Relight";
  const selectedDetail = missing.find(model => model.url === view);
  const title = view === "setup" ? ["Connect ComfyUI", `Set up ${name}`, `${name} is ready`][step]
    : view === "connection" ? "ComfyUI address" : view === "requirements" ? "Setup details" : "Model details";
  return <dialog ref={dialog} className="onboarding" aria-labelledby="onboarding-title" onCancel={event => {event.preventDefault(); close();}}>
    <div className="onboarding-heading"><h2 ref={heading} tabIndex={-1} id="onboarding-title">{title}</h2><button aria-label="Close setup" onClick={close}><X size={19}/></button></div>
    <ol className="setup-progress" aria-label="Setup progress">
      {["Connect", "Set up", "Ready"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={step > index ? "complete" : ""}><span aria-hidden="true">{step > index ? <Check size={12}/> : index + 1}</span>{label}</li>)}
    </ol>
    <div className="setup-panel">
      {view !== "setup" && <button className="setup-back" onClick={() => setView("setup")}>← Back to setup</button>}
      {view === "setup" && step === 0 && <>
        {connectionHelp ? <ConnectionHelp address={localStorage.getItem(CONNECTION_DRAFT_KEY) || endpoint() || "http://127.0.0.1:8188"} error={error}
          busy={connectionBusy} retry={() => void connect(address)}/> : candidates.length > 1 ?
          <div className="instance-choices"><p>Choose your ComfyUI</p>{candidates.map(value => <button key={value} disabled={connectionBusy} onClick={() => void choose(value).catch(error => setError(String(error)))}>{value}</button>)}</div> : <>
            <p>Start ComfyUI on this computer, then connect.</p>
            <button className="setup-primary" disabled={connectionBusy} onClick={() => void connect(address)}>{connecting ? "Connecting…" : "Connect"}</button>
          </>}
      </>}
      {view === "setup" && connectedHere && <p className="setup-connected"><Check size={14}/> ComfyUI connected</p>}
      {view === "setup" && step === 1 && <>
        <p className="requirements-summary">{missing.length > 0 && <span>{missing.length} model{missing.length === 1 ? "" : "s"} missing</span>}{missing.length > 0 && <span> · {formatSize(missing.reduce((total, model) => total + model.size, 0))}</span>}{missing.length > 0 && failures.length > 0 && " · "}{failures.length > 0 && `${failures.length} node check${failures.length === 1 ? "" : "s"} need attention`}</p>
        {missing.length > 0 && <section className="model-selection" aria-labelledby="missing-models-title">
          <h3 id="missing-models-title">Missing models</h3>
          <p>Downloads use space on the computer running ComfyUI. Check that it has enough free space, including extra room for temporary files.</p>
          {manager && toInstall.length > 0 && <label className="model-select-all"><input type="checkbox" checked={allSelected} disabled={installing || checking}
            onChange={event => { setSelected(event.target.checked ? toInstall.map(model => model.url) : []); setConfirmed(""); }}/> Select all available downloads</label>}
          <ul>{missing.map(model => {
            const queued = tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state));
            const eligible = manager && toInstall.some(item => item.url === model.url);
            return <li key={model.key}>
              <div className="model-choice">
                {eligible ? <label className="model-name"><input type="checkbox" aria-label={`Select ${model.filename}`} checked={selected.includes(model.url)} disabled={installing || checking}
                  onChange={event => { setSelected(previous => event.target.checked ? [...previous, model.url] : previous.filter(url => url !== model.url)); setConfirmed(""); }}/><span>{model.filename}</span></label>
                  : <span className="model-name model-unavailable">{model.filename}</span>}
                <span className="model-size">{formatSize(model.size)}</span>
              </div>
              {queued && <span className="model-state">Already queued</span>}
              {!queued && !eligible && <span className="model-state">{manager ? "Manual download required" : "Enable ComfyUI-Manager for automatic downloads, or download manually"}</span>}
              <button className="model-details-button" aria-label={`Details for ${model.filename}`} onClick={() => setView(model.url)}>Details</button>
            </li>;
          })}</ul>
          {manager && toInstall.length > 0 && <>
            <p>{chosen.length} selected · {formatSize(selectedSize)}</p>
            <label className="model-confirm"><input type="checkbox" checked={chosen.length > 0 && confirmed === selectionKey} disabled={!chosen.length || installing || checking}
              onChange={event => setConfirmed(event.target.checked ? selectionKey : "")}/> I confirm downloading the selected models to this ComfyUI computer.</label>
          </>}
        </section>}
        <div className="setup-actions">
          {manager && toInstall.length > 0 && <button className="setup-primary" disabled={installing || checking || queueBlocked || !chosen.length || confirmed !== selectionKey} onClick={() => void install()}>{installing ? "Starting…" : "Download selected"}</button>}
          <a href={report?.address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
        </div>
        {report?.checks.filter(check => check.name === "manager:queue" && check.status === "fail").map(check => <p className="failure-text" role="status" key={check.name}>{check.message}</p>)}
        {unfinished.length > 0 && <div className="install-status"><p>{unfinished.some(task => task.state === "unknown" || task.state === "submitting") ? "Checking downloads…" : `Waiting for ${unfinished.length} download${unfinished.length === 1 ? "" : "s"}`}</p><button disabled={installing} onClick={() => void install(true)}>Resume downloads</button></div>}
        {tasks.filter(task => task.state === "failed" && missing.some(model => model.url === task.model.url)).map(task => <p className="failure-text" key={task.id}>{task.model.filename}: {task.error}</p>)}
        {tasks.some(task => task.state === "succeeded" && missing.some(model => model.url === task.model.url)) && <p>Downloaded. Restart ComfyUI when idle to load the model.</p>}
        <div className="setup-secondary"><button onClick={() => setView("requirements")}>Models and nodes</button><button onClick={() => setView("connection")}>Change address</button></div>
      </>}
      {view === "setup" && step === 2 && <button className="setup-primary" disabled={!ready} onClick={() => {localStorage.setItem(enteredKey(), "true"); close();}}>Open studio</button>}
      {view === "setup" && step !== 1 && <div className="setup-secondary"><button onClick={() => setView("connection")}>Change address</button></div>}
      {view === "requirements" && <section className="requirement-details">
          {!manager && missing.length > 0 && <p><a href="https://docs.comfy.org/manager" target="_blank" rel="noopener noreferrer">Enable ComfyUI-Manager</a> for automatic downloads, or add the files below.</p>}
          {failures.map(check => <p key={check.name}><strong>{check.name.replace("node:", "")}</strong><br/>{check.message}</p>)}
          {report?.checks.filter(check => check.name.startsWith("download:")).map(check => <p key={check.name}>{check.message}</p>)}
          {failures.some(check => check.name.includes("MarcoStudio") || check.name === "h3_pdd") && <p><a href="./marcostudio-nodes.zip" download>Download MarcoStudio nodes</a><br/>Extract the marcostudio folder into ComfyUI’s custom_nodes folder. Restart ComfyUI when idle.</p>}
          <a href={tool.workflow_url} target="_blank" rel="noopener noreferrer">View workflow</a>{" · "}<a href={tool.source_url} target="_blank" rel="noopener noreferrer">Upstream source</a>
      </section>}
      {view !== "setup" && view !== "connection" && view !== "requirements" && <section className="model-detail-view">
        {selectedDetail ? <><p className="model-detail-name">{selectedDetail.filename}</p><p>{selectedDetail.category} · {formatSize(selectedDetail.size)}</p>
          <p><a href={selectedDetail.url}>Download manually</a></p><p><a href={`https://huggingface.co/${selectedDetail.repository}`} target="_blank" rel="noopener noreferrer">Source &amp; license</a></p></>
          : <p>This model is no longer listed as missing.</p>}
      </section>}
      {view === "connection" && <section className="connection-options">
        <form onSubmit={event => {event.preventDefault(); void connect(address);}}><label htmlFor="comfy-address">ComfyUI address</label><input id="comfy-address" type="url" value={address} placeholder="http://127.0.0.1:8188" disabled={connectionBusy} onChange={event => setAddress(event.target.value)}/>
          <button disabled={connectionBusy || !address.trim()}>Connect</button></form>
        <p>Use the address that opens ComfyUI on this device.</p>
      </section>}
    </div>
    {error && !connectionHelp && <div className="setup-error" role="alert"><p>{error}</p></div>}
    <footer><button onClick={close}>Browse tools</button><a href="https://github.com/NeoMarcoPolo/marcostudio" target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={13}/></a></footer>
  </dialog>;
}
