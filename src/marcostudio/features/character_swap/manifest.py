"""Pinned Akatz V1.5/Turbo8 recipe and exact public checkpoint identities."""

from ..models import Model
from ..video_tools.manifest import AUDIO_VAE, MODEL_REVISION, REF, VIDEO_VAE

WORKFLOW_VERSION = "minimax-h3-character-swap-v1.5-turbo8-window-v2"
SOURCE_REVISION = "96ea3407b230b6f7df71c58c70e31df96bd7e533"
SOURCE_SHA256 = "d128d297ecb2696d9560a6eaffec261f29eb502b31c08288dc34d517f65bc476"
SOURCE_URL = (
    "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/blob/"
    f"{SOURCE_REVISION}/examples/H3-Character-Swap-Relay-V2.api.json"
)
RECIPE_REVISION = "e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220"
RECIPE_URL = f"https://github.com/akatz-ai/h3-relay/blob/{RECIPE_REVISION}/h3_relay/workflows.py"

ENCODER = Model(
    "h3_character_encoder",
    "text_encoders",
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    15687142551,
    "35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6",
    "Comfy-Org/MiniMax-H3",
    MODEL_REVISION,
    "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "CLIPLoader",
    "clip_name",
)
TURBO = Model(
    "h3_turbo_8step",
    "loras",
    "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    1956193000,
    "08cfe946033af7d27719b964b6e0a0e50c32138daabbd6ce4137e23df6bf9980",
    "lightx2v/Minimax-h3-Turbo",
    "30f485ed874aa44c8183348ad361c5eabad318da",
    "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    "LoraLoaderModelOnly",
    "lora_name",
)
CHARACTER = Model(
    "h3_character_swap",
    "loras",
    "h3_character_swap_v1.5.safetensors",
    155110792,
    "8f2c3c3eba161df8d0c6099598b4730f641f5ce01e04cd16d2427cff8a35218f",
    "akatz-ai/MiniMax-H3-Character-Swap-LoRA",
    SOURCE_REVISION,
    "h3_character_swap_v1.5.safetensors",
    "LoraLoaderModelOnly",
    "lora_name",
)
MODELS = (REF, ENCODER, VIDEO_VAE, AUDIO_VAE, TURBO, CHARACTER)
MODEL_SETS = {"standard": MODELS}
SOURCES = {
    "standard": {
        "filename": "H3-Character-Swap-Relay-V2.api.json",
        "sha256": SOURCE_SHA256,
        "url": SOURCE_URL,
        "recipe_url": RECIPE_URL,
        "adaptation": "single window; no mask or scene anchor; source soundtrack",
    }
}
VARIANT_SOURCES = SOURCES
