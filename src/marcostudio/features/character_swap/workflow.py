"""Single-window adaptation of Akatz's native unmasked Character Swap recipe."""

from . import manifest


def compile_workflow(settings, source, prefix, models, *, inputs=None):
    inputs = inputs or {}
    if settings.mode != "standard":
        raise ValueError("Replace Person supports standard mode only")
    if source is None:
        raise ValueError("A source performance is required")
    if inputs.get("reference_1") is None:
        raise ValueError("A character reference is required")
    names = {model.key: models.get(model.key, model.filename) for model in manifest.MODELS}
    graph = {}

    def node(key, kind, **values):
        graph[key] = {"class_type": kind, "inputs": values}
        return [key, 0]

    model = node("model", "UNETLoader", unet_name=names["h3_diffusion"], weight_dtype="default")
    model = node("shift", "MiniMaxH3SigmaShift", model=model, shift_video=12.0, shift_audio=3.0)
    model = node(
        "attention", "ModelAttentionBackend", model=model, attention="pytorch attention"
    )
    model = node(
        "turbo",
        "LoraLoaderModelOnly",
        model=model,
        lora_name=names["h3_turbo_8step"],
        strength_model=1.0,
    )
    model = node(
        "character",
        "LoraLoaderModelOnly",
        model=model,
        lora_name=names["h3_character_swap"],
        strength_model=1.0,
    )
    clip = node(
        "text",
        "CLIPLoader",
        clip_name=names["h3_character_encoder"],
        type="minimax",
        device="default",
    )
    vae = node("video_vae", "VAELoader", vae_name=names["h3_vae"])
    audio_vae = node("audio_vae", "VAELoader", vae_name=names["h3_audio_vae"])

    video = node("source", "LoadVideo", file=source)
    video = node(
        "slice",
        "Video Slice",
        video=video,
        start_time=0.0,
        duration=float(settings.duration),
        strict_duration=False,
    )
    node("components", "GetVideoComponents", video=video)
    # A 120-frame performance must be padded to 124 before native reference encoding;
    # otherwise H3 silently crops it down to 107. Keep the original count for export.
    frames = node(
        "window",
        "MarcoStudioH3Window",
        images=["components", 0],
        audio=["components", 1],
        source_fps=["components", 2],
        width=settings.width,
        height=settings.height,
        frames=settings.frames,
    )
    reference = node("reference", "LoadImage", image=inputs["reference_1"])
    positive = node(
        "conditioning",
        "MiniMaxH3ReferenceToVideo",
        clip=clip,
        vae=vae,
        audio_vae=audio_vae,
        prompt=settings.prompt(),
        width=settings.width,
        height=settings.height,
        length=settings.frames,
        ref_image_size="match",
        **{
            "ref_images.ref_image_0": reference,
            "ref_videos.ref_video_0": frames,
            "ref_audios.ref_audio_0": ["window", 2],
        },
    )
    latent = ["conditioning", 1]
    # The source performance is a reference, not a target-image anchor that would
    # force the original person's appearance back into the replacement.
    positive = node(
        "audio_guide",
        "MiniMaxH3AddGuide",
        positive=positive,
        latent=latent,
        frame_idx=0,
        audio_vae=audio_vae,
        audio=["window", 2],
    )
    noise = node("noise", "RandomNoise", noise_seed=settings.seed)
    guider = node("guider", "CFGGuider", model=model, positive=positive, negative=positive, cfg=1.0)
    sampler = node("sampler", "KSamplerSelect", sampler_name="er_sde")
    sigmas = node(
        "schedule", "BasicScheduler", model=model, scheduler="normal", steps=8, denoise=1.0
    )
    samples = node(
        "sample",
        "SamplerCustomAdvanced",
        noise=noise,
        guider=guider,
        sampler=sampler,
        sigmas=sigmas,
        latent_image=latent,
    )
    samples = node("separate", "LTXVSeparateAVLatent", av_latent=samples)
    images = node("decode", "VAEDecode", samples=samples, vae=vae)
    # Native H3 decoding can return F-1 frames. Restore that boundary hold before
    # removing model padding, as the upstream window assembler does.
    images = node(
        "decode_window",
        "MarcoStudioH3Window",
        images=images,
        width=settings.width,
        height=settings.height,
        frames=settings.frames,
    )
    images = node("trim", "ImageFromBatch", image=images, batch_index=0, length=["window", 1])
    duration = node(
        "duration", "ComfyMathExpression", expression="a / 24", **{"values.a": ["window", 1]}
    )
    audio = node(
        "source_audio", "TrimAudioDuration", audio=["window", 2], start_index=0.0, duration=duration
    )
    video = node(
        "video",
        "CreateVideo",
        images=images,
        audio=audio,
        fps=24.0,
        bit_depth=8,
        color_space="sRGB",
        codec="none",
    )
    node(
        "12",
        "SaveVideo",
        video=video,
        filename_prefix=prefix,
        format="mp4",
        **{
            "format.codec": "h264",
            "format.codec.encoding": "re-encode",
            "format.codec.encoding.crf": 16,
        },
    )
    return graph
