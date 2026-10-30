"""Offline comparison of trusted model resolution with installed node choices."""

import logging

from .integrity_catalog import LOADERS, MODELS
from .integrity_resolution import Resolved, resolve


def resolve_loader_choice(identity, folder_paths, node_mapping):
    """Fail closed unless the node and folder resolver select the same choice.

    This reproduces browser selection rules against the installed node's
    INPUT_TYPES definition. It cannot prove a modified node actually uses the
    advertised choice, or prevent file changes after this observation.
    """
    try:
        loader, field = LOADERS[identity]
        filename = MODELS[identity][0]
        inputs = node_mapping[loader].INPUT_TYPES()
        required = inputs.get("required", {})
        optional = inputs.get("optional", {})
        spec = required.get(field) or optional.get(field)
        if not isinstance(spec, (list, tuple)) or not spec:
            return Resolved("unavailable")
        options = spec[0] if isinstance(spec[0], (list, tuple)) else (spec[1].get("options") if len(spec) > 1 and isinstance(spec[1], dict) else None)
        if not isinstance(options, (list, tuple)):
            return Resolved("unavailable")
        matches = [name for name in options if isinstance(name, str) and name.replace("\\", "/").split("/")[-1] == filename]
        choice = filename if filename in matches else matches[0] if len(matches) == 1 else None
        if choice is None:
            return Resolved("ambiguous" if len(matches) > 1 else "missing")
        resolved = resolve(identity, folder_paths)
        if resolved.status != "resolved":
            return resolved
        return resolved if resolved.choice == choice else Resolved("changed")
    except (KeyError, AttributeError, TypeError, ValueError):
        return Resolved("unavailable")
    except Exception:
        logging.warning("MarcoStudio loader choice verification failed")
        return Resolved("unavailable")
