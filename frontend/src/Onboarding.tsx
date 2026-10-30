import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import type { Doctor, Feature, FeatureId } from "./api";
import { getFeature } from "./browser/catalog";
import { CONNECTION_DRAFT_KEY, discover, endpoint, normalizeAddress, selectConnection } from "./browser/connection";
import { ConnectionHelp } from "./ConnectionHelp";
import { canInstall, installTasks, managerAvailable, reconcileInstalls, resumeDownloads, startDownloads, type InstallTask } from "./browser/manager";
import type { Requirements } from "./browser/requirements";

export const enteredKey = () => `marcostudio.entered:${endpoint()}`;
const formatSize = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

const downloadTips = [
  "Relight lets you adjust light direction, brightness, softness and color.",
  "Remove Background can create a transparent PNG from a photo.",
  "AI Stylist uses a photo of a person and an outfit reference.",
  "Product Scene can place a product in a scene described by a prompt or reference.",
  "Animate Image starts with a first frame and a prompt.",
];

function DownloadTips() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (paused || reducedMotion) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setIndex(previous => (previous + 1) % downloadTips.length);
    }, 15000);
    return () => clearInterval(timer);
  }, [paused, reducedMotion]);
  return <aside className="download-tip" aria-label="MarcoStudio tips">
    <div><strong>Did you know?</strong><p>{downloadTips[index]}</p></div>
    <div className="download-tip-actions">
      <button type="button" onClick={() => setIndex(previous => (previous + 1) % downloadTips.length)}>Next tip</button>
      {!reducedMotion && <button type="button" onClick={() => setPaused(value => !value)}>{paused ? "Play tips" : "Pause tips"}</button>}
    </div>
  </aside>;
}

export function DownloadProgress({tasks, active, installing, resume}: {
  tasks: InstallTask[]; active: InstallTask; installing: boolean; resume: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const batch = active.batchId ? tasks.filter(task => task.batchId === active.batchId) : [];
  const unfinished = (batch.length ? batch : [active]).filter(task => !["succeeded", "failed"].includes(task.state));
  const pending = unfinished.length > 0;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  // Older saved tasks have no batch identity or timestamp. Never invent either.
  const completed = batch.filter(task => task.state === "succeeded").length;
  const failed = batch.filter(task => task.state === "failed").length;
  const submittedAt = active.submittedAt;
  const finishTimes = batch.length ? batch.map(task => task.observedFinishedAt) : [active.observedFinishedAt];
  const finishTime = !pending && finishTimes.every(time => typeof time === "number" && Number.isFinite(time))
    ? Math.max(...finishTimes as number[]) : undefined;
  const end = pending ? now : finishTime;
  const elapsed = typeof submittedAt === "number" && Number.isFinite(submittedAt) && submittedAt <= now
    && typeof end === "number" && end >= submittedAt ? Math.floor((end - submittedAt) / 1000) : undefined;
  const elapsedText = elapsed === undefined ? "Elapsed time unavailable for this request."
    : `${pending ? "Elapsed since request" : "Time until completion observed"}: ${Math.floor(elapsed / 3600) > 0 ? `${Math.floor(elapsed / 3600)}h ` : ""}${Math.floor(elapsed % 3600 / 60)}m ${elapsed % 60}s`;
  return <section className="install-status" aria-label="Download progress">
    <div className="download-progress-summary">{batch.length > 0 ?
      <p>{completed} of {batch.length} tracked files completed{failed > 0 ? ` · ${failed} failed` : ""}</p>
      : <p>{pending ? "Checking download status" : active.state === "succeeded" ? "Download completed" : "Download failed"}</p>}
      <p>{elapsedText}</p></div>
    {batch.length > 0 ? <progress max={batch.length} value={completed} aria-label="Files completed"/>
      : pending && <progress aria-label="Download status"/>}
    {pending && <p>{unfinished.some(task => task.state === "unknown" || task.state === "submitting")
      ? "Waiting for ComfyUI to confirm the request." : "Queued or downloading in ComfyUI."}</p>}
    {pending && <><p>File percentage and remaining time are not available from ComfyUI Manager.</p>
      <button disabled={installing} onClick={resume}>Resume downloads</button><DownloadTips/></>}
  </section>;
}

export function Onboarding({feature, featureId, doctor, checking, locked, refresh, connected, close, notices, onConnection, onTasks}: {
  feature?: Feature; featureId: FeatureId; doctor?: Doctor; checking: boolean; locked: boolean;
  refresh: () => Promise<void>; connected: () => Promise<void>; close: () => void;
  notices?: ReactNode; onConnection?: (address: string, automatic?: boolean) => void;
  onTasks?: (address: string, tasks: InstallTask[], newTaskIds?: string[]) => void;
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
  const [reviewModels, setReviewModels] = useState(false);
  const [activeBatch, setActiveBatch] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const polling = useRef(false);
  const connectionPending = useRef(false);
  const current = useRef(true);
  const missing = report?.model_requirements?.filter(model => !model.available) ?? [];
  const downloadable = missing.filter(model => model.installable && canInstall(model));
  const unfinished = tasks.filter(task => missing.some(model => model.url === task.model.url) && !["failed", "succeeded"].includes(task.state));
  const relevantTasks = tasks.filter(task => report?.model_requirements?.some(model => model.url === task.model.url));
  const batchKey = (task: InstallTask) => task.batchId ? `batch:${task.batchId}` : `task:${task.id}`;
  const pendingBatches = [...new Map(relevantTasks.filter(task => !["failed", "succeeded"].includes(task.state))
    .map(task => [batchKey(task), task])).values()];
  const recentTask = pendingBatches.find(task => batchKey(task) === activeBatch) ?? pendingBatches[0] ?? relevantTasks.at(-1);
  const pendingDownloads = pendingBatches.length > 0;
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
  useEffect(() => { if (!pendingDownloads) setReviewModels(false); }, [pendingDownloads]);

  const recheck = useCallback(async () => {
    if (!current.current || polling.current || connectionPending.current || connectionHelp || !endpoint()) return;
    polling.current = true;
    try {
      onTasks?.(endpoint(), installTasks());
      await refresh();
      onTasks?.(endpoint(), installTasks());
      const available = await managerAvailable();
      if (current.current) setManager(available);
      if (available && !installing) {
        const next = await reconcileInstalls();
        if (current.current) { setTasks(next); onTasks?.(endpoint(), next); }
      }
    } catch (error) {
      if (current.current) setError(error instanceof Error ? error.message : "Couldn't check setup.");
    } finally { polling.current = false; }
  }, [refresh, installing, connectionHelp, onTasks]);

  useEffect(() => {
    void recheck();
    const timer = window.setInterval(() => { if (!document.hidden) void recheck(); }, 7000);
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [recheck]);

  const choose = useCallback(async (value: string, automatic = false) => {
    selectConnection(value); setAddress(value); setCandidates([]); setTasks(installTasks(value)); setSelected([]); setConfirmed("");
    onTasks?.(value, installTasks(value));
    setConnectionHelp(false); setError(""); setView("setup");
    await connected();
    if (current.current) onConnection?.(value, automatic);
    const available = await managerAvailable(value);
    if (current.current) setManager(available);
  }, [connected, onConnection, onTasks]);
  const connect = useCallback(async (value?: string, automatic = false) => {
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
      if (found.length === 1) await choose(found[0], automatic);
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
      if (!document.hidden) void connect(localStorage.getItem(CONNECTION_DRAFT_KEY) || endpoint() || undefined, true);
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => { window.removeEventListener("focus", retry); document.removeEventListener("visibilitychange", retry); };
  }, [connectionHelp, connect]);
  const install = async (resume = false) => {
    setInstalling(true); setError("");
    const target = endpoint();
    const existing = new Set(installTasks(target).map(task => task.id));
    const record = () => {
      const next = installTasks(target);
      onTasks?.(target, next, next.filter(task => !existing.has(task.id)).map(task => task.id));
      if (current.current) setTasks(next);
    };
    try {
      if (resume) await resumeDownloads();
      else {
        if (queueBlocked) throw new Error("Wait until the ComfyUI Manager queue is available and idle before starting new downloads.");
        if (!chosen.length || confirmed !== selectionKey) throw new Error("Select models and confirm the download first.");
        await startDownloads(chosen);
        if (current.current) { setSelected([]); setConfirmed(""); }
      }
      record();
      if (current.current) await refresh();
    } catch (error) {
      record();
      if (current.current) setError(error instanceof Error ? error.message : "Download failed.");
    } finally { if (current.current) setInstalling(false); }
  };
  const tool = getFeature(featureId);
  const name = feature?.name ?? "Relight";
  const selectedDetail = missing.find(model => model.url === view);
  const title = view === "setup" ? ["Connect ComfyUI", `Set up ${name}`, `${name} is ready`][step]
    : view === "connection" ? "ComfyUI address" : view === "requirements" ? "Setup details" : "Model details";
  return <dialog ref={dialog} className={`onboarding${pendingDownloads && !reviewModels && view === "setup" ? " has-download" : ""}`} aria-labelledby="onboarding-title" onCancel={event => {event.preventDefault(); close();}}>
    {notices}
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
        {(!pendingDownloads || reviewModels) && <p className="requirements-summary">{missing.length > 0 && <span>{missing.length} model{missing.length === 1 ? "" : "s"} missing</span>}{missing.length > 0 && <span> · {formatSize(missing.reduce((total, model) => total + model.size, 0))}</span>}{missing.length > 0 && failures.length > 0 && " · "}{failures.length > 0 && `${failures.length} node check${failures.length === 1 ? "" : "s"} need attention`}</p>}
        {pendingDownloads && reviewModels && <button className="setup-back" onClick={() => setReviewModels(false)}>← Back to download progress</button>}
        {(!pendingDownloads || reviewModels) && missing.length > 0 && <section className="model-selection" aria-labelledby="missing-models-title">
          <h3 id="missing-models-title">Missing models</h3>
          <p>Available disk space cannot be checked here. Check the drive where ComfyUI stores models, including extra room for temporary files.</p>
          {!pendingDownloads && manager && toInstall.length > 0 && <label className="model-select-all"><input type="checkbox" checked={allSelected} disabled={installing || checking}
            onChange={event => { setSelected(event.target.checked ? toInstall.map(model => model.url) : []); setConfirmed(""); }}/> Select all available downloads</label>}
          <ul>{missing.map(model => {
            const queued = tasks.some(task => task.model.url === model.url && !["failed", "succeeded"].includes(task.state));
            const eligible = !pendingDownloads && manager && toInstall.some(item => item.url === model.url);
            return <li key={model.key}>
              <div className="model-choice">
                {eligible ? <label className="model-name"><input type="checkbox" aria-label={`Select ${model.filename}`} checked={selected.includes(model.url)} disabled={installing || checking}
                  onChange={event => { setSelected(previous => event.target.checked ? [...previous, model.url] : previous.filter(url => url !== model.url)); setConfirmed(""); }}/><span>{model.filename}</span></label>
                  : <span className="model-name model-unavailable">{model.filename}</span>}
                <span className="model-size">{formatSize(model.size)}</span>
                <button className="model-details-button" aria-label={`Details for ${model.filename}`} onClick={() => setView(model.url)}>Details</button>
              </div>
              {queued && <span className="model-state">Already queued</span>}
              {!queued && !eligible && <span className="model-state">{pendingDownloads ? "Available after the current download finishes" : manager ? "Manual download required" : "Enable ComfyUI-Manager for automatic downloads, or download manually"}</span>}
            </li>;
          })}</ul>
          {!pendingDownloads && manager && toInstall.length > 0 && <>
            <p>{chosen.length} selected · {formatSize(selectedSize)}</p>
            <label className="model-confirm"><input type="checkbox" checked={chosen.length > 0 && confirmed === selectionKey} disabled={!chosen.length || installing || checking}
              onChange={event => setConfirmed(event.target.checked ? selectionKey : "")}/> I confirm downloading the selected models to this ComfyUI computer.</label>
          </>}
        </section>}
        {!pendingDownloads && <div className="setup-actions">
          {manager && toInstall.length > 0 && <button className="setup-primary" disabled={installing || checking || queueBlocked || !chosen.length || confirmed !== selectionKey} onClick={() => void install()}>{installing ? "Starting…" : "Download selected"}</button>}
          <a href={report?.address} target="_blank" rel="noopener noreferrer">Open ComfyUI <ExternalLink size={13}/></a>
        </div>}
        {!reviewModels && report?.checks.filter(check => check.name === "manager:queue" && check.status === "fail"
          && !(pendingDownloads && check.message === "ComfyUI Manager has downloads or other setup tasks in progress. Wait for its queue to finish, then check again."))
          .map(check => <p className="failure-text" role="status" key={check.name}>{check.message}</p>)}
        {!reviewModels && pendingBatches.length > 1 && <label className="batch-picker">Download batch <select value={batchKey(recentTask!)} onChange={event => setActiveBatch(event.target.value)}>{pendingBatches.map((task, index) => <option key={batchKey(task)} value={batchKey(task)}>Batch {index + 1} · {task.model.filename}</option>)}</select></label>}
        {!reviewModels && recentTask && <DownloadProgress tasks={tasks} active={recentTask} installing={installing} resume={() => void install(true)}/>}
        {pendingDownloads && !reviewModels && missing.length > 0 && <button className="setup-back" onClick={() => setReviewModels(true)}>Review missing models</button>}
        {tasks.filter(task => task.state === "failed" && missing.some(model => model.url === task.model.url)).map(task => <p className="failure-text" key={task.id}>{task.model.filename}: {task.error}</p>)}
        {tasks.some(task => task.state === "succeeded" && missing.some(model => model.url === task.model.url)) && <p>Downloaded. Restart ComfyUI when idle to load the model.</p>}
        {!reviewModels && <div className="setup-secondary"><button onClick={() => setView("requirements")}>Models and nodes</button><button onClick={() => setView("connection")}>Change address</button></div>}
      </>}
      {view === "setup" && step === 2 && <>{recentTask && <DownloadProgress tasks={tasks} active={recentTask} installing={installing} resume={() => void install(true)}/>}<button className="setup-primary" disabled={!ready} onClick={() => {localStorage.setItem(enteredKey(), "true"); close();}}>Open studio</button></>}
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
