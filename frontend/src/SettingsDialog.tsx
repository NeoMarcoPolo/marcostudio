import { useEffect, useRef, useState } from "react";
import type { Doctor, StudioSettings } from "./api";

export function SettingsDialog({
  value,
  doctor,
  checking,
  close,
  refresh,
  save,
}: {
  value?: StudioSettings;
  doctor?: Doctor;
  checking: boolean;
  close: () => void;
  refresh: () => void;
  save: (changes: Partial<StudioSettings>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    comfy_url: value?.comfy_url ?? "",
    proxy_url: value?.proxy_url ?? "",
    comfy_dir: value?.comfy_dir ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
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
      previous?.focus();
    };
  }, [close]);
  const update = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const changed: Partial<StudioSettings> = {};
      for (const key of ["comfy_url", "proxy_url", "comfy_dir"] as const) {
        const next =
          key === "comfy_url" ? form[key].trim() : form[key].trim() || null;
        if (next !== value?.[key]) changed[key] = next as string;
      }
      await save(changed);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
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
          <div className="eyebrow">YOUR LOCAL STUDIO</div>
          <button aria-label="Close settings" onClick={close}>
            ×
          </button>
          <h2 id="settings-title">Studio settings</h2>
        </div>
        <p>Connect your image service, then check that the studio is ready.</p>
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
            Image service URL
            <input
              aria-label="Image service URL"
              type="url"
              required
              value={form.comfy_url}
              onChange={(e) => setForm({ ...form, comfy_url: e.target.value })}
            />
          </label>
          <label>
            Proxy URL <span>Optional</span>
            <input
              type="url"
              value={form.proxy_url}
              onChange={(e) => setForm({ ...form, proxy_url: e.target.value })}
            />
          </label>
          <label>
            Image service folder <span>Optional</span>
            <input
              value={form.comfy_dir}
              onChange={(e) => setForm({ ...form, comfy_dir: e.target.value })}
            />
          </label>
          <dl>
            <div>
              <dt>Data folder</dt>
              <dd>{value?.data_dir ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>{value?.transport ?? "Unavailable"}</dd>
            </div>
          </dl>
          <button
            className="generate-button"
            disabled={saving || !value}
            type="submit"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saved && (
            <span className="saved-message" role="status">
              Settings saved
            </span>
          )}
        </form>
        <div className="readiness-heading">
          <h3>Setup checks</h3>
          <button disabled={checking} onClick={refresh}>
            {checking ? "Checking…" : "Refresh readiness"}
          </button>
        </div>
        <ul className="readiness-list">
          {doctor?.checks.map((check, index) => (
            <li key={`${check.name}-${index}`}>
              <span className={`check-status ${check.status}`}>
                {check.status === "pass"
                  ? "✓"
                  : check.status === "warn"
                    ? "!"
                    : "×"}
              </span>
              <div>
                <strong>{check.name}</strong>
                <p>{check.message}</p>
              </div>
            </li>
          )) ?? (
            <li>
              Service checks unavailable. Check your connection settings and
              refresh.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
