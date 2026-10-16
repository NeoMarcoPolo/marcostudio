"""API graph derived from the attributed, pinned public ComfyUI template."""

from .manifest import MODELS
from .settings import RelightSettings


def compile_workflow(
    settings: RelightSettings, input_name: str, output_prefix: str, model_names: dict[str, str]
) -> dict:
    if settings.mode != "flash":
        raise ValueError("Standard is not validated for this Relight profile. Use Flash.")
    models = {m.key: model_names.get(m.key, m.filename) for m in MODELS}

    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    return {
        "11": node("LoadImage", image=input_name),
        "37": node("UNETLoader", unet_name=models["diffusion"], weight_dtype="default"),
        "38": node("CLIPLoader", clip_name=models["encoder"], type="qwen_image", device="default"),
        "39": node("VAELoader", vae_name=models["vae"]),
        "89": node(
            "LoraLoaderModelOnly",
            model=["37", 0],
            lora_name=models["lightning"],
            strength_model=1.0,
        ),
        "118": node(
            "LoraLoaderModelOnly", model=["89", 0], lora_name=models["relight"], strength_model=1.0
        ),
        "66": node("ModelSamplingAuraFlow", model=["118", 0], shift=3.0),
        "75": node("CFGNorm", model=["66", 0], strength=1.0),
        "117": node("FluxKontextImageScale", image=["11", 0]),
        "110": node(
            "TextEncodeQwenImageEditPlus",
            clip=["38", 0],
            vae=["39", 0],
            image1=["117", 0],
            prompt="",
        ),
        "111": node(
            "TextEncodeQwenImageEditPlus",
            clip=["38", 0],
            vae=["39", 0],
            image1=["117", 0],
            prompt=settings.prompt(),
        ),
        "88": node("VAEEncode", pixels=["117", 0], vae=["39", 0]),
        "3": node(
            "KSampler",
            model=["75", 0],
            positive=["111", 0],
            negative=["110", 0],
            latent_image=["88", 0],
            seed=settings.seed,
            steps=4,
            cfg=1.0,
            sampler_name="euler",
            scheduler="simple",
            denoise=1.0,
        ),
        "8": node("VAEDecode", samples=["3", 0], vae=["39", 0]),
        "12": node("SaveImage", images=["8", 0], filename_prefix=output_prefix),
    }
