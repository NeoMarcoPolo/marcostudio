import data from "./catalog.json";
import { videoFrames, type Feature, type FeatureId, type Job, type RelightSettings } from "../api";

export type Graph = Record<string, {class_type: string; inputs: Record<string, unknown>}>;
export interface Model {
  key: string; filename: string; category: string; url: string; size: number;
  sha256: string; repository: string; loader: string; field: string;
}
export interface Variant {mode: string; slots: string[]; control: string; graph: Graph}
export interface CatalogFeature extends Feature {
  schema: {properties: Record<string, Record<string, unknown>>};
  prompt: {empty: string; instruction: string};
  models: Record<string, Model[]>; variants: Variant[]; version: string; source_url: string; workflow_url: string;
  min_source_frames: number;
}
export const catalog = data.features as unknown as CatalogFeature[];
export const getFeature = (id: FeatureId) => {
  const feature = catalog.find(item => item.id === id);
  if (!feature) throw new Error("Unknown tool.");
  return feature;
};

function relightPrompt(settings: RelightSettings) {
  const presets: Record<string, number[]> = {front: [0, 0], right: [90, 0], left: [-90, 0], back: [180, 0], top: [0, 90], bottom: [0, -90]};
  const [az, el] = presets[settings.direction] ?? [settings.azimuth!, settings.elevation!];
  if (!Number.isFinite(az) || !Number.isFinite(el)) throw new Error("Set both light angles.");
  let direction = el >= 60 ? "above" : el <= -60 ? "below" : az >= 45 && az <= 135 ? "the viewer’s right"
    : az >= -135 && az <= -45 ? "the viewer’s left" : Math.abs(az) > 135 ? "behind the subject" : "the camera side";
  if (Math.abs(el) < 60 && Math.abs(el) >= 20) direction += el > 0 ? " and above" : " and below";
  const color = settings.color.toLowerCase();
  const [r, g, b] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const rc = delta ? (max - r) / delta : 0, gc = delta ? (max - g) / delta : 0, bc = delta ? (max - b) / delta : 0;
  let hue = delta === 0 ? 0 : (max === r ? bc - gc : max === g ? 2 + rc - bc : 4 + gc - rc) / 6;
  hue = hue < 0 ? hue + 1 : hue % 1;
  const value = hue * 12, floor = Math.floor(value);
  const bucket = value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
  const name = !max || delta / max < 0.12 ? "neutral white"
    : ["red", "orange", "yellow", "yellow-green", "green", "cyan-green", "cyan", "blue", "deep blue", "violet", "magenta", "pink"][bucket % 12];
  const intensity = ["very dim", "dim", "subdued", "gentle", "moderate", "bright", "strong", "very bright", "intense", "very intense"][settings.brightness / 10 - 1];
  const shadow = settings.softness === "soft" ? "soft diffuse light with gradual shadow transitions" : "hard directional light with crisp shadow edges";
  return `重新照明, Relight this image with ${intensity} ${name} ${shadow} from ${direction}. Requested light color ${color}. Preserve the same subject identity, facial features, text, objects, materials, composition and background geometry. Change illumination, not surface colors or the scene contents.`;
}

export function promptFor(feature: CatalogFeature, settings: Job["settings"]) {
  if ("direction" in settings) return relightPrompt(settings);
  const instruction = "instruction" in settings ? settings.instruction.trim() : "";
  return instruction ? feature.prompt.instruction.replace("__MARCO_INSTRUCTION__", () => instruction) : feature.prompt.empty;
}

export function resolveTemplate(value: unknown, context: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, context));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.$param === "string") {
      let result: unknown = context;
      for (const key of object.$param.split(".")) result = (result as Record<string, unknown>)?.[key];
      if (result === undefined) throw new Error(`Missing workflow value: ${object.$param}`);
      return result;
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveTemplate(item, context)]));
  }
  return value;
}

export function compile(feature: CatalogFeature, settings: Job["settings"], source: string | null,
  inputs: Record<string, string>, models: Record<string, string>, prefix: string): Graph {
  const slots = Object.keys(inputs).sort();
  const variant = feature.variants.find(v => v.mode === settings.mode && v.slots.join() === slots.join()
    && (!v.control || v.control === ("control_type" in settings ? settings.control_type : "")));
  if (!variant) throw new Error("Add the required inputs in order.");
  const duration = "duration" in settings ? settings.duration ?? 5 : 5;
  return resolveTemplate(variant.graph, {settings: {...settings, frames: videoFrames(duration), actual_duration: videoFrames(duration) / 24},
    source, inputs, models, prefix, prompt: promptFor(feature, settings)}) as Graph;
}

function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(option => matchesSchema(value, option));
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "integer" && !Number.isSafeInteger(value)) return false;
  if (schema.type === "number" && typeof value !== "number") return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < Number(schema.minimum ?? -Infinity)
    || value > Number(schema.maximum ?? Infinity) || value <= Number(schema.exclusiveMinimum ?? -Infinity)
    || value >= Number(schema.exclusiveMaximum ?? Infinity) || (schema.multipleOf && value % Number(schema.multipleOf)))) return false;
  if (typeof value === "string" && (value.length > Number(schema.maxLength ?? Infinity)
    || (schema.pattern && !new RegExp(String(schema.pattern)).test(value)))) return false;
  if (schema.type === "array") return Array.isArray(value) && value.length >= Number(schema.minItems ?? 0)
    && value.length <= Number(schema.maxItems ?? Infinity) && value.every(item => matchesSchema(item, schema.items as Record<string, unknown>));
  return true;
}

export function validateSettings(feature: CatalogFeature, settings: Job["settings"]) {
  if (!feature.supported_modes.includes(settings.mode)) throw new Error("Unsupported mode.");
  for (const [key, value] of Object.entries(settings)) {
    const schema = feature.schema.properties[key];
    if (!schema) throw new Error(`Unknown setting: ${key}`);
    if (!matchesSchema(value, schema)) throw new Error(`Invalid ${key}.`);
  }
  if (feature.output_kind === "video" && "width" in settings && settings.width * settings.height > 768 * 1344)
    throw new Error("Choose a smaller video size.");
  if (feature.id === "keyframes" && "guide_frames" in settings && !settings.guide_frames?.every((v, i, a) =>
    Number.isInteger(v) && v > (a[i - 1] ?? 0) && v < videoFrames(settings.duration ?? 5))) throw new Error("Guide frames must be in order and inside the video.");
  if (!promptFor(feature, settings).trim()) throw new Error("Enter a prompt.");
}
