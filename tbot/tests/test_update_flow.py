"""Testes de integração do ciclo de atualização do TBot.

Sobem o TBot Update Server REAL (http.server em porta efêmera) e exercitam
o launcher com HTTP real — sem mocks:
  - registro de dispositivo
  - detecção de update
  - download + verificação SHA256
  - instalação transacional + preservação de dados
  - rollback quando o health check falha
Executar: python tbot/tests/test_update_flow.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tbot.update_server.api import main as srv  # noqa: E402
from tbot.launcher.version_manager import VersionManager  # noqa: E402
from tbot.launcher.updater import UpdateClient, UpdateError  # noqa: E402
from tbot.launcher.rollback import rollback, RollbackError  # noqa: E402


def make_package(tmp: Path, version: str, extra_note: str = "ok") -> dict:
    """Cria um diretório de 'build' e zipa no formato esperado pelo servidor."""
    dist = tmp / f"dist-{version}"
    dist.mkdir(parents=True, exist_ok=True)
    (dist / "TBot.exe").write_bytes(f"BINARY-{version}".encode())
    (dist / "_internal").mkdir(exist_ok=True)
    (dist / "_internal" / "base_library.zip").write_text(extra_note)
    pkg = tmp / f"tbot-{version}.zip"
    with zipfile.ZipFile(pkg, "w") as z:
        for p in dist.rglob("*"):
            if p.is_file():
                z.write(p, p.relative_to(dist))
    files = [{"path": str(p.relative_to(dist)).replace("\\", "/"),
              "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
             for p in sorted(dist.rglob("*")) if p.is_file()]
    manifest = {"product": "TBot", "version": version, "channel": "stable",
                "files": files, "package_sha256": hashlib.sha256(pkg.read_bytes()).hexdigest()}
    return manifest


class UpdateFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srvhome = tempfile.mkdtemp(prefix="tbot-srv-")
        os.environ["TBOT_SERVER_HOME"] = cls.srvhome
        # recarrega caminhos do módulo do servidor
        srv.ROOT = Path(cls.srvhome)
        srv.RELEASES = srv.ROOT / "releases"
        srv.DB_FILE = srv.ROOT / "db.json"
        srv.RELEASES.mkdir(parents=True, exist_ok=True)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        shutil.rmtree(cls.srvhome, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tbot-cli-"))
        self.pkgdir = Path(tempfile.mkdtemp(prefix="tbot-pkg-"))
        self.vm = VersionManager(self.tmp)
        self.client = UpdateClient(self.vm, self.url)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.pkgdir, ignore_errors=True)

    def publish_and_deploy(self, version: str, manifest: dict):
        rel = srv.RELEASES / version
        rel.mkdir(parents=True, exist_ok=True)
        (rel / "manifest.json").write_text(json.dumps(manifest))
        shutil.copy(self.pkgdir / f"tbot-{version}.zip", rel / f"tbot-{version}.zip")
        db = srv.load_db()
        db["desired_version"]["stable"] = version
        srv.save_db(db)

    def test_full_cycle_update_and_data_preserved(self):
        m1 = make_package(self.pkgdir, "1.0.0")
        self.publish_and_deploy("1.0.0", m1)
        self.client.register()
        v = self.client.run_cycle()
        self.assertEqual(v, "1.0.0")
        self.assertEqual(self.vm.active_version(), "1.0.0")
        # dados persistentes sobrevivem
        (self.vm.data_dir / "profiles.json").write_text('{"keep": true}')
        # publica 1.1.0 e atualiza
        m2 = make_package(self.pkgdir, "1.1.0", "updated")
        self.publish_and_deploy("1.1.0", m2)
        info = self.client.check_update()
        self.assertTrue(info["update_available"])
        manifest = self.client.get_manifest("1.1.0")
        newv = self.client.update_to(manifest)
        self.assertEqual(newv, "1.1.0")
        self.assertEqual(self.vm.active_version(), "1.1.0")
        self.assertEqual(self.vm.previous_version(), "1.0.0")
        self.assertEqual(json.loads((self.vm.data_dir / "profiles.json").read_text())["keep"], True)
        # rollback funcional
        back = rollback(self.vm)
        self.assertEqual(back, "1.0.0")
        self.assertEqual(self.vm.active_version(), "1.0.0")

    def test_sha256_mismatch_rejected(self):
        m = make_package(self.pkgdir, "2.0.0")
        rel = srv.RELEASES / "2.0.0"
        rel.mkdir(parents=True, exist_ok=True)
        (rel / "manifest.json").write_text(json.dumps(m))
        (rel / "tbot-2.0.0.zip").write_bytes(b"CORRUPTED-DATA")
        with self.assertRaises(UpdateError):
            self.client.download_package(m)

    def test_rollback_on_failed_healthcheck(self):
        m1 = make_package(self.pkgdir, "3.0.0")
        self.publish_and_deploy("3.0.0", m1)
        self.client.update_to(self.client.get_manifest("3.0.0"))
        # versão quebrada: exe que retorna código != 0
        bad = self.pkgdir / "dist-BAD"
        bad.mkdir(exist_ok=True)
        fake_exe = bad / "TBot.exe"
        fake_exe.write_text("#!/bin/sh\nexit 1\n")
        os.chmod(fake_exe, 0o755)
        pkg = self.pkgdir / "tbot-4.0.0.zip"
        with zipfile.ZipFile(pkg, "w") as z:
            z.write(fake_exe, "TBot.exe")
        mbad = {"product": "TBot", "version": "4.0.0", "channel": "stable",
                "files": [{"path": "TBot.exe",
                           "sha256": hashlib.sha256(fake_exe.read_bytes()).hexdigest()}],
                "package_sha256": hashlib.sha256(pkg.read_bytes()).hexdigest()}
        rel = srv.RELEASES / "4.0.0"
        rel.mkdir(parents=True, exist_ok=True)
        (rel / "manifest.json").write_text(json.dumps(mbad))
        shutil.copy(pkg, rel / "tbot-4.0.0.zip")
        with self.assertRaises(UpdateError):
            self.client.update_to(mbad)
        self.assertEqual(self.vm.active_version(), "3.0.0")  # rollback aplicado

    def test_no_update_when_current(self):
        m = make_package(self.pkgdir, "5.0.0")
        self.publish_and_deploy("5.0.0", m)
        self.client.update_to(self.client.get_manifest("5.0.0"))
        self.assertIsNone(self.client.check_update())

    def test_atomic_pointers_and_compare(self):
        self.assertEqual(VersionManager.compare("1.10.0", "1.9.9"), 1)
        self.assertEqual(VersionManager.compare("1.0.0", "1.0.0"), 0)
        with self.assertRaises(RollbackError):
            rollback(VersionManager(self.pkgdir / "empty"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
