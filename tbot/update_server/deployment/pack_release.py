"""Empacota uma build do TBot em um release para o Update Server.

Executa no runner Windows (GitHub Actions) ou localmente:
    python tbot/update_server/deployment/pack_release.py --dist dist/TBot --version 1.1.0

Gera:
    releases/<version>/tbot-<version>.zip   (conteúdo da versão, incluindo TBot.exe)
    releases/<version>/manifest.json        (arquivos + sha256 + package_sha256 + assinatura)

Para testes locais sem exe, use --allow-missing-exe.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(dist_dir: Path, version: str, out_zip: Path, channel: str) -> dict:
    files = []
    for p in sorted(dist_dir.rglob("*")):
        if p.is_file():
            files.append({"path": str(p.relative_to(dist_dir)).replace("\\", "/"),
                          "sha256": sha256_file(p),
                          "size": p.stat().st_size})
    manifest = {
        "product": "TBot",
        "version": version,
        "channel": channel,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": files,
        "package_sha256": sha256_file(out_zip),
        "package_size": out_zip.stat().st_size,
    }
    secret = os.environ.get("TBOT_MANIFEST_SECRET")
    if secret:
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        manifest["signature"] = hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True, help="diretório da build (ex.: dist/TBot)")
    ap.add_argument("--version", required=True)
    ap.add_argument("--out", default=None, help="destino (padrão: server_data/releases)")
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--allow-missing-exe", action="store_true")
    args = ap.parse_args()

    dist = Path(args.dist)
    if not dist.is_dir():
        print(f"ERRO: diretório de build não existe: {dist}", file=sys.stderr)
        return 1
    if not args.allow_missing_exe and not (dist / "TBot.exe").exists():
        print("ERRO: TBot.exe ausente na build. Use --allow-missing-exe apenas para testes.",
              file=sys.stderr)
        return 1

    out_root = Path(args.out or Path(__file__).resolve().parents[2] / "server_data" / "releases")
    rel_dir = out_root / args.version
    rel_dir.mkdir(parents=True, exist_ok=True)
    pkg = rel_dir / f"tbot-{args.version}.zip"

    with zipfile.ZipFile(pkg, "w", zipfile.ZIP_DEFLATED) as z:
        for p in dist.rglob("*"):
            if p.is_file():
                z.write(p, p.relative_to(dist))

    manifest = build_manifest(dist, args.version, pkg, args.channel)
    (rel_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Release pronto: {pkg}")
    print(f"Manifesto: {rel_dir / 'manifest.json'} ({len(manifest['files'])} arquivos, "
          f"sha256={manifest['package_sha256'][:16]}...)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
