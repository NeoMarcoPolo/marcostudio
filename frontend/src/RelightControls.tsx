import type { Dispatch, PointerEvent, SetStateAction } from "react";
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
          <h3>Quick select</h3>
        </div>
        <div className="direction-presets">
          {presets.map((item) => (
            <button
              key={item.direction}
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
        <h3>Light settings</h3>
        <div className="segmented">
          {(["soft", "hard"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={settings.softness === value}
              onClick={() => change({softness: value})}
            >
              {value === "soft" ? "Soft" : "Hard"}
            </button>
          ))}
        </div>
      </div>
      <div className="control-section">
        <label className="control-heading" htmlFor="brightness">
          <strong>Brightness</strong>
          <span className="brightness-value">
            {settings.brightness}%
          </span>
        </label>
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
        <label htmlFor="light-color">
          <strong>Light color</strong>
        </label>
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
