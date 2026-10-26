import { videoFrames, type Asset, type CreativeSettings, type Feature, type FeatureId } from "./api";
import { Cpu, Plus, SlidersHorizontal, Upload, X } from "lucide-react";

const prompts: Partial<Record<FeatureId, string>> = {
  "create-image": "Describe the image you want to create.",
  "edit-image": "Describe what to change. Refer to the source as <image1> and references as <image2>, <image3>…",
  "ai-stylist": "Optional outfit adjustments.",
  "product-scene": "Describe the setting, composition and lighting.",
  "create-video": "Describe the scene, action, camera movement and sound.",
  "animate-image": "Describe the movement and sound.",
  transition: "Describe how the first frame becomes the last.",
  "restyle-video": "Describe how to transform <Video 1>. Use <Picture 1> and <Picture 2> for references.",
  "character-swap": "Replace the person in <Video 1> with <Picture 1>, keeping the performance and scene.",
  keyframes: "Describe the action between the keyframes.",
  "motion-control": "Describe the scene to generate using the video's movement.",
};

export function SourceInput({feature, source, disabled, upload}: {
  feature: Feature; source?: Asset; disabled: boolean; upload: (file?: File) => void;
}) {
  return <div className="source-input">
    <div className="reference-heading"><strong>{feature.source_label ?? "Source"}</strong><span>Required</span></div>
    <label className="reference-upload">
      {source?.media_type.startsWith("image/") ? <img src={source.url} alt="" /> : <Upload size={22} aria-hidden="true" />}
      <span>{source?.filename ?? `Upload ${feature.source_kind}`}</span>
      <input aria-label={`Upload source ${feature.source_kind}`} type="file"
        accept={feature.source_kind === "video" ? "video/mp4" : "image/png,image/jpeg"} disabled={disabled}
        onChange={event => {upload(event.target.files?.[0]); event.target.value = "";}} />
    </label>
  </div>;
}

export function ToolControls({feature, value, change, masked = false}: {
  feature: Feature; value: CreativeSettings; change: (patch: Partial<CreativeSettings>) => void; masked?: boolean;
}) {
  const video = feature.output_kind === "video";
  const sizes = video
    ? [[768, 448], [448, 768], [640, 640], [1344, 768], [768, 1344]]
    : [[1024, 1024], [1536, 1024], [1024, 1536], [1536, 864], [2048, 2048]];
  const currentSize = `${value.width}x${value.height}`;
  return <>
    <div className="creative-prompt">
      <label htmlFor="prompt" className="sr-only">Prompt</label>
      <textarea id="prompt" aria-label="Prompt" rows={2} maxLength={video ? 12000 : 6000}
        placeholder={prompts[feature.id]} value={value.instruction}
        onChange={event => change({instruction: event.target.value})} />
    </div>
    <div className="composer-options">
      <span className="model-label"><Cpu size={14} aria-hidden="true" />{video ? "H3" : "Qwen Image 2.1"}</span>
      {video || feature.source_kind === "none" ? <label className="select-control">
        <span>Size</span>
        <select aria-label="Size" value={currentSize} onChange={event => {
          const [width, height] = event.target.value.split("x").map(Number);
          change({width, height});
        }}>
          {!sizes.some(([w, h]) => `${w}x${h}` === currentSize) && <option value={currentSize}>{value.width} × {value.height}</option>}
          {sizes.map(([w, h]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w} × {h}</option>)}
        </select>
      </label> : <label className="select-control">
        <span>Resolution</span>
        <select aria-label="Resolution" value={value.resolution ?? 1024}
          onChange={event => change({resolution: Number(event.target.value)})}>
          {[512, 1024, 1536, 2048].map(size => <option key={size} value={size}>{size} px</option>)}
        </select>
      </label>}
      {video && <label className="select-control"><span>Duration</span>
        <select aria-label="Duration" value={value.duration ?? 5} onChange={event => change({duration: Number(event.target.value)})}>
          {(feature.id === "character-swap" ? [2, 3, 5] : [2, 3, 5, 8, 10]).map(seconds => <option key={seconds} value={seconds}>{feature.id === "character-swap" ? seconds : Number((videoFrames(seconds) / 24).toFixed(2))} sec</option>)}
        </select>
      </label>}
      {feature.id === "motion-control" && <>
        {!masked && <label className="select-control motion-option">Motion source
          <select aria-label="Motion source" value={value.control_type} onChange={e => change({control_type: e.target.value as CreativeSettings["control_type"]})}>
            <option value="canny">Extract edges from video</option>
            <option value="preprocessed">Use prepared control video</option>
          </select>
        </label>}
        <label className="select-control motion-option">Control strength
          <input aria-label="Control strength" type="number" min={0.1} max={2} step={0.1}
            value={value.strength ?? 1} onChange={e => change({strength: Number(e.target.value)})} />
        </label>
      </>}
    <details className="creative-advanced">
      <summary><SlidersHorizontal size={14} aria-hidden="true" /><span>Advanced</span></summary>
      <div className="advanced-popover">
      <label className="select-control">Seed
        <input aria-label="Seed" type="number" min={0} max={Number.MAX_SAFE_INTEGER}
          value={Number.isNaN(value.seed) ? "" : value.seed} onChange={e => change({seed: e.target.value === "" ? NaN : Number(e.target.value)})} />
      </label>
      </div>
    </details>
    </div>
  </>;
}

export function InputAssets({feature, inputs, disabled, upload, remove, settings, change}: {
  feature: Feature; inputs: Record<string, Asset>; disabled: boolean;
  upload: (file: File | undefined, key: string) => void; remove: (key: string) => void;
  settings?: CreativeSettings; change: (patch: Partial<CreativeSettings>) => void;
}) {
  const slots = feature.input_slots ?? [];
  const guide = feature.id === "keyframes";
  const frames = settings?.guide_frames ?? [48];
  if (!slots.length) return null;
  return <div className="reference-inputs" aria-label="Reference inputs">
    {slots.map((slot, index) => {
      const asset = inputs[slot.key];
      return <div className="reference-slot" key={slot.key}>
        <div className="reference-heading"><strong>{slot.label}</strong><span>{slot.required ? "Required" : "Optional"}</span></div>
        <label className={`reference-upload ${asset ? "filled" : ""}`}>
          {asset ? <img src={asset.url} alt={slot.label} /> : <Plus size={18} aria-hidden="true" />}
          <span>{asset?.filename ?? `Upload ${slot.label.toLowerCase()}`}</span>
          <input aria-label={`Upload ${slot.label}`} type="file" accept="image/png,image/jpeg"
            disabled={disabled || (index > 0 && !inputs[slots[index - 1].key])}
            onChange={e => { upload(e.target.files?.[0], slot.key); e.target.value = ""; }} />
        </label>
        {asset && <button className="remove-reference" disabled={disabled} onClick={() => remove(slot.key)} aria-label={`Remove ${slot.label}`}><X size={12} aria-hidden="true" /></button>}
        {guide && asset && <label className="guide-time">At second
          <input aria-label={`${slot.label} time`} type="number" min={1 / 24} step={1 / 24}
            max={(videoFrames(settings?.duration ?? 5) - 1) / 24} value={(frames[index] ?? (index + 1) * 24) / 24}
            disabled={disabled} onChange={e => {
              const next = [...frames]; next[index] = Math.round(Number(e.target.value) * 24);
              change({guide_frames: next});
            }} />
        </label>}
      </div>;
    })}
  </div>;
}
