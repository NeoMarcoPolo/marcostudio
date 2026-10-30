# Optional disk-space pairing

The storage helper is opt-in and currently supports POSIX ComfyUI installations
that the owner starts from a terminal. Windows and ComfyUI Desktop launch flows
are not yet verified. It reports space on the model destination, not a download
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
```

After starting ComfyUI, find `MarcoStudio storage pairing credential target:`
in its log. In a separate owner terminal in the same Windows logon session, run
`<comfy-python> custom_nodes/marcostudio/storage_pairing_windows.py <credential-target>`.
The target is not the secret; the command prints the secret, which may remain
in terminal scrollback. Restarting ComfyUI rotates and removes the old session
credential. Do not paste the code anywhere except MarcoStudio's pairing field.
