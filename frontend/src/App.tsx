import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  active,
  api,
  post,
  ServiceError,
  videoFrames,
  isBrowserRuntime,
  type Asset,
  type CreativeFeatureId,
  type CreativeSettings,
  type Doctor,
  type Feature,
  type FeatureId,
  type Job,
  type RelightSettings,
  type RemoveBackgroundSettings,
  type StudioSettings,
} from "./api";
import { RelightControls } from "./RelightControls";
import { SettingsDialog } from "./SettingsDialog";
import { Onboarding, enteredKey } from "./Onboarding";
import { downloadAsset } from "./browser/assets";
import { draftAssets, savedDraft, saveDraft } from "./browser/draft";
import { InputAssets, SourceInput, ToolControls } from "./ToolControls";
import { MediaPreview } from "./MediaPreview";
import { ToolNavigation, toolGroup, toolIcons } from "./ToolNavigation";
import { SampleHelp } from "./SampleHelp";
import { Notifications, useNotifications } from "./Notifications";
import { endpoint } from "./browser/connection";
import { installTasks, reconcileInstalls, type InstallTask } from "./browser/manager";
import { createDownloadSnapshots, observeDownloadTasks, shouldAnnounceConnection } from "./notificationEvents";
import { Aperture, ArrowDownToLine, ArrowUpRight, ChevronRight, History, Plus, Settings2, Sparkles, Video, X } from "lucide-react";
import "./style.css";

const initial: RelightSettings = {
  direction: "front",
  softness: "soft",
  brightness: 50,
  color: "#ffffff",
  mode: "flash",
  seed: 0,
};

type Submission = { url: string; body: unknown };
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const label = (status: string) =>
  status === "abandoned" ? "Stopped tracking" : status.replaceAll("_", " ");
const activityLabel = (status: string) =>
  ({
    preparing: "Preparing…",
    submitting: "Submitting…",
    queued: "Queued",
    running: "Generating…",
    cancel_requested: "Cancelling…",
    needs_attention: "Checking job status…",
  })[status] ?? label(status);

export default function App() {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [featureId, setFeatureId] = useState<FeatureId>(() => isBrowserRuntime() ? savedDraft()?.featureId ?? "relight" : "relight");
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState(initial);
  const [backgroundSettings, setBackgroundSettings] =
    useState<RemoveBackgroundSettings>({ mode: "standard", seed: 0 });
  const [creativeSettings, setCreativeSettings] = useState<Partial<Record<CreativeFeatureId, CreativeSettings>>>({});
  const [inputs, setInputs] = useState<Record<string, Asset>>({});
  const feature = features.find((item) => item.id === featureId);
  const isRelight = featureId === "relight";
  const isBackground = featureId === "remove-background";
  const creative = isRelight || isBackground ? undefined : creativeSettings[featureId];
  const toolSettings = isRelight ? settings : isBackground ? backgroundSettings : creative ?? {mode: "standard" as const, seed: 0};
  const sourceKind = feature?.source_kind ?? "image";
  const hasSidePanel = isRelight || isBackground;
  const ToolIcon = toolIcons[featureId];
  const resultLabel = isRelight ? "Relit" : isBackground ? "Cutout" : "Result";
  const changeCreative = (patch: Partial<CreativeSettings>) => {
    if (featureId === "relight" || featureId === "remove-background") return;
    setCreativeSettings(previous => {
      const current = previous[featureId];
      return current ? {...previous, [featureId]: {...current, ...patch}} : previous;
    });
  };
  const [studio, setStudio] = useState<StudioSettings>();
  const [doctor, setDoctor] = useState<Doctor>();
  const [checking, setChecking] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string>();
  const [source, setSource] = useState<Asset>();
  const [uploading, setUploading] = useState(false);
  const [loadingSelection, setLoadingSelection] = useState(false);
  const [posting, setPosting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveFor, setResolveFor] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<Submission>();
  const [showSettings, setShowSettings] = useState(false);
  const {notices, notify, dismiss, announced} = useNotifications();
  const downloadBaseline = useRef(createDownloadSnapshots());
  const lastConnection = useRef("");
  const jobBaseline = useRef(new Map<string, string>());
  const jobsInitialized = useRef(false);
  const observeDownloads = useCallback((address: string, tasks: InstallTask[], newTaskIds: string[] = []) => {
    for (const event of observeDownloadTasks(downloadBaseline.current, address, tasks, newTaskIds)) notify(event.text, event.failure);
  }, [notify]);
  const observeConnection = useCallback((address: string, automatic = false) => {
    if (shouldAnnounceConnection(lastConnection.current, address, automatic)) notify(`ComfyUI connected at ${address}`);
    lastConnection.current = address;
  }, [notify]);
  const [comparison, setComparison] = useState(50);
  const [view, setView] = useState<"result" | "compare">("result");
  const busy = useRef(false);
  const alive = useRef(true);
  const sourceSequence = useRef(0);
  const sourceMutation = useRef(false);
  const doctorSequence = useRef(0);
  const job = jobs.find((item) => item.id === selected);
  useEffect(() => {
    if (!loaded) return;
    if (!jobsInitialized.current) { jobs.forEach(item => jobBaseline.current.set(item.id, item.status)); jobsInitialized.current = true; return; }
    for (const item of jobs) {
      const previous = jobBaseline.current.get(item.id);
      if (previous && !["failed", "succeeded", "canceled", "abandoned"].includes(previous) && item.status === "failed") {
        const time = typeof item.elapsed_seconds === "number" && Number.isFinite(item.elapsed_seconds) && item.elapsed_seconds >= 0
          ? ` after ${Math.floor(item.elapsed_seconds)}s` : "";
        notify(`${features.find(feature => feature.id === item.feature)?.name ?? item.feature} task failed${time}. See task history for details.`, true);
      }
      jobBaseline.current.set(item.id, item.status);
    }
  }, [jobs, loaded, features, notify]);
  useEffect(() => {
    if (!isBrowserRuntime() || showSettings) return;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      const address = endpoint();
      if (!address || busy || document.hidden) return;
      busy = true;
      try {
        const before = installTasks(address); observeDownloads(address, before);
        if (before.some(task => task.state !== "succeeded" && task.state !== "failed")) {
          const after = await reconcileInstalls(address);
          if (!stopped && address === endpoint()) observeDownloads(address, after);
        }
      } catch (error) { if (!stopped) console.warn("Unable to check model download status", error); }
      finally { busy = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 7000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [showSettings, observeDownloads]);
  const result = job?.status === "succeeded" ? job.outputs[0] : undefined;
  const selectedActive = !!job && active(job);
  const activeJob =
    jobs.find((item) => item.status === "running") ?? jobs.find(active);
  const uncertainJob = jobs.some((item) => item.status === "needs_attention");
  const sourceBusy = uploading || posting || loadingSelection || resolving;
  const validSeed =
    Number.isSafeInteger(toolSettings.seed) && toolSettings.seed >= 0;
  const validInputs = feature?.input_slots?.every(slot => !slot.required || inputs[slot.key]) ?? true;
  const needsPrompt = !isRelight && !isBackground && !["ai-stylist", "product-scene"].includes(featureId);
  const validGuides = featureId !== "keyframes" || !!creative?.guide_frames?.every((frame, index, frames) =>
    Number.isInteger(frame) && frame > (frames[index - 1] ?? 0) && frame < videoFrames(creative.duration ?? 5));
  const canCompare = source?.media_type.startsWith("image/") && result?.media_type.startsWith("image/");
  const enabled =
    doctor?.ready &&
    !checking &&
    feature?.supported_modes.includes(toolSettings.mode) &&
    (sourceKind === "none" || source?.media_type.startsWith(`${sourceKind}/`)) &&
    validInputs && validGuides && (!needsPrompt || !!creative?.instruction.trim()) &&
    validSeed &&
    !sourceBusy &&
    !selectedActive &&
    !uncertainJob &&
    !retry;
  const upsert = useCallback(
    (updated: Job) =>
      setJobs((previous) =>
        [updated, ...previous.filter((item) => item.id !== updated.id)].sort(
          (a, b) => b.created_at.localeCompare(a.created_at),
        ),
      ),
    [],
  );
  const refreshDoctor = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++doctorSequence.current;
      const isCurrent = () => alive.current && !signal?.aborted && sequence === doctorSequence.current;
      setChecking(true);
      if (!isBrowserRuntime()) setDoctor(undefined);
      try {
        const report = await api<Doctor>(`/api/doctor?feature=${featureId}&mode=${toolSettings.mode}`, {
          signal,
        });
        if (isCurrent()) setDoctor(report);
      } catch (e) {
        if (isCurrent()) setError(message(e));
      } finally {
        if (isCurrent()) setChecking(false);
      }
    },
    [featureId, toolSettings.mode],
  );
  const closeSettings = useCallback(() => setShowSettings(false), []);
  useEffect(() => {
    if (isBrowserRuntime() && studio && !checking && doctor && (!doctor.ready || !localStorage.getItem(enteredKey())))
      setShowSettings(true);
  }, [studio, checking, doctor, featureId, toolSettings.mode]);
  useEffect(() => {
    if (!isBrowserRuntime()) return;
    const focus = () => { if (!showSettings) void refreshDoctor(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refreshDoctor, showSettings]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const load = async () => {
      const results = await Promise.allSettled([
        api<Feature[]>("/api/features", { signal: controller.signal }),
        api<StudioSettings>("/api/settings", { signal: controller.signal }),
        api<Job[]>("/api/jobs", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const [features, configuration, history] = results;
      if (features.status === "fulfilled") {
        setFeatures(features.value);
        const relight = features.value.find((item) => item.id === "relight");
        if (relight && "direction" in relight.defaults)
          setSettings(relight.defaults);
        const background = features.value.find(
          (item) => item.id === "remove-background",
        );
        if (background?.defaults.mode === "standard")
          setBackgroundSettings({mode: "standard", seed: background.defaults.seed});
        setCreativeSettings(Object.fromEntries(features.value
          .filter(item => item.id !== "relight" && item.id !== "remove-background")
          .map(item => [item.id, item.defaults])));
      }
      if (configuration.status === "fulfilled") setStudio(configuration.value);
      if (history.status === "fulfilled") setJobs(history.value);
      const failure = results.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") setError(message(failure.reason));
      if (isBrowserRuntime()) {
        const draft = savedDraft();
        if (draft) {
          setSettings(draft.settings); setBackgroundSettings(draft.backgroundSettings);
          setCreativeSettings(previous => ({...previous, ...draft.creativeSettings}));
          setSelected(draft.selected);
          try {
            const assets = await draftAssets(draft);
            if (!controller.signal.aborted && sourceSequence.current === 0) {setSource(assets.source); setInputs(assets.inputs);}
          } catch { if (!controller.signal.aborted) setError("A saved input is unavailable. Add it again to continue."); }
        }
      }
      if (!controller.signal.aborted) setLoaded(true);
    };
    void load();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!isBrowserRuntime() || !loaded) return;
    try { saveDraft({featureId, settings, backgroundSettings, creativeSettings, sourceId: source?.id,
      inputIds: Object.fromEntries(Object.entries(inputs).map(([key, asset]) => [key, asset.id])), selected}); }
    catch (error) { setError(message(error)); }
  }, [loaded, featureId, settings, backgroundSettings, creativeSettings, source, inputs, selected]);
  useEffect(() => {
    const controller = new AbortController();
    void refreshDoctor(controller.signal);
    return () => controller.abort();
  }, [refreshDoctor]);
  const switchTool = (id: FeatureId) => {
    if (busy.current || sourceMutation.current || retry || id === featureId)
      return;
    setFeatureId(id);
    const kind = features.find(item => item.id === id)?.source_kind ?? "image";
    if (kind === "none" || !source?.media_type.startsWith(`${kind}/`)) setSource(undefined);
    setInputs({});
    setDoctor(undefined);
    setChecking(true);
    setSelected(undefined);
    setResolveFor(undefined);
    setView("result");
  };
  const activeIds = jobs
    .filter(active)
    .map((item) => item.id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!activeIds) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      const results = await Promise.allSettled(
        activeIds.split(",").map((id) =>
          api<Job>(`/api/jobs/${encodeURIComponent(id)}`, {
            signal: controller.signal,
          }),
        ),
      );
      if (stopped) return;
      for (const item of results) {
        if (item.status === "fulfilled") upsert(item.value);
        else setError(message(item.reason));
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeIds, upsert]);
  const upload = async (file?: File, slot?: string) => {
    if (!file || busy.current || sourceMutation.current) return;
    sourceMutation.current = true;
    setError("");
    setUploading(true);
    const sequence = ++sourceSequence.current;
    try {
      const form = new FormData();
      form.append("file", file);
      const asset = await api<Asset>("/api/assets", {
        method: "POST",
        body: form,
      });
      if (alive.current && sequence === sourceSequence.current) {
        if (slot) {
          setInputs(previous => ({...previous, [slot]: asset}));
          if (featureId === "keyframes") {
            const index = Number(slot.split("_")[1]) - 1;
            const frames = [...(creative?.guide_frames ?? [])];
            for (let i = frames.length; i <= index; i++) frames[i] = (frames[i - 1] ?? 24) + 24;
            changeCreative({guide_frames: frames.slice(0, Math.max(index + 1, Object.keys(inputs).length))});
          }
        } else setSource(asset);
        setSelected(undefined);
        setRetry(undefined);
      }
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      sourceMutation.current = false;
      if (alive.current) setUploading(false);
    }
  };
  const loadSample = async () => {
    if (source || busy.current || sourceMutation.current || sourceKind !== "image") return;
    sourceMutation.current = true;
    setUploading(true);
    setError("");
    const sequence = ++sourceSequence.current;
    try {
      const response = await fetch("./sample-image.jpg");
      if (!response.ok) throw new Error("Couldn't load the sample image. Try again.");
      const blob = await response.blob();
      if (!alive.current || sequence !== sourceSequence.current) return;
      sourceMutation.current = false;
      await upload(new File([blob], "marcostudio-sample.jpg", {type: "image/jpeg"}));
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      sourceMutation.current = false;
      if (alive.current) setUploading(false);
    }
  };
  const removeInput = (key: string) => {
    if (busy.current || sourceMutation.current) return;
    const slots = feature?.input_slots ?? [];
    const index = slots.findIndex(slot => slot.key === key);
    setInputs(previous => Object.fromEntries(Object.entries(previous).filter(([name]) =>
      slots.findIndex(slot => slot.key === name) < index)));
    if (featureId === "keyframes") changeCreative({guide_frames: creative?.guide_frames?.slice(0, index)});
    setSelected(undefined);
  };
  const submit = async (request: Submission) => {
    if (busy.current || sourceMutation.current || uncertainJob) return;
    busy.current = true;
    ++sourceSequence.current;
    setPosting(true);
    setError("");
    setRetry(undefined);
    try {
      const created = await post<Job>(request.url, request.body);
      if (alive.current) {
        if (created.status === "failed") jobBaseline.current.set(created.id, "submitting");
        upsert(created);
        setSelected(created.id);
        setView("result");
      }
    } catch (e) {
      if (alive.current) {
        setError(message(e));
        if (e instanceof ServiceError && e.uncertain) setRetry(request);
        else notify(`Couldn't start task: ${message(e)}`, true);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPosting(false);
    }
  };
  const generate = () => {
    if (enabled)
      void submit({
        url: "/api/jobs",
        body: {
          feature: featureId,
          source_id: sourceKind === "none" ? null : source!.id,
          inputs: Object.fromEntries(Object.entries(inputs).map(([key, asset]) => [key, asset.id])),
          settings: toolSettings,
          request_id: crypto.randomUUID(),
        },
      });
  };
  const openJob = async (item: Job) => {
    if (busy.current || sourceMutation.current || retry) return;
    sourceMutation.current = true;
    setLoadingSelection(true);
    setError("");
    const sequence = ++sourceSequence.current;
    try {
      const [asset, references] = await Promise.all([
        item.source_id ? api<Asset>(`/api/assets/${encodeURIComponent(item.source_id)}/meta`) : undefined,
        Promise.all(Object.entries(item.inputs ?? {}).map(async ([key, id]) =>
          [key, await api<Asset>(`/api/assets/${encodeURIComponent(id)}/meta`)] as const)),
      ]);
      if (
        alive.current &&
        !busy.current &&
        sequence === sourceSequence.current
      ) {
        setSource(asset);
        setInputs(Object.fromEntries(references));
        if (item.feature !== featureId) {
          setFeatureId(item.feature);
          setDoctor(undefined);
          setChecking(true);
        }
        if (item.feature === "remove-background")
          setBackgroundSettings(item.settings);
        else if (item.feature === "relight") setSettings(item.settings);
        else {
          const restored = {...item.settings};
          const currentFeature = features.find(candidate => candidate.id === item.feature);
          if (currentFeature && !currentFeature.supported_modes.includes(restored.mode))
            restored.mode = currentFeature.defaults.mode;
          if ("negative_prompt" in restored) restored.negative_prompt = "";
          setCreativeSettings(previous => ({...previous, [item.feature]: restored}));
        }
        setSelected(item.id);
        setResolveFor(undefined);
        setView("result");
      }
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      sourceMutation.current = false;
      if (alive.current) setLoadingSelection(false);
    }
  };
  const cancel = async () => {
    if (!job || busy.current) return;
    busy.current = true;
    try {
      upsert(
        await post<Job>(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {}),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      busy.current = false;
    }
  };
  const resolveUncertain = async () => {
    if (
      !job ||
      job.status !== "needs_attention" ||
      resolveFor !== job.id ||
      busy.current ||
      sourceMutation.current
    )
      return;
    busy.current = true;
    setResolving(true);
    setError("");
    try {
      const resolved = await post<Job>(
        `/api/jobs/${encodeURIComponent(job.id)}/resolve`,
        { confirm_not_running: true },
      );
      if (alive.current) {
        upsert(resolved);
        setResolveFor(undefined);
      }
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      busy.current = false;
      if (alive.current) setResolving(false);
    }
  };

  return (
    <div className={`app-shell ${hasSidePanel ? "app-workspace" : "creation-workspace"} ${feature?.output_kind === "video" ? "video-workspace" : ""}`}>
      <header className="topbar">
        <a className="brand" href="./" aria-label="MarcoStudio home">
          <Aperture className="brand-mark" size={24} aria-hidden="true" />
          Marco<span className="brand-light">Studio</span>
        </a>
        <ToolNavigation features={features} selected={featureId} disabled={sourceBusy || !!retry} select={switchTool} />
        <div className="header-actions">
          <a
            className="github-link"
            aria-label="GitHub"
            href="https://github.com/NeoMarcoPolo/marcostudio"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>GitHub</span><ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <button
            className="settings-button"
            aria-label="Settings"
            disabled={!studio}
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={17} aria-hidden="true" /><span>Settings</span>
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div className="breadcrumb">
            <span>{toolGroup(featureId)}</span><ChevronRight size={13} aria-hidden="true" />
            <h1>{feature?.name ?? "Relight"}</h1>
          </div>
          {(checking || doctor?.ready || activeJob || posting) && <div
            className={`service-state ${!activeJob && !posting && doctor?.ready ? "ready" : ""}`}
            role="status"
            aria-label="Studio status"
          >
            <span className="status-dot" />
            {posting
              ? "Submitting…"
              : activeJob
                ? activityLabel(activeJob.status)
                : checking
                  ? "Checking connection…"
                  : doctor?.ready
                    ? doctor.checks.some(check => check.name.startsWith("integrity-unverified:") && check.status === "warn") ? "Connected · Models unverified" : "ComfyUI connected"
                    : "Setup needed"}
          </div>}
        </div>
        {!checking && doctor?.ready && doctor.checks.some(check => check.name.startsWith("integrity-unverified:") && check.status === "warn") && <section className="setup-banner" aria-label="Models unverified"><div><strong>Models unverified</strong><span>You chose to continue without verifying some model files in this session.</span></div><button onClick={() => setShowSettings(true)}>Review setup</button></section>}
        {!checking && !doctor?.ready && <section className="setup-banner" aria-label="Setup needed">
          <div><strong>Setup needed</strong><span>Finish setup to use {feature?.name ?? "Relight"}.</span></div>
          <button disabled={!studio} onClick={() => setShowSettings(true)}>Open setup <ArrowUpRight size={15} aria-hidden="true"/></button>
        </section>}
        {(error || retry) && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            {retry && (
              <span>
                {" "}
                Your request may already have been received. Retry safely with
                the same request ID.
              </span>
            )}
            {retry && (
              <button
                disabled={sourceBusy || uncertainJob}
                onClick={() => void submit(retry)}
              >
                Retry same request
              </button>
            )}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {uncertainJob && (
          <div className="error-banner" role="status">
            The studio is checking whether a generation was accepted. New
            generations are paused until its status is confirmed.
          </div>
        )}
        <div className="studio-grid">
          <section className="workspace" aria-label={`${feature?.output_kind === "video" ? "Video" : "Image"} workspace`}>
            <div className={`canvas-toolbar ${!source && !result ? "canvas-toolbar-empty" : ""}`}>
              <div className="canvas-tabs">
                <button
                  aria-pressed={view === "result"}
                  onClick={() => setView("result")}
                >
                  Preview
                </button>
                <button
                  disabled={!canCompare}
                  aria-pressed={view === "compare"}
                  onClick={() => setView("compare")}
                >
                  Compare
                </button>
              </div>
              <span className="canvas-meta">
                {result || source
                  ? `${(result ?? source)!.width} × ${(result ?? source)!.height}`
                  : null}
              </span>
            </div>
            <MediaPreview feature={feature} source={source} result={result} transparent={isBackground}
              view={canCompare ? view : "result"} comparison={comparison} resultLabel={resultLabel}
              busy={sourceBusy || !!retry} uploading={uploading} loading={loadingSelection}
              progress={job?.progress} activity={selectedActive ? activityLabel(job!.status) : undefined}
              upload={file => void upload(file)} />
            <SampleHelp imageTool={sourceKind === "image"} hasSource={!!source} disabled={sourceBusy || !!retry || !studio} onLoadSample={() => void loadSample()}/>
            {(source || result) && (
              <div className="result-toolbar">
                <div>
                  <span className="file-name">{(source ?? result)!.filename}</span>
                  {sourceKind !== "none" && feature?.output_kind !== "video" && <label className="text-upload">
                    Replace {sourceKind}
                    <input
                      aria-label={`Upload source ${sourceKind}`}
                      type="file"
                      accept={sourceKind === "video" ? "video/mp4" : "image/png,image/jpeg"}
                      disabled={sourceBusy || !!retry}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        void upload(file);
                      }}
                    />
                  </label>}
                </div>
                <div className="result-actions">
                  {result && (
                    <>
                      <button
                        disabled={sourceBusy || !!retry}
                        onClick={() => {
                          if (busy.current || sourceMutation.current) return;
                          ++sourceSequence.current;
                          if (result.media_type === "video/mp4") switchTool("restyle-video");
                          else if (sourceKind !== "image") switchTool("edit-image");
                          setSource(result);
                          setSelected(undefined);
                          setRetry(undefined);
                        }}
                      >
                        Use as source
                      </button>
                      <a
                        className="download"
                        href={result.url}
                        download={result.filename}
                        onClick={event => {if (isBrowserRuntime()) {event.preventDefault(); void downloadAsset(result).catch(error => setError(message(error)));}}}
                      >
                        <ArrowDownToLine size={15} aria-hidden="true" /> Download
                      </a>
                    </>
                  )}
                </div>
              </div>
            )}
            {canCompare && view === "compare" && (
              <div className="comparison-control">
                <label htmlFor="comparison">Original</label>
                <input
                  id="comparison"
                  aria-label="Compare original and result"
                  type="range"
                  min="0"
                  max="100"
                  value={comparison}
                  onChange={(e) => setComparison(Number(e.target.value))}
                />
                <span>{resultLabel}</span>
              </div>
            )}
            {job && (
              <div className="job-details" role="status">
                <span>Generation {label(job.status)}</span>
                {job.elapsed_seconds !== null && (
                  <span>{job.elapsed_seconds.toFixed(1)}s elapsed</span>
                )}
                {job.queue_seconds !== null && (
                  <span>{job.queue_seconds.toFixed(1)}s queued</span>
                )}
                {job.error && (
                  <strong className="failure-text">{job.error}</strong>
                )}
                {selectedActive && job.status !== "needs_attention" && (
                  <button
                    disabled={job.status === "cancel_requested"}
                    onClick={() => void cancel()}
                  >
                    {job.status === "cancel_requested"
                      ? "Cancellation requested"
                      : "Request cancellation"}
                  </button>
                )}
                {job.status === "needs_attention" && (
                  <span>
                    Checking the service for this generation. Its status will
                    update automatically.
                  </span>
                )}
              </div>
            )}
            {job?.status === "needs_attention" && (
              <div className="resolution-panel">
                {resolveFor !== job.id ? (
                  <button
                    disabled={sourceBusy}
                    onClick={() => setResolveFor(job.id)}
                  >
                    Resolve uncertain job
                  </button>
                ) : (
                  <>
                    <h3>Confirm this generation has stopped</h3>
                    <p>
                      Check ComfyUI and confirm this run is no longer running
                      before you stop tracking it. The studio will check its
                      queue and history again. This only stops tracking the
                      uncertain job.
                    </p>
                    <div>
                      <button
                        disabled={sourceBusy}
                        onClick={() => void resolveUncertain()}
                      >
                        {resolving
                          ? "Checking status…"
                          : "I checked — stop tracking"}
                      </button>
                      <button
                        disabled={sourceBusy}
                        onClick={() => setResolveFor(undefined)}
                      >
                        Keep tracking
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
          <aside
            className={`controls ${hasSidePanel ? "app-controls" : "composer"}`}
            aria-label={isRelight ? "Light controls" : isBackground ? "Background removal" : `${feature?.name} controls`}
          >
            {isRelight ? (
              <RelightControls settings={settings} setSettings={setSettings} validSeed={validSeed} />
            ) : isBackground ? (
              <><div className="panel-title"><ToolIcon size={20} aria-hidden="true" /><h2>Remove Background</h2></div>
                <div className="output-format"><span>Output</span><strong>Transparent PNG</strong></div></>
            ) : feature && creative ? <>
              {feature.output_kind === "video" && <>
                <div className="panel-title"><ToolIcon size={20} aria-hidden="true" /><h2>{feature.name}</h2></div>
                {sourceKind !== "none" && <SourceInput feature={feature} source={source}
                  disabled={sourceBusy || !!retry} upload={file => void upload(file)} />}
              </>}
              <InputAssets feature={feature} inputs={inputs} settings={creative}
                disabled={sourceBusy || !!retry} upload={(file, key) => void upload(file, key)}
                remove={removeInput} change={changeCreative} />
              <div className="creative-settings"><ToolControls feature={feature} value={creative} change={changeCreative} masked={!!inputs.mask} /></div>
            </> : null}
            {!validGuides && <p className="field-error">Guide times must increase and stay within the video duration.</p>}
            <div className="generate-area">
              <div className="generate-row">
                <button
                  className="generate-button"
                  disabled={!enabled}
                  onClick={generate}
                >
                  <Sparkles size={17} aria-hidden="true" />
                  {posting
                    ? "Submitting…"
                    : selectedActive
                      ? activityLabel(job!.status)
                      : isBackground ? "Remove background" : "Generate"}
                </button>
                {feature?.supported_modes.includes("flash") && (
                  <div className="flash-control">
                    <button
                      role="switch"
                      aria-label="Flash"
                      aria-checked={toolSettings.mode === "flash"}
                      disabled={!feature.supported_modes.includes("standard") || sourceBusy || !!retry}
                      onClick={() => {
                        const mode = toolSettings.mode === "flash" ? "standard" : "flash";
                        if (!isRelight) changeCreative({mode});
                      }}
                    >
                      <span className="switch-track">
                        <span />
                      </span>
                      Flash
                    </button>
                  </div>
                )}
              </div>
              {job && (
                <button
                  className="regenerate-button"
                  disabled={
                    !doctor?.ready ||
                    !feature?.supported_modes.includes(job.settings.mode) ||
                    checking ||
                    sourceBusy ||
                    selectedActive ||
                    uncertainJob ||
                    !!retry
                  }
                  onClick={() =>
                    void submit({
                      url: `/api/jobs/${encodeURIComponent(job.id)}/regenerate`,
                      body: { request_id: crypto.randomUUID() },
                    })
                  }
                >
                  Regenerate recorded job
                </button>
              )}
            </div>
          </aside>
        <section className="history-section" aria-label="Generation history">
          <div className="history-heading">
            <History size={18} aria-hidden="true" /><h2 className="sr-only">Recent generations</h2>
            <span className="history-count">{jobs.length}</span>
          </div>
          <button className="new-generation" aria-label="New generation" title="New generation"
            disabled={sourceBusy || !!retry} onClick={() => {
              if (busy.current || sourceMutation.current) return;
              ++sourceSequence.current;
              setSelected(undefined); setSource(undefined); setInputs({}); setResolveFor(undefined);
            }}><Plus size={20} aria-hidden="true" /></button>
          {jobs.length === 0 ? (
            <div className="empty-history">
              No generations yet.
            </div>
          ) : (
            <div className="history-list">
              {jobs.map((item) => (
                <button
                  className={`history-item ${selected === item.id ? "selected" : ""}`}
                  key={item.id}
                  aria-label={`Open generation ${new Date(item.created_at).toLocaleString()} ${label(item.status)}`}
                  aria-pressed={selected === item.id}
                  data-status={item.status}
                  title={`${features.find(tool => tool.id === item.feature)?.name ?? item.feature} · ${label(item.status)} · ${new Date(item.created_at).toLocaleString()}`}
                  disabled={sourceBusy || !!retry}
                  onClick={() => void openJob(item)}
                >
                  {item.outputs[0]?.media_type !== "video/mp4" && item.outputs[0] ? (
                    <img src={item.outputs[0].url} alt="" loading="lazy" />
                  ) : (
                    <span className="history-placeholder" aria-hidden="true">
                      {features.find(tool => tool.id === item.feature)?.output_kind === "video" ? <Video size={20} /> : <Sparkles size={20} />}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
        </div>
      </main>
      {showSettings && isBrowserRuntime() && <Onboarding feature={feature} featureId={featureId}
        doctor={doctor} checking={checking} locked={!!activeJob || posting || !!retry} refresh={refreshDoctor}
        notices={<Notifications notices={notices} dismiss={dismiss} announced={announced}/>} onConnection={observeConnection} onTasks={observeDownloads}
        connected={async () => {
          const value = await api<StudioSettings>("/api/settings");
          if (studio?.comfy_url && studio.comfy_url !== value.comfy_url) {setSource(undefined); setInputs({}); setSelected(undefined);}
          const history = await api<Job[]>("/api/jobs");
          jobBaseline.current.clear(); jobsInitialized.current = false;
          setStudio(value); setJobs(history); await refreshDoctor();
        }} close={closeSettings} />}
      {showSettings && !isBrowserRuntime() && (
        <SettingsDialog
          value={studio}
          doctor={doctor}
          checking={checking}
          locked={!!activeJob || posting || !!retry}
          close={closeSettings}
          refresh={() => void refreshDoctor()}
          save={async (changes) => {
            const value = await api<StudioSettings>("/api/settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(changes),
            });
            setStudio(value);
            await refreshDoctor();
            return value;
          }}
        />
      )}
      {!(showSettings && isBrowserRuntime()) && <Notifications notices={notices} dismiss={dismiss} announced={announced}/>}
    </div>
  );
}
