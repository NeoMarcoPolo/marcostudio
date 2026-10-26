"""Qwen Image 2.1 creation and reference editing workflows."""

from types import SimpleNamespace
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..models import Model
from ..remove_background.manifest import MODELS as BASE_MODELS

REVISION = "67984637eefcd4825dcf5c134e39034785be1682"
TURBO = Model(
    "qwen21_diffusion",
    "diffusion_models",
    "qwen_image_2.1_turbo_int8_convrot.safetensors",
    7256787829,
    "8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c",
    "Comfy-Org/Qwen-Image-2.1",
    "0217efd1d9c9452e84f6448903d6e21bfa171ffd",
    "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
    "UNETLoader",
    "unet_name",
)
FLASH_MODELS = (TURBO, *BASE_MODELS[1:])
TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"


class ImageSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    mode: Literal["standard", "flash"] = "standard"
    seed: int = Field(default=0, ge=0, le=9007199254740991, strict=True)
    instruction: str = Field(default="", max_length=6000)
    # Accept the empty value saved by earlier versions without advertising an
    # ineffective control: these fixed sampler profiles use CFG 1.
    negative_prompt: Literal[""] = ""
    width: int = Field(default=1024, ge=256, le=2048, multiple_of=32, strict=True)
    height: int = Field(default=1024, ge=256, le=2048, multiple_of=32, strict=True)
    resolution: Literal[512, 1024, 1536, 2048] = 1024

    def prompt(self):
        return self.instruction


class StylistSettings(ImageSettings):
    def prompt(self):
        return (
            "Dress the person in <image1> in the outfit shown in <image2>. "
            "Preserve the person's identity, face, body proportions, pose and background. "
            "Match the garment's cut, fabric, pattern and colors; fit it naturally to the person. "
            + self.instruction
        ).strip()


class ProductSettings(ImageSettings):
    def prompt(self):
        return (
            "Create a product photograph featuring the product in <image1>. "
            "Preserve the product's shape, material, color, logos and readable label text. "
            "Use any additional reference image for the setting and composition. "
            + (self.instruction or "Place it on a clean studio surface with soft natural shadows.")
        ).strip()


def compile_workflow(settings, source, prefix, models, *, inputs=None):
    selected = FLASH_MODELS if settings.mode == "flash" else BASE_MODELS
    names = {m.key: models.get(m.key, m.filename) for m in selected}

    def node(kind, **kwargs):
        return {"class_type": kind, "inputs": kwargs}

    graph = {
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
            negative_prompt=settings.negative_prompt,
            resolution=settings.resolution,
        ),
        "8": node("VAEDecode", samples=["3", 0], vae=["39", 0]),
        "12": node("SaveImage", images=["8", 0], filename_prefix=prefix),
    }
    references = ([source] if source is not None else []) + [
        value for _, value in sorted((inputs or {}).items())
    ]
    for i, reference in enumerate(references, 1):
        key = str(100 + i)
        graph[key] = node("LoadImage", image=reference)
        rgba = str(200 + i)
        graph[rgba] = node("JoinImageWithAlpha", image=[key, 0], alpha=[key, 1])
        graph["41"]["inputs"][f"images.image_{i}"] = [rgba, 0]
    latent = ["41", 2]
    if source is None:
        graph["42"] = node(
            "EmptyLatentImage", width=settings.width, height=settings.height, batch_size=1
        )
        latent = ["42", 0]
    if settings.mode == "flash":
        graph.update(
            {
                "43": node("ManualSigmas", sigmas=TURBO_SIGMAS),
                "44": node("KSamplerSelect", sampler_name="euler"),
                "45": node("RandomNoise", noise_seed=settings.seed),
                "46": node(
                    "CFGGuider", model=["40", 0], positive=["41", 0], negative=["41", 1], cfg=1.0
                ),
                "3": node(
                    "SamplerCustomAdvanced",
                    noise=["45", 0],
                    guider=["46", 0],
                    sampler=["44", 0],
                    sigmas=["43", 0],
                    latent_image=latent,
                ),
            }
        )
    else:
        graph["3"] = node(
            "KSampler",
            model=["40", 0],
            positive=["41", 0],
            negative=["41", 1],
            latent_image=latent,
            seed=settings.seed,
            steps=25,
            cfg=1.0,
            sampler_name="euler",
            scheduler="simple",
            denoise=1.0,
        )
    return graph


def entries():
    references = tuple(
        {"key": f"reference_{i}", "label": f"Reference {i}", "kind": "image", "required": False}
        for i in range(1, 4)
    )
    definitions = (
        ("create-image", "Create Image", ImageSettings, "none", "", ()),
        ("edit-image", "Edit Image", ImageSettings, "image", "Image", references),
        (
            "ai-stylist",
            "AI Stylist",
            StylistSettings,
            "image",
            "Person",
            ({"key": "reference_1", "label": "Outfit", "kind": "image", "required": True},),
        ),
        (
            "product-scene",
            "Product Scene",
            ProductSettings,
            "image",
            "Product",
            (
                {
                    "key": "reference_1",
                    "label": "Scene reference",
                    "kind": "image",
                    "required": False,
                },
            ),
        ),
    )
    for key, name, settings, kind, label, slots in definitions:
        text = kind == "none"
        template = (
            "image_qwen_image_2_1_t2i.json" if text else "image_qwen_image_2_1_image_edit.json"
        )
        digest = (
            "5f2b50eeaf27e56a45456681ad5319df1ae51243d9653ac3f92c7dc05d1e1503"
            if text
            else "c1e6551759de131f083a040da072ac6f032c3c8401ceca202412cd912897d0fc"
        )
        yield dict(
            id=key,
            name=name,
            settings=settings,
            compile=compile_workflow,
            manifest=SimpleNamespace(
                MODELS=BASE_MODELS,
                MODEL_SETS={"standard": BASE_MODELS, "flash": FLASH_MODELS},
                WORKFLOW_VERSION=f"qwen21-{key}-v2",
                SOURCE_REVISION=REVISION,
                SOURCE_SHA256=digest,
                SOURCE_URL=f"https://github.com/Comfy-Org/workflow_templates/blob/{REVISION}/templates/{template}",
                VARIANT_SOURCES={
                    "flash": {
                        "sha256": "3eb9cef2866c0186fbe30172701f112b35e574cf3c6575c6e4a6b5dd1e76a403"
                        if text
                        else "5a9622d550866800414afcb9c70523ec5c6965eb171476e401e243a7fe8d5a4e",
                        "url": f"https://github.com/Comfy-Org/workflow_templates/blob/{REVISION}/templates/image_qwen_image_2_1_turbo_{'t2i' if text else 'image_edit'}.json",
                    }
                },
            ),
            modes=("standard", "flash"),
            source_kind=kind,
            source_label=label,
            input_slots=slots,
        )
