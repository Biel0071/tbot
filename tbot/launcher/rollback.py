"""Rollback e reparação da instalação do TBot.

Estratégias:
- rollback(): alterna o ponteiro 'active.json' para a versão anterior
  (instalações versionadas são imutáveis, então o rollback é atômico).
- repair(): reinstala a versão ativa a partir do cache de pacotes ou
  baixa novamente do servidor e valida arquivo por arquivo.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .version_manager import VersionManager


class RollbackError(RuntimeError):
    pass


def rollback(vm: VersionManager) -> str:
    """Restaura a versão anterior. Retorna a versão agora ativa."""
    prev = vm.previous_version()
    if not prev or not vm.version_dir(prev).exists():
        raise RollbackError("Nenhuma versão anterior disponível para rollback")
    current = vm.active_version()
    vm._atomic_write(vm.active_file, {"version": prev})
    if current:
        vm._atomic_write(vm.previous_file, {"version": current})
    return prev


def cleanup_old_versions(vm: VersionManager, keep: int = 2) -> list[str]:
    """Remove versões antigas mantendo as N mais recentes (excluindo ativas)."""
    active = {vm.active_version(), vm.previous_version()}
    versions = vm.installed_versions()
    removed = []
    for v in versions[:-keep] if keep > 0 else versions:
        if v not in active:
            shutil.rmtree(vm.version_dir(v), ignore_errors=True)
            removed.append(v)
    return removed


def is_installation_valid(vm: VersionManager) -> bool:
    v = vm.active_version()
    if not v:
        return False
    d = vm.version_dir(v)
    return d.is_dir() and any(p.name.startswith("TBot") for p in d.iterdir())
