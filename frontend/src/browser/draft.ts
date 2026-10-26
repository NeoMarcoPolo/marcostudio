import type { Asset, CreativeFeatureId, CreativeSettings, FeatureId, RelightSettings, RemoveBackgroundSettings } from "../api";
import { getAsset } from "./assets";
import { catalog } from "./catalog";
import { endpoint } from "./connection";
import { read, write } from "./storage";

export interface Draft {
  featureId: FeatureId;
  settings: RelightSettings;
  backgroundSettings: RemoveBackgroundSettings;
  creativeSettings: Partial<Record<CreativeFeatureId, CreativeSettings>>;
  sourceId?: string;
  inputIds: Record<string, string>;
  selected?: string;
}
export function savedDraft() {
  const draft = read<Draft | null>(endpoint(), "draft", null);
  return draft && catalog.some(feature => feature.id === draft.featureId) ? draft : null;
}
export const saveDraft = (draft: Draft) => write(endpoint(), "draft", draft);
export async function draftAssets(draft: Draft) {
  const inputs: Record<string, Asset> = {};
  for (const [key, id] of Object.entries(draft.inputIds)) inputs[key] = await getAsset(id);
  return {inputs, source: draft.sourceId ? await getAsset(draft.sourceId) : undefined};
}
