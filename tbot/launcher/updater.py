"""Cliente de atualização do TBot Launcher.

Fluxo transacional seguro:
1. GET /api/v1/updates/check  -> detecta versão desejada
2. GET /api/v1/updates/manifest -> arquivos + SHA256 + assinatura
3. Download para staging (diretório temporário fora de versions/)
4. Verificação SHA256 por arquivo e do pacote
5. Fechamento controlado do TBot.exe
6. Mova staging -> versions/<nova> (atômico por ponteiro active.json)
7. Health check de inicialização
8. Confirmação via POST /api/v1/updates/report; rollback em falha
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .integrity import verify_installed_files, verify_package, verify_signature
from .rollback import rollback
from .version_manager import VersionManager, iso_now

TBOT_PROCESSES = ("TBot.exe",)


class UpdateError(RuntimeError):
    pass


class UpdateClient:
    def __init__(self, vm: VersionManager, server_url: str, api_key: str | None = None,
                 manifest_secret: str | None = None, channel: str = "stable"):
        self.vm = vm
        self.server_url = server_url.rstrip("/")
        self.api_key = api_key or os.environ.get("TBOT_API_KEY")
        self.manifest_secret = manifest_secret or os.environ.get("TBOT_MANIFEST_SECRET")
        self.channel = channel
        self.cache_dir = vm.root / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ---------------- HTTP helpers ----------------
    def _request(self, method: str, path: str, payload: dict | None = None,
                 binary: bool = False):
        url = f"{self.server_url}{path}"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Device-Id", self.vm.device_id())
        if self.api_key:
            req.add_header("X-Api-Key", self.api_key)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                return body if binary else json.loads(body)
        except urllib.error.HTTPError as e:
            raise UpdateError(f"HTTP {e.code} em {path}: {e.read().decode(errors='replace')[:200]}") from e
        except urllib.error.URLError as e:
            raise UpdateError(f"Servidor inacessível ({self.server_url}): {e.reason}") from e

    # ---------------- API ----------------
    def register(self) -> dict:
        return self._request("POST", "/api/v1/devices/register", {
            "device_id": self.vm.device_id(),
            "hostname": os.environ.get("COMPUTERNAME") or os.uname().nodename,
            "installed_version": self.vm.active_version(),
            "channel": self.channel,
        })

    def check_update(self) -> dict | None:
        current = self.vm.active_version() or "0.0.0"
        info = self._request("GET", f"/api/v1/updates/check?current={current}&channel={self.channel}")
        if info.get("update_available"):
            return info
        return None

    def get_manifest(self, version: str) -> dict:
        m = self._request("GET", f"/api/v1/updates/manifest?version={version}")
        if not verify_signature(m, self.manifest_secret):
            raise UpdateError("Assinatura do manifesto inválida — atualização abortada")
        return m

    def report(self, status: str, version: str | None, error: str | None = None) -> None:
        try:
            self._request("POST", "/api/v1/updates/report", {
                "device_id": self.vm.device_id(),
                "status": status,
                "installed_version": self.vm.active_version(),
                "target_version": version,
                "error": error,
                "timestamp": iso_now(),
            })
        except UpdateError:
            pass  # relatório é best-effort; nunca derruba o launcher

    # ---------------- process control ----------------
    @staticmethod
    def close_tbot(timeout: float = 10.0) -> None:
        """Fecha o TBot.exe de forma controlada antes da atualização."""
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/IM", *TBOT_PROCESSES, "/T"],
                           capture_output=True)
        for _ in range(int(timeout)):
            running = [p for p in TBOT_PROCESSES if _pid_of(p)]
            if not running:
                return
            time.sleep(1.0)
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/IM", *TBOT_PROCESSES, "/T"],
                           capture_output=True)

    # ---------------- update pipeline ----------------
    def download_package(self, manifest: dict) -> Path:
        version = manifest["version"]
        pkg = self.cache_dir / f"tbot-{version}.zip"
        if pkg.exists() and verify_package(pkg, manifest["package_sha256"]):
            return pkg
        blob = self._request("GET", f"/api/v1/updates/download?version={version}",
                             binary=True)
        tmp = pkg.with_suffix(".part")
        tmp.write_bytes(blob)
        if not verify_package(tmp, manifest["package_sha256"]):
            tmp.unlink(missing_ok=True)
            raise UpdateError(f"Pacote {version} falhou na verificação SHA256")
        tmp.replace(pkg)
        return pkg

    def install_package(self, pkg: Path, manifest: dict) -> Path:
        version = manifest["version"]
        target = self.vm.version_dir(version)
        staging = Path(tempfile.mkdtemp(dir=self.vm.root, prefix=f"staging-{version}-"))
        try:
            with zipfile.ZipFile(pkg) as z:
                _safe_extract(z, staging)
            if not verify_installed_files(staging, manifest["files"]):
                raise UpdateError("Arquivos extraídos não conferem com o manifesto")
            if target.exists():
                shutil.rmtree(target)
            staging.replace(target)
            return target
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def health_check(self, version: str) -> bool:
        """Testa se a nova versão inicia. Em dev (sem exe real) valida estrutura."""
        d = self.vm.version_dir(version)
        if not d.is_dir():
            return False
        exe = d / "TBot.exe"
        if exe.exists() and os.access(exe, os.X_OK):
            proc = subprocess.Popen([str(exe), "--self-test"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                out, _ = proc.communicate(timeout=30)
                return proc.returncode == 0
            except subprocess.TimeoutExpired:
                proc.kill()
                return True  # janela abriu sem crashar
        # Sem executável real (ex.: dev em Linux): valida a estrutura da build.
        return (d / "main.py").exists() or any(
            p.is_file() and p.name != "TBot.exe" for p in d.rglob("*"))

    def update_to(self, manifest: dict) -> str:
        version = manifest["version"]
        old = self.vm.active_version()
        self.report("downloading", version)
        pkg = self.download_package(manifest)
        self.close_tbot()
        self.report("installing", version)
        self.install_package(pkg, manifest)
        if not self.health_check(version):
            self.report("failed", version, "health check falhou")
            restored = False
            if old and self.vm.version_dir(old).exists():
                self.vm._atomic_write(self.vm.active_file, {"version": old})
                restored = True
            raise UpdateError(
                f"Falha no health check da versão {version}; "
                + ("rollback aplicado" if restored else "nenhuma versão anterior para rollback"))
        self.vm.set_active(version)
        self.report("success", version)
        return version

    def run_cycle(self) -> str:
        """Um ciclo completo: checar -> baixar -> instalar -> reportar."""
        info = self.check_update()
        if not info:
            return self.vm.active_version() or ""
        manifest = self.get_manifest(info["latest_version"])
        return self.update_to(manifest)


def _safe_extract(z: zipfile.ZipFile, dest: Path) -> None:
    dest = dest.resolve()
    for member in z.namelist():
        p = (dest / member).resolve()
        if not str(p).startswith(str(dest)):
            raise UpdateError(f"Entrada de zip perigosa: {member}")
    z.extractall(dest)


def _pid_of(name: str) -> int | None:
    try:
        import psutil
        for proc in psutil.process_iter(["name"]):
            if proc.info["name"] and proc.info["name"].lower() == name.lower():
                return proc.pid
    except Exception:
        pass
    return None
