from ..models import Model

WORKFLOW_VERSION = "qwen2509-relight-flash-v1"
SOURCE_REVISION = "04a508b31bec1818e48122ca0761c1de4140a234"
SOURCE_SHA256 = "bf17a8412db73407c3bc74d85db1af1ea3385a89bf51227235f5a49583fb5fca"
SOURCE_URL = f"https://github.com/Comfy-Org/workflow_templates/blob/{SOURCE_REVISION}/templates/image_qwen_image_edit_2509_relight.json"


MODELS = (
    Model(
        "diffusion",
        "diffusion_models",
        "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        20430698424,
        "318568f61951ab9da21100c7b896e3c1da67f0d2efad6421545e022cfaa2b2b4",
        "Comfy-Org/Qwen-Image-Edit_ComfyUI",
        "f68ace85e60b4a02a323e394253731947657b7d2",
        "split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        "UNETLoader",
        "unet_name",
    ),
    Model(
        "encoder",
        "text_encoders",
        "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        9384670680,
        "cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4",
        "Comfy-Org/Qwen-Image_ComfyUI",
        "1f12b17be14c89b026c51a91d67c32f84bb047bc",
        "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "CLIPLoader",
        "clip_name",
    ),
    Model(
        "vae",
        "vae",
        "qwen_image_vae.safetensors",
        253806246,
        "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
        "Comfy-Org/Qwen-Image_ComfyUI",
        "1f12b17be14c89b026c51a91d67c32f84bb047bc",
        "split_files/vae/qwen_image_vae.safetensors",
        "VAELoader",
        "vae_name",
    ),
    Model(
        "lightning",
        "loras",
        "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
        849608296,
        "2a32ce938ec71db2b49a817b4844ae86995569518dea56ee0ddc209cbe8e1377",
        "lightx2v/Qwen-Image-Lightning",
        "e74da8d4e71a54b341de86aa9f8d2509165aa513",
        "Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
        "LoraLoaderModelOnly",
        "lora_name",
    ),
    Model(
        "relight",
        "loras",
        "Qwen-Image-Edit-2509-Relight.safetensors",
        236117032,
        "2a11c2b74ce0965abf35a8c8db52305072e970a689ca904b5a5b5a94d0aab86c",
        "Comfy-Org/Qwen-Image-Edit_ComfyUI",
        "f68ace85e60b4a02a323e394253731947657b7d2",
        "split_files/loras/Qwen-Image-Edit-2509-Relight.safetensors",
        "LoraLoaderModelOnly",
        "lora_name",
    ),
)
