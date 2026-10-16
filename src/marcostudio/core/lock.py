"""One worker per data directory, released automatically when the process exits."""

import os


class RuntimeLock:
    def __init__(self, directory):
        self.path = directory / "worker.lock"
        self.stream = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        if not self.path.stat().st_size:
            self.stream.write(b"0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            raise RuntimeError("MarcoStudio is already running with this data directory") from exc
        return self

    def __exit__(self, *args):
        if self.stream:
            self.stream.close()
