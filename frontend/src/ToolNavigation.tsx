import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clapperboard, Image, Layers, Lightbulb, Move, Paintbrush, Scissors, Shirt, ShoppingBag, Video, WandSparkles } from "lucide-react";
import type { Feature, FeatureId } from "./api";

const groups = [
  { name: "Image", tools: ["create-image", "edit-image"] },
  { name: "Video", tools: ["create-video", "animate-image", "transition", "restyle-video", "character-swap", "keyframes", "motion-control"] },
  { name: "Apps", tools: ["relight", "remove-background", "ai-stylist", "product-scene"] },
] as const;

export const toolIcons = {
  "create-image": Image, "edit-image": WandSparkles, "create-video": Video,
  "animate-image": Clapperboard, transition: Layers, "restyle-video": Paintbrush,
  "character-swap": Shirt,
  keyframes: Image, "motion-control": Move, relight: Lightbulb,
  "remove-background": Scissors, "ai-stylist": Shirt, "product-scene": ShoppingBag,
};

export const toolGroup = (id: FeatureId) => groups.find(group => group.tools.some(tool => tool === id))?.name ?? "Apps";

export function ToolNavigation({ features, selected, disabled, select }: {
  features: Feature[]; selected: FeatureId; disabled: boolean; select: (id: FeatureId) => void;
}) {
  const [open, setOpen] = useState<string>();
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!navigation.current?.contains(event.target as Node)) setOpen(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return <nav className="tool-navigation" aria-label="Tools" ref={navigation}
    onKeyDown={event => {
      if (event.key === "Escape" && open) {
        navigation.current?.querySelector<HTMLButtonElement>(`#nav-${open}`)?.focus();
        setOpen(undefined);
      }
    }}>
    {groups.map(group => <div className="nav-group" key={group.name}>
      <button id={`nav-${group.name}`} className="nav-trigger" aria-expanded={open === group.name}
        aria-controls={`tools-${group.name}`} aria-current={toolGroup(selected) === group.name ? "true" : undefined}
        disabled={disabled || !features.length}
        onClick={() => setOpen(open === group.name ? undefined : group.name)}>
        {group.name}<ChevronDown size={12} aria-hidden="true" />
      </button>
      {open === group.name && <div className="tool-menu" id={`tools-${group.name}`}>
        {group.tools.map(id => {
          const feature = features.find(item => item.id === id);
          if (!feature) return null;
          const Icon = toolIcons[id];
          return <button key={id} aria-pressed={selected === id} disabled={disabled}
            onClick={() => { select(id); setOpen(undefined); navigation.current?.querySelector<HTMLButtonElement>(`#nav-${group.name}`)?.focus(); }}>
            <span className="tool-icon"><Icon size={18} aria-hidden="true" /></span>
            <span>{feature.name}</span>
            {selected === id && <Check className="tool-check" size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>}
    </div>)}
  </nav>;
}
