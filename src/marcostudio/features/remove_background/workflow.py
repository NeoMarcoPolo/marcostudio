from .manifest import MODELS
from .settings import RemoveBackgroundSettings


def compile_workflow(
    settings: RemoveBackgroundSettings,
    source: str,
    prefix: str,
    models: dict[str, str],
    *,
    inputs=None,
) -> dict:
    """Official base edit path, with a bounded reference size and direct RGBA PNG output."""
    names = {m.key: models.get(m.key, m.filename) for m in MODELS}

    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}

    return {
        "11": node("LoadImage", image=source),
        "13": node("JoinImageWithAlpha", image=["11", 0], alpha=["11", 1]),
        "37": node("UNETLoader", unet_name=names["qwen21_diffusion"], weight_dtype="default"),
        "38": node(
            "CLIPLoader", clip_name=names["qwen21_encoder"], type="qwen_image", device="default"
        ),
        "39": node("VAELoader", vae_name=names["qwen21_vae"]),
        "40": node("QwenImage21Cache", model=["37", 0], device="auto", dtype="default"),
        "41": node(
            "TextEncodeQwenImage21",
            clip=["38", 0],
            vae=["39", 0],
            prompt=settings.prompt(),
            negative_prompt="",
            resolution=1024,
            **{"images.image_1": ["13", 0]},
        ),
        "3": node(
            "KSampler",
            model=["40", 0],
            positive=["41", 0],
            negative=["41", 1],
            latent_image=["41", 2],
            seed=settings.seed,
            steps=25,
            cfg=1.0,
            sampler_name="euler",
            scheduler="simple",
            denoise=1.0,
        ),
        "8": node("VAEDecode", samples=["3", 0], vae=["39", 0]),
        "12": node("SaveImage", images=["8", 0], filename_prefix=prefix),
    }
