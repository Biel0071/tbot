"""TBot Launcher — ponto de entrada independente (TBot-Launcher.exe).

Uso:
    python -m tbot.launcher.main              # abre a GUI do launcher
    python -m tbot.launcher.main --auto       # atualiza silenciosamente e inicia
    python -m tbot.launcher.main --check      # apenas reporta se há update

Configuração via variáveis de ambiente:
    TBOT_SERVER_URL   (padrão: http://localhost:8300)
    TBOT_API_KEY      chave do dispositivo/admin
    TBOT_CHANNEL      stable | beta
    TBOT_ROOT         raiz de instalação (dev)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

if __package__ in (None, ""):  # execução direta do arquivo
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from tbot.launcher.version_manager import VersionManager
    from tbot.launcher.updater import UpdateClient, UpdateError
else:
    from .version_manager import VersionManager
    from .updater import UpdateClient, UpdateError


class LauncherController:
    def __init__(self):
        self.vm = VersionManager()
        server = os.environ.get("TBOT_SERVER_URL", "http://localhost:8300")
        channel = os.environ.get("TBOT_CHANNEL", "stable")
        self.client = UpdateClient(self.vm, server, channel=channel)
        self.latest_known: str | None = None

    # ------------- operações -------------
    def check(self) -> dict | None:
        info = self.client.check_update()
        if info:
            self.latest_known = info["latest_version"]
        return info

    def update_now(self) -> str:
        info = self.check()
        if not info:
            return self.vm.active_version() or ""
        manifest = self.client.get_manifest(info["latest_version"])
        return self.client.update_to(manifest)

    def repair(self) -> str:
        """Repara: reinstala a versão desejada (ou ativa) do zero."""
        info = self.client.check_update()
        version = (info or {}).get("latest_version") or self.vm.active_version()
        if not version:
            raise UpdateError("Nenhuma versão conhecida para reparar")
        manifest = self.client.get_manifest(version)
        return self.client.update_to(manifest)

    def do_rollback(self) -> str:
        from .rollback import rollback
        return rollback(self.vm)

    def launch_app(self) -> subprocess.Popen:
        """Inicia o TBot.exe da versão ativa; em dev usa main.py."""
        v = self.vm.active_version()
        if not v:
            raise FileNotFoundError("Nenhuma versão instalada. Use ATUALIZAR ou REPARAR.")
        exe = self.vm.version_dir(v) / "TBot.exe"
        env = dict(os.environ, TBOT_DATA_DIR=str(self.vm.data_dir),
                   TBOT_VERSION=v)
        if exe.exists():
            return subprocess.Popen([str(exe)], cwd=str(exe.parent), env=env)
        entry = self.vm.version_dir(v) / "main.py"
        if entry.exists():
            return subprocess.Popen([sys.executable, str(entry)], env=env)
        raise FileNotFoundError(f"Entrypoint não encontrado na versão {v}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="TBot-Launcher")
    parser.add_argument("--auto", action="store_true",
                        help="atualiza silenciosamente e inicia o TBot")
    parser.add_argument("--check", action="store_true",
                        help="apenas verifica se há atualização")
    args = parser.parse_args(argv)

    ctrl = LauncherController()
    try:
        ctrl.client.register()
    except UpdateError as e:
        print(f"[launcher] aviso: registro no servidor falhou: {e}", file=sys.stderr)

    if args.check:
        info = ctrl.check()
        if info:
            print(f"Update disponível: {ctrl.vm.active_version()} -> {info['latest_version']}")
        else:
            print(f"Instalação atualizada (v{ctrl.vm.active_version()})")
        return 0

    if args.auto:
        try:
            ctrl.update_now()
        except UpdateError as e:
            print(f"[launcher] atualização falhou (prosseguindo com versão atual): {e}",
                  file=sys.stderr)
        proc = ctrl.launch_app()
        print(f"TBot iniciado (pid={proc.pid})")
        return 0

    # GUI
    try:
        from .launcher_ui import LauncherUI
    except ImportError:
        from launcher_ui import LauncherUI  # type: ignore
    ui = LauncherUI(ctrl)

    def bg_check():
        try:
            if ctrl.check():
                ui.set_status(f"Atualização v{ctrl.latest_known} disponível. "
                              "Clique em ATUALIZAR AGORA.", "#f9e2af")
        except UpdateError:
            ui.set_status("Servidor de atualizações indisponível.", "#f38ba8")
    import threading
    threading.Thread(target=bg_check, daemon=True).start()
    return ui.run()


if __name__ == "__main__":
    raise SystemExit(main())
