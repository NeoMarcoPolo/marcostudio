import type { Asset, Feature } from "./api";
import { ArrowLeftRight, Film, ImagePlus, Upload } from "lucide-react";

export function MediaPreview({feature, source, result, view, comparison, resultLabel, transparent, busy,
  uploading, loading, progress, activity, upload}: {
  feature?: Feature; source?: Asset; result?: Asset; view: "result" | "compare"; comparison: number;
  resultLabel: string; transparent: boolean; busy: boolean; uploading: boolean; loading: boolean; progress?: number | null;
  activity?: string; upload: (file?: File) => void;
}) {
  const display = result ?? source;
  const sourceKind = feature?.source_kind ?? "image";
  const sourceLabel = feature?.source_label;
  const sourceVideo = sourceKind === "video";
  const video = feature?.output_kind === "video";
  return <div className={`image-canvas ${display ? "has-source" : ""} ${result && transparent ? "transparency-preview" : ""}`}>
    {!display ? <div className="empty-canvas">
      {sourceKind === "none" || video ? <div className="prompt-placeholder">
        {video ? <Film size={36} strokeWidth={1.25} aria-hidden="true" /> : <ImagePlus size={36} strokeWidth={1.25} aria-hidden="true" />}
        <p>{activity ?? (video ? "Your video will appear here." : "Describe your image below.")}</p>
      </div> : <div className="upload-card">
        {sourceVideo ? <Film size={36} strokeWidth={1.25} aria-hidden="true" /> : <ImagePlus size={36} strokeWidth={1.25} aria-hidden="true" />}
        <h2>{feature?.name ?? "Relight"}</h2>
        {sourceLabel && sourceLabel !== "Image" && <span className="source-label">{sourceLabel}</span>}
        <p>{sourceVideo ? "MP4, up to 15 seconds and 96 MiB." : "PNG or JPEG, up to 32 MiB."}</p>
        <label className="upload-button"><Upload size={17} aria-hidden="true" />Upload {sourceVideo ? "video" : "image"}
          <input aria-label={`Upload source ${sourceVideo ? "video" : "image"}`} type="file"
            accept={sourceVideo ? "video/mp4" : "image/png,image/jpeg"} disabled={busy}
            onChange={e => {upload(e.target.files?.[0]); e.target.value = "";}} />
        </label>
      </div>}
    </div> : display.media_type === "video/mp4" ? <video key={display.id} className="video-preview"
      aria-label={`${result ? "Result" : "Source"}: ${display.filename}`} src={display.url}
      controls playsInline preload="metadata" /> : <div className="image-stage"
        style={{aspectRatio: `${display.width}/${display.height}`}}>
      {source?.media_type.startsWith("image/") && <img className="source-image"
        src={source.url} alt={`Source: ${source.filename}`} width={source.width} height={source.height}
        style={{visibility: result && view === "result" ? "hidden" : undefined}} />}
      {result && <img className="result-image" src={result.url} alt={`Result: ${result.filename}`}
        width={result.width} height={result.height}
        style={view === "compare" ? {clipPath: `inset(0 0 0 ${comparison}%)`} : undefined} />}
      {result && view === "compare" && <>
        <div className="compare-line" style={{left: `${comparison}%`}}><span aria-hidden="true"><ArrowLeftRight size={16} /></span></div>
        <span className="image-badge before">Original</span><span className="image-badge after">{resultLabel}</span>
      </>}
    </div>}
    {activity && <div className="job-overlay" role="status"><span className="spinner" /><strong>{activity}</strong>
      {progress != null && <span>{Math.round(progress * 100)}%</span>}
    </div>}
    {(uploading || loading) && <div className="job-overlay" role="status"><span className="spinner" />
      {loading ? "Loading generation…" : "Uploading…"}
    </div>}
  </div>;
}
