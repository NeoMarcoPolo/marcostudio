"""Pinned upstream model and public workflow provenance, without runtime downloads."""

from types import SimpleNamespace

from ..models import Model

SOURCE_REVISION = "67984637eefcd4825dcf5c134e39034785be1682"
MODEL_REVISION = "e5eb578a89295337b8ff433a035929ce0279e0b6"


def _model(
    key,
    category,
    filename,
    size,
    sha256,
    loader,
    field,
    *,
    repository="Comfy-Org/MiniMax-H3",
    revision=MODEL_REVISION,
):
    return Model(
        key,
        category,
        filename,
        size,
        sha256,
        repository,
        revision,
        f"{category}/{filename}",
        loader,
        field,
    )


ENCODER = _model(
    "h3_encoder",
    "text_encoders",
    "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    27141342152,
    "bc2ced0fbea64757fa9acddccfc0b3f4819d1dcf1da6c124d690d368be283923",
    "CLIPLoader",
    "clip_name",
)
VIDEO_VAE = _model(
    "h3_vae",
    "vae",
    "minimax_h3_video_vae_fp16.safetensors",
    5207808496,
    "7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522",
    "VAELoader",
    "vae_name",
)
AUDIO_VAE = _model(
    "h3_audio_vae",
    "vae",
    "minimax_h3_audio_vae_fp32.safetensors",
    605254808,
    "8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48",
    "VAELoader",
    "vae_name",
)
FL = _model(
    "h3_diffusion",
    "diffusion_models",
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    20970379616,
    "e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a",
    "UNETLoader",
    "unet_name",
)
REF = _model(
    "h3_diffusion",
    "diffusion_models",
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    20970379616,
    "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779",
    "UNETLoader",
    "unet_name",
)
FAST_FL = _model(
    "h3_diffusion",
    "diffusion_models",
    "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
    22128378696,
    "0922785978dc9bfe1adf27d8b291b0ca763f9f165f882e6cb297c72fbb6deda8",
    "UNETLoader",
    "unet_name",
    repository="FastVideo/FastVideo-FastH3-Comfy",
    revision="ec1e3aa374a91c57b0b94a1623b7e657c0498cf2",
)
FAST_REF = _model(
    "h3_diffusion",
    "diffusion_models",
    "fasth3_omniref_8step_pruned_int8_convrot.safetensors",
    22213723064,
    "851b2dc9670ed864b7f1e951ac9da047d83b1c04ded9bfcc1a9e5bba0ee33f80",
    "UNETLoader",
    "unet_name",
    repository="FastVideo/FastH3-OmniRef-Comfy",
    revision="82eff2a6eee6c962846879f4bab52610a4df24d3",
)
CONTROL = _model(
    "h3_control",
    "model_patches",
    "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors",
    4531220608,
    "890af58bb350f0c2f6c409b1c67ea8f4196654297d037769b72de1e6f504c612",
    "ModelPatchLoader",
    "name",
)

COMMON = (ENCODER, VIDEO_VAE, AUDIO_VAE)
TEMPLATES = {
    "create-video": (
        "video_minimax_h3_t2v.json",
        "8a5eb23b0dd2df9e99b6f7af9684e770f188feca820d241364b729e01dedf3b6",
    ),
    "animate-image": (
        "video_minimax_h3_i2v.json",
        "34ee39544808fd3b0dc8de9df082940d4d41c3771beb80d3988c1ea5531cec0d",
    ),
    "transition": (
        "video_minimax_h3_i2v.json",
        "34ee39544808fd3b0dc8de9df082940d4d41c3771beb80d3988c1ea5531cec0d",
    ),
    "restyle-video": (
        "video_minimax_h3_r2v.json",
        "afeea99e9fd5a1456df348e0573e289c1243f2f28546fc95c1c963f808d61ddb",
    ),
    "keyframes": (
        "video_minimax_h3_multiframe_reference.json",
        "a0526a9f0d67f3fac3ad48bda26c86aa6871c0322a5034534fdfa39d9637e641",
    ),
    "motion-control": (
        "video_minimax_h3_fun_controlnet_union.json",
        "8f6c8f1bbc732b9bf88ac574b279dbac2d163818c4b24067e475ef662c8c831e",
    ),
}
FLASH_TEMPLATES = {
    "create-video": (
        "video_fastvideo_fasth3_t2v.json",
        "416fdaf93f35e90c41afc531f05fbfd234ff55c61bd99f643527b2204324da62",
    ),
    "animate-image": (
        "video_fastvideo_fasth3_i2v.json",
        "5a9d8d03bd9215f4f388d01d858e5c3218c28bed5f488efaca7870367654eacd",
    ),
    "transition": (
        "video_fastvideo_fasth3_i2v.json",
        "5a9d8d03bd9215f4f388d01d858e5c3218c28bed5f488efaca7870367654eacd",
    ),
    "restyle-video": (
        "video_fasth3_ominiref_r2v.json",
        "38ac8a5b99035f85f240c3aec91ec9b898696097982ee3ba7cdc30f3bace1413",
    ),
}


def for_tool(tool):
    reference = tool in ("restyle-video", "keyframes")
    models = ((REF if reference else FL), *COMMON)
    if tool == "motion-control":
        models += (CONTROL,)
    sets = {"standard": models}
    if tool not in ("motion-control", "keyframes"):
        sets["flash"] = ((FAST_REF if reference else FAST_FL), *COMMON)
    filename, sha = TEMPLATES[tool]
    sources = {"standard": {"filename": filename, "sha256": sha}}
    if tool in FLASH_TEMPLATES:
        flash_file, flash_sha = FLASH_TEMPLATES[tool]
        sources["flash"] = {"filename": flash_file, "sha256": flash_sha}
    for source in sources.values():
        source["url"] = (
            f"https://github.com/Comfy-Org/workflow_templates/blob/{SOURCE_REVISION}/templates/{source['filename']}"
        )
    return SimpleNamespace(
        MODELS=models,
        MODEL_SETS=sets,
        WORKFLOW_VERSION=f"minimax-h3-{tool}-v{3 if tool in ('restyle-video', 'motion-control') else 2 if tool == 'keyframes' else 1}",
        SOURCE_REVISION=SOURCE_REVISION,
        SOURCE_SHA256=sha,
        SOURCE_URL=f"https://github.com/Comfy-Org/workflow_templates/blob/{SOURCE_REVISION}/templates/{filename}",
        SOURCES=sources,
        VARIANT_SOURCES=sources,
    )
