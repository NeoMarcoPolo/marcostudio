import { useId, useState, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { Lightbulb } from "lucide-react";
import type { Direction, RelightSettings } from "./api";

const presets: {
  name: string;
  direction: Direction;
  azimuth: number;
  elevation: number;
}[] = [
  { name: "Top", direction: "top", azimuth: 0, elevation: 90 },
  { name: "Front", direction: "front", azimuth: 0, elevation: 0 },
  { name: "Right", direction: "right", azimuth: 90, elevation: 0 },
  { name: "Left", direction: "left", azimuth: -90, elevation: 0 },
  { name: "Back", direction: "back", azimuth: 180, elevation: 0 },
  {
    name: "Bottom",
    direction: "bottom",
    azimuth: 0,
    elevation: -90,
  },
];

const arrowSteps: Partial<Record<string, [number, number]>> = {
  ArrowLeft: [-10, 0],
  ArrowRight: [10, 0],
  ArrowUp: [0, 10],
  ArrowDown: [0, -10],
};

function ControlHelp({ label, text, example }: { label: string; text: string; example: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const id = useId();
  const visible = open || hovered;
  return <div className={visible ? "relight-help open" : "relight-help"} onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
    onPointerLeave={event => { if (event.pointerType === "mouse") setHovered(false); }}
    onKeyDown={event => { if (event.key === "Escape") { setOpen(false); setHovered(false); } }}>
    <button type="button" className="relight-help-trigger" aria-label={`About ${label}`} aria-expanded={open} aria-describedby={visible ? id : undefined} onClick={() => setOpen(value => !value)}>?</button>
    {visible && <div id={id} role="tooltip" className="relight-help-card">
      <div className={`relight-help-example example-${example}`} aria-hidden="true"><span/><i/></div>
      <p>{text}</p>
    </div>}
  </div>;
}

export function RelightControls({ settings, setSettings, validSeed }: {
  settings: RelightSettings;
  setSettings: Dispatch<SetStateAction<RelightSettings>>;
  validSeed: boolean;
}) {
  const preset = presets.find((item) => item.direction === settings.direction);
  const azimuth = settings.azimuth ?? preset?.azimuth ?? 0;
  const elevation = settings.elevation ?? preset?.elevation ?? 0;
  const change = (patch: Partial<RelightSettings>) =>
    setSettings(previous => ({ ...previous, ...patch }));
  const custom = (az: number, el: number) =>
    change({
      direction: "custom",
      azimuth: Math.max(-180, Math.min(180, Math.round(az))),
      elevation: Math.max(-90, Math.min(90, Math.round(el))),
    });
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width)
      custom(
        ((event.clientX - box.left) / box.width) * 360 - 180,
        90 - ((event.clientY - box.top) / box.height) * 180,
      );
  };

  return (
    <>
      <div className="panel-title">
        <Lightbulb size={20} aria-hidden="true" />
        <h2>Relight</h2>
      </div>
      <div className="control-section">
        <div className="control-heading">
          <div className="relight-heading"><h3>Quick select</h3><ControlHelp label="quick select" example="direction" text="Choose where the light comes from. For example, Top lights from above; Left lights from the left."/></div>
        </div>
        <div className="direction-presets">
          {presets.map((item) => (
            <button
              key={item.direction}
              title={`Light from the ${item.name.toLowerCase()}`}
              aria-pressed={settings.direction === item.direction}
              onClick={() => setSettings(previous => {
                const { azimuth: _a, elevation: _e, ...rest } = previous;
                return { ...rest, direction: item.direction };
              })}
            >
              {item.name}
            </button>
          ))}
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
              const step = arrowSteps[event.key];
              if (!step) return;
              event.preventDefault();
              custom(azimuth + step[0], elevation + step[1]);
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
          <span className="pad-caption">Drag to change light direction</span>
        </div>
        <div className="relight-help-line"><span>Light direction</span><ControlHelp label="light direction" example="direction" text="Drag the dot to change the light's direction. Use the arrow keys to adjust it in steps."/></div>
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
              onChange={(e) =>
                custom(Number(e.target.value), elevation)
              }
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
              onChange={(e) =>
                custom(azimuth, Number(e.target.value))
              }
            />
          </label>
        </details>
      </div>
      <div className="control-section">
        <div className="relight-heading"><h3>Light settings</h3><ControlHelp label="soft and hard light" example="softness" text="Soft light gives gentler transitions; hard light creates more defined highlights and shadows."/></div>
        <div className="segmented">
          {(["soft", "hard"] as const).map((value) => (
            <button
              key={value}
              title={value === "soft" ? "Gentler light transitions" : "More defined light and shadows"}
              aria-pressed={settings.softness === value}
              onClick={() => change({softness: value})}
            >
              {value === "soft" ? "Soft" : "Hard"}
            </button>
          ))}
        </div>
      </div>
      <div className="control-section">
        <div className="control-heading">
          <div className="relight-heading"><label htmlFor="brightness"><strong>Brightness</strong></label><ControlHelp label="brightness" example="brightness" text="Change the intensity of the added light. Higher values make it brighter."/></div>
          <span className="brightness-value">
            {settings.brightness}%
          </span>
        </div>
        <input
          id="brightness"
          aria-label="Brightness"
          type="range"
          min="10"
          max="100"
          step="10"
          value={settings.brightness}
          onChange={(e) => change({brightness: Number(e.target.value)})}
        />
      </div>
      <div className="control-section color-row">
        <div className="relight-heading"><label htmlFor="light-color">
          <strong>Light color</strong>
        </label><ControlHelp label="light color" example="color" text="Choose the color of the added light, such as warm amber or cool blue."/></div>
        <div className="color-input">
          <input
            id="light-color"
            aria-label="Light color"
            type="color"
            value={settings.color}
            onChange={(e) => change({color: e.target.value})}
          />
          <span>{settings.color.toUpperCase()}</span>
        </div>
      </div>
      <div className="control-section seed-row">
        <div className="relight-heading"><label htmlFor="seed">
          <strong>Seed</strong>
        </label><ControlHelp label="seed" example="seed" text="The seed controls randomness. Reusing it with the same input and settings helps reproduce a result."/></div>
        <input
          id="seed"
          aria-label="Seed"
          type="number"
          min="0"
          max={Number.MAX_SAFE_INTEGER}
          step="1"
          value={Number.isNaN(settings.seed) ? "" : settings.seed}
          onChange={(e) => change({seed: e.target.value === "" ? NaN : Number(e.target.value)})}
        />
      </div>
      {!validSeed && (
        <p className="field-error">
          Use a nonnegative whole number up to{" "}
          {Number.MAX_SAFE_INTEGER}.
        </p>
      )}
    </>
  );
}
