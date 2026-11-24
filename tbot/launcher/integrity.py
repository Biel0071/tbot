"""Verificação de integridade dos pacotes de atualização do TBot.

- SHA256 obrigatório em todo download.
- Assinatura HMAC-SHA256 opcional (quando o servidor publica 'signature'
  no manifesto e o launcher possui a chave configurada).
- Validação pós-instalação de cada arquivo listado no manifesto.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

CHUNK = 1024 * 1024


def sha256_file(path: Path | str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def verify_package(path: Path | str, expected_sha256: str) -> bool:
    """Confere o hash SHA256 de um pacote baixado."""
    return hmac.compare_digest(sha256_file(path), expected_sha256.lower())


def verify_signature(manifest: dict, secret: str | None) -> bool:
    """Valida assinatura HMAC do manifesto (canonical JSON sem 'signature')."""
    if not secret:
        return True  # assinatura não configurada -> compatível com HTTP interno
    sig = manifest.get("signature", "")
    body = {k: v for k, v in manifest.items() if k != "signature"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    expected = hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def verify_installed_files(target_dir: Path | str, files: list[dict]) -> bool:
    """Health check: todos os arquivos do manifesto presentes e com hash ok."""
    target = Path(target_dir)
    for entry in files:
        p = target / entry["path"]
        if not p.is_file():
            return False
        if not hmac.compare_digest(sha256_file(p), entry["sha256"].lower()):
            return False
    return True
