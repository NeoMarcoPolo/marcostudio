# Optional disk-space pairing

The storage helper is opt-in and supports POSIX ComfyUI installations
that the owner starts from a terminal. Windows storage is experimental and
requires an additional opt-in. ComfyUI Desktop launch flows are not yet verified. It reports space on the model destination, not a download
guarantee. Installing the node alone does not enable the endpoint.

1. From the ComfyUI directory, restart ComfyUI with
   `MARCOSTUDIO_ENABLE_STORAGE_PAIRING=1` in its environment. Keep your usual
   launch arguments. Allow the exact MarcoStudio website origin using ComfyUI's
   CORS setting, if required by your browser. For the public website that origin
   is `https://neomarcopolo.co`.
2. Find the `MarcoStudio storage pairing socket:` line in the ComfyUI log. The
   socket path is not the pairing secret.
3. In a separate owner terminal run `<comfy-python> custom_nodes/marcostudio/storage_pairing.py <socket-path>`,
   substituting the Python used by ComfyUI and the socket path from the log.
   The command prints the secret in your terminal; terminal scrollback can
   retain it. Paste the secret into MarcoStudio, and do not share it.
4. Restarting ComfyUI rotates the secret. MarcoStudio keeps it only in the open
   browser session. An unavailable check means the helper, browser permission,
   destination, or platform could not be verified; check free space manually.

Loopback HTTP and direct HTTPS are supported by the helper. The browser may
require local-network permission. Never send the secret to a remote plain HTTP
address. Pairing protects only the MarcoStudio storage helper, not other
ComfyUI endpoints.

## Model checksum checks

The helper can hash model files only after an explicit request from a paired
client. A match says the checksum matched during the recorded check; it does
not guarantee that the file stayed unchanged during or after the check. The
helper discards observations after restart, and discards them when it observes
Manager queue activity or a file identity change. Other programs or weak
filesystem metadata can hide changes. Check again after an interrupted or
external download, and do not treat an older match as proof of current bytes.
Windows checksum checks are experimental, require the additional explicit
`MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM=1` opt-in, and are limited to NTFS
on a fixed-type drive. Windows Desktop and portable launch flows remain unverified.

## Experimental Windows terminal launch

Windows pairing is off by default. Its disk and credential APIs have automated
Windows runner coverage, but the ComfyUI Desktop and portable launch flows are
not yet verified. Only opt in if you control the ComfyUI process and can run a
terminal in the same Windows user logon session. If pairing or the model's
destination cannot be checked, use the manual free-space check instead.

In the PowerShell session used to start ComfyUI, set both environment variables
before your usual launch command:

```powershell
$env:MARCOSTUDIO_ENABLE_STORAGE_PAIRING = "1"
$env:MARCOSTUDIO_EXPERIMENTAL_WINDOWS_STORAGE = "1"
# Optional: enable experimental model checksum checks as well.
$env:MARCOSTUDIO_EXPERIMENTAL_WINDOWS_CHECKSUM = "1"
```

After starting ComfyUI, find `MarcoStudio storage pairing credential target:`
in its log. In a separate owner terminal in the same Windows logon session, run
`<comfy-python> custom_nodes/marcostudio/storage_pairing_windows.py <credential-target>`.
The target is not the secret; the command prints the secret, which may remain
in terminal scrollback. Restarting ComfyUI rotates and removes the old session
credential. Do not paste the code anywhere except MarcoStudio's pairing field.

If checksum checking is unavailable, MarcoStudio offers an explicit per-session
choice to continue with model files marked **unverified**. This is not a
checksum result. Known checksum failures, model changes, active checks, and
active or unknown Manager queue states continue to block task submission.
The confirmation applies only to the selected ComfyUI connection and the
specific models acknowledged, and does not survive reloading the page.
