from dataclasses import dataclass


@dataclass(frozen=True)
class Model:
    key: str
    category: str
    filename: str
    size: int
    sha256: str
    repository: str
    revision: str
    path: str
    loader: str
    field: str

    @property
    def url(self):
        return f"https://huggingface.co/{self.repository}/resolve/{self.revision}/{self.path}"
