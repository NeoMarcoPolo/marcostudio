export function SampleHelp({imageTool, hasSource, disabled, onLoadSample}: {
  imageTool: boolean; hasSource: boolean; disabled: boolean; onLoadSample: () => void;
}) {
  return <details className="sample-help">
    <summary>Try a sample</summary>
    <p>Use a sample image with an image tool, or try a small ComfyUI workflow that loads and saves an image. The workflow checks image input and output; it does not test model inference.</p>
    {imageTool && (hasSource
      ? <p>A source image is already loaded. The sample will not replace it.</p>
      : <button type="button" disabled={disabled} onClick={onLoadSample}>Use sample image</button>)}
    <p><a href="./sample-image.jpg" download="marcostudio-sample.jpg">Download sample image</a>{" · "}<a href="./sample-image-check.json" download="marcostudio-sample-workflow.json">Download sample workflow</a></p>
    <p>Open the workflow in ComfyUI, choose the sample image in its Load Image node, and run it there when you are ready. The image is from <a href="https://www.getcraver.com/wp-content/uploads/2025/10/Blog-Covers-21-1024x577.jpg" target="_blank" rel="noopener noreferrer">Get Craver</a>.</p>
  </details>;
}
