import { useEffect, useRef, useState } from "react";
import type { Doctor, StudioSettings } from "./api";

const checkLabels: Record<string, string> = {
  python: "Python",
  mode: "Generation mode",
  model_paths: "Model folders",
  installation: "ComfyUI folder",
  runtime: "ComfyUI connection",
  sdk: "ComfyUI client",
  proxy: "API proxy connection",
  storage: "Saved files",
  hashes: "Model checksums",
  "model:diffusion": "Qwen image model",
  "model:encoder": "Text encoder",
  "model:vae": "Image decoder",
  "model:lightning": "Flash adapter",
  "model:relight": "Relight adapter",
  "model:qwen21_diffusion": "Qwen 2.1 image model",
  "model:qwen21_encoder": "Qwen 2.1 text encoder",
  "model:qwen21_vae": "Qwen 2.1 image decoder",
  "model:h3_diffusion": "H3 video model",
  "model:h3_encoder": "H3 text encoder",
  "model:h3_vae": "H3 video decoder",
  "model:h3_audio_vae": "H3 audio decoder",
  "model:h3_control": "H3 motion control model",
  ffmpeg: "FFmpeg",
  ffprobe: "FFprobe",
};

function CheckList({ checks }: { checks: Doctor["checks"] }) {
  return (
    <ul className="readiness-list">
      {checks.map((check, index) => (
        <li key={`${check.name}-${index}`}>
          <span className={`check-status ${check.status}`} aria-hidden="true">
            {check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"}
          </span>
          <div>
            <strong>
              {checkLabels[check.name] ?? check.name.replace("node:", "ComfyUI node: ")}
            </strong>
            <p>{check.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SettingsDialog({
  value,
  doctor,
  checking,
  locked,
  close,
  refresh,
  save,
}: {
  value?: StudioSettings;
  doctor?: Doctor;
  checking: boolean;
  locked: boolean;
  close: () => void;
  refresh: () => void;
  save: (changes: Partial<StudioSettings>) => Promise<StudioSettings>;
}) {
  const [form, setForm] = useState({
    comfy_url: value?.comfy_url ?? "",
    proxy_url: value?.proxy_url ?? "",
    comfy_dir: value?.comfy_dir ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(!value?.proxy_url);
  const dialog = useRef<HTMLDivElement>(null);
  const changes: Partial<StudioSettings> = {};
  for (const key of ["comfy_url", "proxy_url", "comfy_dir"] as const) {
    const next = form[key].trim();
    if (next !== (value?.[key] ?? "")) changes[key] = next;
  }
  const dirty = Object.keys(changes).length > 0;
  const failures = doctor?.checks.filter((check) => check.status === "fail") ?? [];
  const edit = (key: keyof typeof form, next: string) => {
    setForm((previous) => ({ ...previous, [key]: next }));
    setSaved(false);
    setError("");
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = dialog.current;
    element?.querySelector<HTMLElement>("button")?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && element) {
        const items = [
          ...element.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),a[href]",
          ),
        ];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [close]);
  const persist = async (changes: Partial<StudioSettings>) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await save(changes);
      setForm({
        comfy_url: updated.comfy_url,
        proxy_url: updated.proxy_url ?? "",
        comfy_dir: updated.comfy_dir ?? "",
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings.");
      setAdvanced(true);
    } finally {
      setSaving(false);
    }
  };
  const update = async () => {
    if (saving || checking || locked || !value || !dirty) return;
    if (!form.comfy_url.trim() || !form.comfy_dir.trim() || !form.proxy_url.trim()) {
      setAdvanced(true);
      setError("Enter the ComfyUI URL, ComfyUI folder, and API proxy URL.");
      return;
    }
    await persist(changes);
  };
  return (
    <div className="dialog-backdrop">
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialog}
      >
        <div className="dialog-title">
          <button aria-label="Close settings" onClick={close}>
            ×
          </button>
          <h2 id="settings-title">Studio settings</h2>
        </div>
        <section className="setup-summary" aria-label="Setup status">
          <div className="setup-heading">
            <h3 role="status">
              {checking
                ? "Checking setup…"
                : dirty
                  ? "Unsaved changes"
                  : doctor?.ready
                    ? "Setup checks passed"
                    : doctor
                      ? "Setup needs attention"
                      : "Setup not checked"}
            </h3>
            <button disabled={checking || saving || dirty} onClick={refresh}>
              Check setup
            </button>
          </div>
          {dirty ? (
            <p>Save changes to check the new connection.</p>
          ) : !checking && failures.length > 0 ? (
            <CheckList checks={failures} />
          ) : !checking && !doctor ? (
            <p>Check the connection and this tool's model files.</p>
          ) : null}
          {!checking && doctor?.model_requirements?.some(model => !model.available) && <ul className="model-downloads">
            {doctor.model_requirements.filter(model => !model.available).map(model => <li key={model.filename}>
              <a href={model.url} target="_blank" rel="noopener noreferrer">{model.filename}</a>
              <span>{(model.size / 1e9).toFixed(1)} GB · models/{model.category}</span>
            </li>)}
          </ul>}
        </section>
        {locked && (
          <p className="settings-notice">
            {value?.restore_connection
              ? "Restore the connection used by unfinished generations."
              : "Finish or resolve active generations before editing the connection."}
          </p>
        )}
        {value?.restore_connection && <div className="settings-notice">
          <p>ComfyUI: {value.restore_connection.comfy_url}<br />Proxy: {value.restore_connection.proxy_url}</p>
          <button type="button" disabled={saving || checking} onClick={() => {
            if (!saving && !checking && value.restore_connection)
              void persist(value.restore_connection);
          }}>Restore original connection</button>
        </div>}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update();
          }}
        >
          <label>
            ComfyUI URL
            <input
              aria-label="ComfyUI URL"
              aria-describedby="comfy-url-help"
              type="url"
              required
              disabled={locked || saving}
              value={form.comfy_url}
              onChange={(e) => edit("comfy_url", e.target.value)}
            />
            <small id="comfy-url-help">
              Start ComfyUI, then enter its local address here.
            </small>
          </label>
          <label>
            ComfyUI folder
            <input
              aria-label="ComfyUI folder"
              aria-describedby="comfy-folder-help"
              required
              disabled={locked || saving}
              value={form.comfy_dir}
              onChange={(e) => edit("comfy_dir", e.target.value)}
            />
            <small id="comfy-folder-help">
              Folder containing main.py on the machine running MarcoStudio.
              Used to find your Relight models.
            </small>
          </label>
          <div className="settings-advanced">
            <button
              type="button"
              aria-expanded={advanced}
              aria-controls="advanced-settings"
              onClick={() => setAdvanced(!advanced)}
            >
              Advanced <span aria-hidden="true">{advanced ? "−" : "+"}</span>
            </button>
            {advanced && (
              <div id="advanced-settings">
                <label>
                  API proxy URL
                  <input
                    aria-label="API proxy URL"
                    aria-describedby="proxy-url-help"
                    type="url"
                    required
                    disabled={locked || saving}
                    value={form.proxy_url}
                    onChange={(e) => edit("proxy_url", e.target.value)}
                  />
                  <small id="proxy-url-help">
                    MarcoStudio uses this local bridge to submit and track jobs.
                    Its upstream must match the ComfyUI URL above.
                  </small>
                </label>
                <dl>
                  <div>
                    <dt>Saved images and history</dt>
                    <dd>{value?.data_dir ?? "Unavailable"}</dd>
                  </div>
                </dl>
                {doctor && !dirty && !checking && (
                  <section aria-label="Diagnostics">
                    <h3>Diagnostics</h3>
                    <CheckList checks={doctor.checks} />
                  </section>
                )}
              </div>
            )}
          </div>
          <div className="settings-actions">
            <button
              className="generate-button"
              disabled={saving || checking || locked || !value || !dirty}
              type="submit"
            >
              {saving ? (checking ? "Checking…" : "Saving…") : "Save and check"}
            </button>
            {saved && !dirty && (
              <span className="saved-message" role="status">
                Settings saved
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
