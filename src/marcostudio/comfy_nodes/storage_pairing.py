"""Owner-local pairing prototype; not registered as a ComfyUI route.

A Unix-domain socket permits a local owner CLI to retrieve a random token
without writing the token to disk or the server's HTTP-accessible logs.
This primitive is opt-in and unsupported on Windows.
"""

import hmac
import os
import secrets
import socket
import stat
import tempfile
import threading
from pathlib import Path


class OwnerPairing:
    def __init__(self):
        if os.name != "posix" or not hasattr(socket, "AF_UNIX"):
            raise RuntimeError("Owner-local pairing is unavailable on this platform")
        self._token = secrets.token_urlsafe(32)
        self._directory = Path(tempfile.mkdtemp(prefix="ms-pair-", dir="/tmp"))
        self.path = self._directory / "owner.sock"
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._socket.bind(str(self.path))
            os.chmod(self.path, 0o600)
            self._socket.listen(2)
            self._socket.settimeout(0.2)
        except BaseException:
            self._socket.close()
            self.path.unlink(missing_ok=True)
            self._directory.rmdir()
            raise
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while not self._closed.is_set():
            try:
                connection, _ = self._socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                try:
                    connection.sendall(self._token.encode("ascii"))
                except OSError:
                    pass

    def accepts(self, token):
        return not self._closed.is_set() and isinstance(token, str) and token.isascii() and hmac.compare_digest(token, self._token)

    def volume(self, device):
        return hmac.new(self._token.encode("ascii"), str(device).encode("ascii"), "sha256").hexdigest()[:24]

    def close(self):
        if self._closed.is_set():
            return
        self._closed.set()
        self._socket.close()
        self._thread.join(timeout=1)
        self.path.unlink(missing_ok=True)
        self._directory.rmdir()


def read_owner_token(path):
    """Read a token via the local socket. Call only from an owner-run CLI."""
    path = Path(path)
    directory = path.parent.lstat()
    before = path.lstat()
    if (not path.is_absolute() or path.name != "owner.sock" or
            not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or
            stat.S_IMODE(directory.st_mode) != 0o700 or not stat.S_ISSOCK(before.st_mode) or
            before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o600):
        raise ValueError("Invalid owner pairing socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(str(path))
        after = path.lstat()
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError("Owner pairing socket changed")
        chunks = []
        received = 0
        while received < 43:
            chunk = client.recv(43 - received)
            if not chunk:
                break
            chunks.append(chunk)
            received += len(chunk)
        token = b"".join(chunks).decode("ascii")
        if len(token) != 43 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in token):
            raise ValueError("Invalid pairing response")
        return token


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("Usage: python storage_pairing.py /path/to/owner.sock")
    print(read_owner_token(sys.argv[1]))
