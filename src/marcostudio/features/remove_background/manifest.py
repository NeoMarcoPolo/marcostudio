from ..models import Model

WORKFLOW_VERSION = "qwen21-remove-background-v1"
SOURCE_REVISION = "e7cd011d4ded3411c2f481200544f0be6fdc962e"
SOURCE_SHA256 = "2fca0a2581fd428f4a2007d8d4acede4a31dcb79976b177ec5243b8208e19de0"
SOURCE_URL = f"https://github.com/Comfy-Org/workflow_templates/blob/{SOURCE_REVISION}/templates/image_qwen_image_2_1_background_removal.json"
MODEL_REVISION = "a8342359c61979b06a8dafb1a47991fe1f30e994"

MODELS = (
    Model(
        "qwen21_diffusion",
        "diffusion_models",
        "qwen_image_2.1_int8_convrot.safetensors",
        7256783064,
        "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d",
        "Comfy-Org/Qwen-Image-2.1",
        MODEL_REVISION,
        "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
        "UNETLoader",
        "unet_name",
    ),
    Model(
        "qwen21_encoder",
        "text_encoders",
        "qwen3vl_8b_int8_convrot.safetensors",
        9350798360,
        "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
        "Comfy-Org/Qwen-Image-2.1",
        MODEL_REVISION,
        "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
        "CLIPLoader",
        "clip_name",
    ),
    Model(
        "qwen21_vae",
        "vae",
        "qwen_image_2.1_vae_bf16.safetensors",
        675509688,
        "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
        "Comfy-Org/Qwen-Image-2.1",
        MODEL_REVISION,
        "vae/qwen_image_2.1_vae_bf16.safetensors",
        "VAELoader",
        "vae_name",
    ),
)
