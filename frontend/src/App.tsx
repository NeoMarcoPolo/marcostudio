import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  active,
  api,
  post,
  ServiceError,
  type Asset,
  type Direction,
  type Doctor,
  type Feature,
  type Job,
  type RelightSettings,
  type StudioSettings,
} from "./api";
import { SettingsDialog } from "./SettingsDialog";
import "./style.css";

const initial: RelightSettings = {
  direction: "front",
  softness: "soft",
  brightness: 50,
  color: "#ffffff",
  mode: "flash",
  seed: 0,
};
const presets: {
  name: string;
  direction: Direction;
  azimuth: number;
  elevation: number;
  symbol: string;
}[] = [
  { name: "Top", direction: "top", azimuth: 0, elevation: 90, symbol: "↓" },
  { name: "Front", direction: "front", azimuth: 0, elevation: 0, symbol: "◎" },
  { name: "Right", direction: "right", azimuth: 90, elevation: 0, symbol: "←" },
  { name: "Left", direction: "left", azimuth: -90, elevation: 0, symbol: "→" },
  { name: "Back", direction: "back", azimuth: 180, elevation: 0, symbol: "◉" },
  {
    name: "Bottom",
    direction: "bottom",
    azimuth: 0,
    elevation: -90,
    symbol: "↑",
  },
];
type Request = { url: string; body: unknown };
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
  const [feature, setFeature] = useState<Feature>();
  const [settings, setSettings] = useState(initial);
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
  const [retry, setRetry] = useState<Request>();
  const [showSettings, setShowSettings] = useState(false);
  const [comparison, setComparison] = useState(50);
  const [view, setView] = useState<"result" | "compare">("result");
  const busy = useRef(false);
  const alive = useRef(true);
  const sourceSequence = useRef(0);
  const sourceMutation = useRef(false);
  const job = jobs.find((item) => item.id === selected);
  const result = job?.status === "succeeded" ? job.outputs[0] : undefined;
  const selectedActive = !!job && active(job);
  const activeJob = jobs.find((item) => item.status === "running") ?? jobs.find(active);
  const uncertainJob = jobs.some((item) => item.status === "needs_attention");
  const sourceBusy = uploading || posting || loadingSelection || resolving;
  const validSeed = Number.isSafeInteger(settings.seed) && settings.seed >= 0;
  const enabled =
    doctor?.ready &&
    feature?.supported_modes.includes("flash") &&
    source &&
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
  const refreshDoctor = useCallback(async () => {
    setChecking(true);
    try {
      setDoctor(await api<Doctor>("/api/doctor?mode=flash"));
    } catch (e) {
      setDoctor(undefined);
      setError(message(e));
    } finally {
      setChecking(false);
    }
  }, []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const load = async () => {
      const results = await Promise.allSettled([
        api<Feature[]>("/api/features", { signal: controller.signal }),
        api<StudioSettings>("/api/settings", { signal: controller.signal }),
        api<Doctor>("/api/doctor?mode=flash", { signal: controller.signal }),
        api<Job[]>("/api/jobs", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const [features, configuration, readiness, history] = results;
      if (features.status === "fulfilled") {
        const relight = features.value.find((item) => item.id === "relight");
        setFeature(relight);
        if (relight) setSettings({ ...relight.defaults, mode: "flash" });
      }
      if (configuration.status === "fulfilled") setStudio(configuration.value);
      if (readiness.status === "fulfilled") setDoctor(readiness.value);
      if (history.status === "fulfilled") setJobs(history.value);
      const failure = results.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") setError(message(failure.reason));
      setChecking(false);
    };
    void load();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);
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
  const upload = async (file?: File) => {
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
        setSource(asset);
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
  const submit = async (request: Request) => {
    if (busy.current || sourceMutation.current || uncertainJob) return;
    busy.current = true;
    ++sourceSequence.current;
    setPosting(true);
    setError("");
    setRetry(undefined);
    try {
      const created = await post<Job>(request.url, request.body);
      if (alive.current) {
        upsert(created);
        setSelected(created.id);
        setView("result");
      }
    } catch (e) {
      if (alive.current) {
        setError(message(e));
        if (e instanceof ServiceError && e.uncertain) setRetry(request);
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
          source_id: source!.id,
          settings,
          request_id: crypto.randomUUID(),
        },
      });
  };
  const openJob = async (item: Job) => {
    if (busy.current || sourceMutation.current) return;
    sourceMutation.current = true;
    setLoadingSelection(true);
    setError("");
    const sequence = ++sourceSequence.current;
    try {
      const asset = await api<Asset>(
        `/api/assets/${encodeURIComponent(item.source_id)}/meta`,
      );
      if (
        alive.current &&
        !busy.current &&
        sequence === sourceSequence.current
      ) {
        setSource(asset);
        setSettings(item.settings);
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
  const preset = presets.find((item) => item.direction === settings.direction);
  const azimuth = settings.azimuth ?? preset?.azimuth ?? 0;
  const elevation = settings.elevation ?? preset?.elevation ?? 0;
  const custom = (az: number, el: number) =>
    setSettings((previous) => ({
      ...previous,
      direction: "custom",
      azimuth: Math.max(-180, Math.min(180, Math.round(az))),
      elevation: Math.max(-90, Math.min(90, Math.round(el))),
    }));
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width)
      custom(
        ((event.clientX - box.left) / box.width) * 360 - 180,
        90 - ((event.clientY - box.top) / box.height) * 180,
      );
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
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="MarcoStudio home">
          <span className="brand-mark" aria-hidden="true">
            M<span>✦</span>
          </span>
          Marco<span className="brand-light">Studio</span>
        </a>
        <span className="workspace-label">IMAGE STUDIO</span>
        <button
          className="settings-button"
          disabled={!studio}
          onClick={() => setShowSettings(true)}
        >
          Settings <span aria-hidden="true">⚙</span>
        </button>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <h1>Relight</h1>
          </div>
          <div
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
                    ? "ComfyUI connected"
                    : "Setup needed"}
            {!checking && !doctor?.ready && (
              <button disabled={!studio} onClick={() => setShowSettings(true)}>
                Open setup
              </button>
            )}
          </div>
        </div>
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
              ×
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
          <section className="workspace" aria-label="Image workspace">
            <div className="canvas-toolbar">
              <div className="canvas-tabs">
                <button
                  aria-pressed={view === "result"}
                  onClick={() => setView("result")}
                >
                  Preview
                </button>
                <button
                  disabled={!result}
                  aria-pressed={view === "compare"}
                  onClick={() => setView("compare")}
                >
                  Compare
                </button>
              </div>
              <span className="canvas-meta">
                {source
                  ? `${source.width} × ${source.height}`
                  : null}
              </span>
            </div>
            <div className={`image-canvas ${source ? "has-source" : ""}`}>
              {!source ? (
                <div className="empty-canvas">
                  <div className="empty-art" aria-hidden="true">
                    <span className="light-ray" />
                    <span className="empty-orb" />
                    <span className="orb-shadow" />
                  </div>
                  <h2>Upload an image</h2>
                  <p>PNG or JPEG, up to 32 MiB.</p>
                  <label className="upload-button">
                    Upload image
                    <input
                      aria-label="Upload source image"
                      type="file"
                      accept="image/*"
                      disabled={sourceBusy}
                      onChange={(event) => void upload(event.target.files?.[0])}
                    />
                  </label>
                </div>
              ) : (
                <>
                  <div
                    className="image-stage"
                    style={{ aspectRatio: `${source.width}/${source.height}` }}
                  >
                    <img
                      className="source-image"
                      src={source.url}
                      alt={`Source: ${source.filename}`}
                      width={source.width}
                      height={source.height}
                    />
                    {result && (
                      <img
                        className="result-image"
                        src={result.url}
                        alt={`Result: ${result.filename}`}
                        width={result.width}
                        height={result.height}
                        style={
                          view === "compare"
                            ? { clipPath: `inset(0 0 0 ${comparison}%)` }
                            : undefined
                        }
                      />
                    )}
                    {result && view === "compare" && (
                      <>
                        <div
                          className="compare-line"
                          style={{ left: `${comparison}%` }}
                        >
                          <span aria-hidden="true">↔</span>
                        </div>
                        <span className="image-badge before">Original</span>
                        <span className="image-badge after">Relit</span>
                      </>
                    )}
                  </div>
                  {selectedActive && (
                    <div className="job-overlay" role="status">
                      <span className="spinner" />
                      <strong>{activityLabel(job!.status)}</strong>
                      {job!.progress !== null ? (
                        <span>{Math.round(job!.progress * 100)}%</span>
                      ) : job!.status === "queued" ? (
                        <span>Waiting for ComfyUI</span>
                      ) : null}
                    </div>
                  )}
                </>
              )}
              {(uploading || loadingSelection) && (
                <div className="job-overlay" role="status">
                  <span className="spinner" />
                  {loadingSelection
                    ? "Loading generation…"
                    : "Uploading image…"}
                </div>
              )}
            </div>
            {source && (
              <div className="result-toolbar">
                <div>
                  <span className="file-name">{source.filename}</span>
                  <label className="text-upload">
                    Replace image
                    <input
                      aria-label="Upload source image"
                      type="file"
                      accept="image/*"
                      disabled={sourceBusy}
                      onChange={(event) => void upload(event.target.files?.[0])}
                    />
                  </label>
                </div>
                <div className="result-actions">
                  {result && (
                    <>
                      <button
                        disabled={sourceBusy}
                        onClick={() => {
                          if (busy.current || sourceMutation.current) return;
                          ++sourceSequence.current;
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
                      >
                        Download <span aria-hidden="true">↓</span>
                      </a>
                    </>
                  )}
                </div>
              </div>
            )}
            {result && view === "compare" && (
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
                <span>Relit</span>
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
          <aside className="controls" aria-label="Light controls">
            <div className="panel-title">
              <h2>Light settings</h2>
              <span aria-hidden="true">✦</span>
            </div>
            <div className="control-section">
              <div className="control-heading">
                <h3>Direction</h3>
              </div>
              <div
                className="direction-pad"
                role="group"
                aria-label="Light direction"
              >
                <span className="axis-h" />
                <span className="axis-v" />
                <div className="direction-orb" />
                <div
                  className="drag-surface"
                  role="slider"
                  tabIndex={0}
                  aria-label="Drag light direction"
                  aria-valuemin={-180}
                  aria-valuemax={180}
                  aria-valuenow={azimuth}
                  aria-valuetext={`Azimuth ${azimuth} degrees, elevation ${elevation} degrees`}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    point(event);
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons === 1) point(event);
                  }}
                  onKeyDown={(event) => {
                    if (
                      [
                        "ArrowLeft",
                        "ArrowRight",
                        "ArrowUp",
                        "ArrowDown",
                      ].includes(event.key)
                    ) {
                      event.preventDefault();
                      custom(
                        azimuth +
                          (event.key === "ArrowRight"
                            ? 10
                            : event.key === "ArrowLeft"
                              ? -10
                              : 0),
                        elevation +
                          (event.key === "ArrowUp"
                            ? 10
                            : event.key === "ArrowDown"
                              ? -10
                              : 0),
                      );
                    }
                  }}
                >
                  <span
                    className="light-handle"
                    style={{
                      left: `${((azimuth + 180) / 360) * 100}%`,
                      top: `${((90 - elevation) / 180) * 100}%`,
                    }}
                  />
                </div>
                <span className="pad-caption">DRAG TO POSITION LIGHT</span>
              </div>
              <div className="direction-presets">
                {presets.map((item) => (
                  <button
                    key={item.direction}
                    aria-pressed={settings.direction === item.direction}
                    onClick={() =>
                      setSettings((previous) => {
                        const {
                          azimuth: _a,
                          elevation: _e,
                          ...rest
                        } = previous;
                        return { ...rest, direction: item.direction };
                      })
                    }
                  >
                    <span aria-hidden="true">{item.symbol}</span>
                    {item.name}
                  </button>
                ))}
              </div>
              <details className="angle-details">
                <summary>
                  Custom direction{" "}
                  <span>
                    {azimuth}° / {elevation}°
                  </span>
                </summary>
                <label>
                  Azimuth
                  <input
                    aria-label="Azimuth"
                    type="range"
                    min="-180"
                    max="180"
                    step="1"
                    value={azimuth}
                    onChange={(e) => custom(Number(e.target.value), elevation)}
                  />
                </label>
                <label>
                  Elevation
                  <input
                    aria-label="Elevation"
                    type="range"
                    min="-90"
                    max="90"
                    step="1"
                    value={elevation}
                    onChange={(e) => custom(azimuth, Number(e.target.value))}
                  />
                </label>
              </details>
            </div>
            <div className="control-section">
              <h3>Softness</h3>
              <div className="segmented">
                {(["soft", "hard"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={settings.softness === value}
                    onClick={() =>
                      setSettings((previous) => ({
                        ...previous,
                        softness: value,
                      }))
                    }
                  >
                    <span aria-hidden="true">
                      {value === "soft" ? "◌" : "◍"}
                    </span>
                    {value === "soft" ? "Soft" : "Hard"}
                  </button>
                ))}
              </div>
            </div>
            <div className="control-section">
              <label className="control-heading" htmlFor="brightness">
                <strong>Brightness</strong>
                <span className="brightness-value">{settings.brightness}%</span>
              </label>
              <input
                id="brightness"
                aria-label="Brightness"
                type="range"
                min="10"
                max="100"
                step="10"
                value={settings.brightness}
                onChange={(e) =>
                  setSettings((previous) => ({
                    ...previous,
                    brightness: Number(e.target.value),
                  }))
                }
              />
              <div className="range-labels">
                <span>Subtle</span>
                <span>Vivid</span>
              </div>
            </div>
            <div className="control-section color-row">
              <label htmlFor="light-color">
                <strong>Light color</strong>
              </label>
              <div className="color-input">
                <input
                  id="light-color"
                  aria-label="Light color"
                  type="color"
                  value={settings.color}
                  onChange={(e) =>
                    setSettings((previous) => ({
                      ...previous,
                      color: e.target.value,
                    }))
                  }
                />
                <span>{settings.color.toUpperCase()}</span>
              </div>
            </div>
            <div className="control-section seed-row">
              <label htmlFor="seed">
                <strong>Seed</strong>
              </label>
              <input
                id="seed"
                aria-label="Seed"
                type="number"
                min="0"
                max={Number.MAX_SAFE_INTEGER}
                step="1"
                value={Number.isNaN(settings.seed) ? "" : settings.seed}
                onChange={(e) =>
                  setSettings((previous) => ({
                    ...previous,
                    seed: e.target.value === "" ? NaN : Number(e.target.value),
                  }))
                }
              />
            </div>
            {!validSeed && (
              <p className="field-error">
                Use a nonnegative whole number up to {Number.MAX_SAFE_INTEGER}.
              </p>
            )}
            <div className="generate-area">
              <div className="generate-row">
                <button
                  className="generate-button"
                  disabled={!enabled}
                  onClick={generate}
                >
                  <span aria-hidden="true">✦</span>
                  {posting
                    ? "Submitting…"
                    : selectedActive
                      ? activityLabel(job!.status)
                      : "Generate"}
                </button>
                <div className="flash-control">
                  <button
                    role="switch"
                    aria-label="Flash"
                    aria-checked={settings.mode === "flash"}
                    disabled={!feature?.supported_modes.includes("standard")}
                    aria-describedby="flash-help"
                    title="Faster generation; fine detail may vary."
                  >
                    <span className="switch-track">
                      <span />
                    </span>
                    Flash
                  </button>
                </div>
              </div>
              <p id="flash-help">
                Faster generation; fine detail may vary.
                {!feature?.supported_modes.includes("standard") &&
                  " Standard is unavailable."}
              </p>
              {job && (
                <button
                  className="regenerate-button"
                  disabled={
                    !doctor?.ready ||
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
        </div>
        <section className="history-section" aria-label="Generation history">
          <div className="history-heading">
            <div>
              <h2>
                Recent generations{" "}
                <span>{jobs.length.toString().padStart(2, "0")}</span>
              </h2>
            </div>
          </div>
          {jobs.length === 0 ? (
            <div className="empty-history">
              <span aria-hidden="true">◷</span>No generations yet.
            </div>
          ) : (
            <div className="history-list">
              {jobs.map((item) => (
                <button
                  className={`history-item ${selected === item.id ? "selected" : ""}`}
                  key={item.id}
                  aria-label={`Open generation ${new Date(item.created_at).toLocaleString()} ${label(item.status)}`}
                  aria-pressed={selected === item.id}
                  disabled={sourceBusy}
                  onClick={() => void openJob(item)}
                >
                  {item.outputs[0] ? (
                    <img src={item.outputs[0].url} alt="" loading="lazy" />
                  ) : (
                    <span className="history-placeholder" aria-hidden="true">
                      ✦
                    </span>
                  )}
                  <div>
                    <strong>
                      {item.settings.direction.charAt(0).toUpperCase() +
                        item.settings.direction.slice(1)}{" "}
                      light
                    </strong>
                    <span>
                      {item.settings.softness} · {item.settings.brightness}%
                    </span>
                    <span className={`job-status ${item.status}`}>
                      {label(item.status)}
                    </span>
                  </div>
                  <time dateTime={item.created_at}>
                    {new Date(item.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
      {showSettings && (
        <SettingsDialog
          value={studio}
          doctor={doctor}
          checking={checking}
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
          }}
        />
      )}
    </div>
  );
}
