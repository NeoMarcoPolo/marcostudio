"""Compile native H3 joint video/audio graphs from pinned public templates."""

from .manifest import for_tool


def compile_workflow(tool, settings, source, prefix, models, *, inputs=None):
    inputs = inputs or {}
    manifest = for_tool(tool)
    if settings.mode not in manifest.MODEL_SETS:
        raise ValueError(f"{tool} does not support {settings.mode} mode")
    if tool != "create-video" and source is None:
        raise ValueError("A source asset is required")
    if tool == "transition" and inputs.get("last_frame") is None:
        raise ValueError("A last frame image is required")
    if tool == "keyframes":
        settings.validate_inputs(inputs)
    names = {m.key: models.get(m.key, m.filename) for m in manifest.MODEL_SETS[settings.mode]}
    graph = {}

    def node(key, kind, **values):
        graph[key] = {"class_type": kind, "inputs": values}
        return [key, 0]

    model = node("1", "UNETLoader", unet_name=names["h3_diffusion"], weight_dtype="default")
    clip = node("2", "CLIPLoader", clip_name=names["h3_encoder"], type="minimax", device="default")
    vae = node("3", "VAELoader", vae_name=names["h3_vae"])
    audio_vae = node("4", "VAELoader", vae_name=names["h3_audio_vae"])
    reference = tool in ("restyle-video", "keyframes")
    masked = tool == "motion-control" and inputs.get("mask") is not None
    flash = settings.mode == "flash"
    if flash:
        model = node(
            "40",
            "MiniMaxH3SigmaShift",
            model=model,
            shift_video=12.0 if reference else 10.0,
            shift_audio=3.0,
        )
        # Both official FastH3 templates use the trained VSA pattern, including dense audio rows.
        model = node("41", "ModelAttentionBackend", model=model, attention="pytorch attention")
        model = node(
            "42",
            "BlockSparseAttention",
            **{
                "model": model,
                "selection": "vsa",
                "selection.keep_percent": 10.0,
                "start_percent": 0.0 if reference else 0.2,
                "end_percent": 1.0,
                "dense_blocks": "",
                "min_tokens": 12288,
                "extra_tokens": 256,
                "sink_conditioning": "exact_kv_and_rows",
                "verbose": False,
            },
        )

    condition = dict(
        clip=clip,
        vae=vae,
        prompt=settings.prompt(),
        width=settings.width,
        height=settings.height,
        length=settings.frames,
    )
    frames = None
    if tool in ("animate-image", "transition"):
        condition["first_frame"] = node("20", "LoadImage", image=source)
        if tool == "transition":
            condition["last_frame"] = node("21", "LoadImage", image=inputs["last_frame"])
    if tool in ("restyle-video", "motion-control"):
        video = node("20", "LoadVideo", file=source)
        video = node(
            "21",
            "Video Slice",
            video=video,
            start_time=0.0,
            duration=settings.actual_duration,
            strict_duration=False,
        )
        node("22", "GetVideoComponents", video=video)
        frames = node(
            "24",
            "MarcoStudioH3Window",
            images=["22", 0],
            audio=["22", 1],
            source_fps=["22", 2],
            width=settings.width,
            height=settings.height,
            frames=settings.frames,
        )
        if tool == "restyle-video":
            condition["ref_videos.ref_video_0"] = frames
            condition["ref_video_audios.ref_video_audio_0"] = ["24", 2]
            for i, key in enumerate(("reference_1", "reference_2")):
                if inputs.get(key) is not None:
                    image = node(str(25 + i), "LoadImage", image=inputs[key])
                    condition[f"ref_images.ref_image_{i}"] = image
    if tool == "keyframes":
        image = node("20", "LoadImage", image=source)
        condition["ref_images.ref_image_0"] = image
    if reference:
        condition.update(audio_vae=audio_vae, ref_image_size="match")
    positive = node(
        "5", "MiniMaxH3ReferenceToVideo" if reference else "MiniMaxH3ImageToVideo", **condition
    )
    latent = ["5", 1]
    if tool == "keyframes":
        positive = node(
            "30",
            "MiniMaxH3AddGuide",
            positive=positive,
            latent=latent,
            vae=vae,
            image=["20", 0],
            frame_idx=0,
        )
        for i, frame in enumerate(settings.guide_frames):
            image = node(str(31 + i * 2), "LoadImage", image=inputs[f"guide_{i + 1}"])
            positive = node(
                str(32 + i * 2),
                "MiniMaxH3AddGuide",
                positive=positive,
                latent=latent,
                vae=vae,
                image=image,
                frame_idx=frame,
            )
    if tool == "motion-control":
        if masked:
            # White RGB marks pixels to regenerate. Match the source's cover-crop geometry.
            mask = node("27", "LoadImage", image=inputs["mask"])
            mask = node(
                "28",
                "ImageScale",
                image=mask,
                upscale_method="nearest-exact",
                width=settings.width,
                height=settings.height,
                crop="center",
            )
            mask = node("29", "ImageToMask", image=mask, channel="red")
            latent = node(
                "33", "MarcoStudioH3InpaintLatent", images=frames,
                mask=mask, vae=vae, audio_vae=audio_vae, audio=["24", 2],
            )
        else:
            patch = node("26", "ModelPatchLoader", name=names["h3_control"])
            control = frames
            if settings.control_type == "canny":
                control = node("25", "Canny", image=frames, low_threshold=0.4, high_threshold=0.8)
            model = node(
                "30", "MiniMaxH3FunControlNetApply", model=model, model_patch=patch,
                vae=vae, control_video=control, strength=settings.strength,
                start_percent=0.0, end_percent=1.0,
            )

    noise = node("6", "RandomNoise", noise_seed=settings.seed)
    guider = node("7", "BasicGuider", model=model, conditioning=positive)
    sampler = node(
        "8", "KSamplerSelect", sampler_name="euler" if flash and reference else "res_multistep"
    )
    sigmas = node(
        "9",
        "BasicScheduler",
        model=model,
        scheduler="simple",
        steps=8 if flash else 20,
        denoise=1.0,
    )
    samples = node(
        "10",
        "SamplerCustomAdvanced",
        noise=noise,
        guider=guider,
        sampler=sampler,
        sigmas=sigmas,
        latent_image=latent,
    )
    images = node("11", "VAEDecode", samples=samples, vae=vae)
    if masked:
        images = node(
            "34", "MarcoStudioH3Window", images=images, width=settings.width,
            height=settings.height, frames=settings.frames,
        )
        images = node(
            "35", "ImageCompositeMasked", destination=frames, source=images,
            mask=["29", 0], x=0, y=0, resize_source=False,
        )
        audio = ["24", 2]
    else:
        audio = node("13", "VAEDecodeAudio", samples=samples, vae=audio_vae)
    video = node(
        "14",
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
        **{
            "video": video,
            "filename_prefix": prefix,
            "format": "mp4",
            "format.codec": "h264",
            "format.codec.encoding": "auto",
        },
    )
    return graph
