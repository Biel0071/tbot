"""Gerenciamento de versões e layout de instalação do TBot.

Layout no disco (ex.: C:\\Program Files\\TBot):

    launcher/            <- TBot Launcher (bootstrapper estável)
    versions/
        1.0.0/           <- instalação completa imutável (TBot.exe, _internal)
        1.1.0/
    active.json          <- aponta a versão ativa (troca atômica)
    previous.json        <- versão anterior para rollback
    data/                <- dados persistentes (NUNCA sobrescritos por update)
        config/profiles.json
        recordings/
        memory/
        logs/

Dados do usuário ficam fora das versões binárias para sobreviver a
updates, reparos e reinstalações.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from pathlib import Path


def default_install_root() -> Path:
    """Diretório raiz da instalação do TBot."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent
    env = os.environ.get("TBOT_ROOT")
    if env:
        return Path(env)
    return Path.home() / "TBot"


class VersionManager:
    def __init__(self, root: Path | str | None = None):
        self.root = Path(root) if root else default_install_root()
        self.versions_dir = self.root / "versions"
        self.data_dir = self.root / "data"
        self.active_file = self.root / "active.json"
        self.previous_file = self.root / "previous.json"
        self.device_file = self.root / "device.json"
        for d in (self.versions_dir, self.data_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ---------------- version pointers ----------------
    @staticmethod
    def parse_version(v: str) -> tuple[int, ...]:
        return tuple(int(x) for x in v.split("."))

    @staticmethod
    def compare(a: str, b: str) -> int:
        pa, pb = VersionManager.parse_version(a), VersionManager.parse_version(b)
        delta = len(pa) - len(pb)
        if delta > 0:
            pb = pb + (0,) * delta
        elif delta < 0:
            pa = pa + (0,) * (-delta)
        return (pa > pb) - (pa < pb)

    def _read_pointer(self, path: Path) -> str | None:
        try:
            return json.loads(path.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            return None

    def _atomic_write(self, path: Path, payload: dict) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(self.root), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    def installed_versions(self) -> list[str]:
        out = []
        if self.versions_dir.is_dir():
            for p in self.versions_dir.iterdir():
                if p.is_dir() and (p / "TBot.exe").exists() or (p / "main.py").exists():
                    out.append(p.name)
        return sorted(out, key=self.parse_version)

    def active_version(self) -> str | None:
        return self._read_pointer(self.active_file)

    def previous_version(self) -> str | None:
        return self._read_pointer(self.previous_file)

    def set_active(self, version: str, keep_previous: bool = True) -> None:
        current = self.active_version()
        if current and keep_previous and current != version:
            self._atomic_write(self.previous_file, {"version": current})
        self._atomic_write(self.active_file, {"version": version})

    def version_dir(self, version: str) -> Path:
        return self.versions_dir / version

    def executable_path(self, version: str | None = None) -> Path:
        v = version or self.active_version()
        if not v:
            raise FileNotFoundError("Nenhuma versão ativa do TBot encontrada")
        return self.version_dir(v) / "TBot.exe"

    # ---------------- device identity ----------------
    def device_id(self) -> str:
        try:
            return json.loads(self.device_file.read_text(encoding="utf-8"))["device_id"]
        except (OSError, KeyError, ValueError):
            did = uuid.uuid4().hex
            self.device_file.write_text(
                json.dumps({"device_id": did, "created": iso_now()}), encoding="utf-8"
            )
            return did


def iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
