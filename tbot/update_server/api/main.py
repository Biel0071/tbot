"""TBot Update Server — API central de versionamento e distribuição.

Armazenamento em JSON (adequado para escala pequena/média; trocar por
Postgres quando houver muitos dispositivos). Sem dependências externas:
http.server + stdlib, fácil de hospedar no VPS Linux atrás de nginx/TLS.

Segurança:
- Dispositivos autenticam com X-Api-Key (chave por dispositivo ou global).
- Admin usa TBOT_ADMIN_TOKEN separado.
- O servidor NUNCA executa código recebido; apenas publica artefatos
  já compilados e validados pelo pipeline (GitHub Actions).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(os.environ.get("TBOT_SERVER_HOME", Path(__file__).resolve().parents[1] / "server_data"))
RELEASES = ROOT / "releases"
DB_FILE = ROOT / "db.json"
LOCK = threading.Lock()

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_db() -> dict:
    if DB_FILE.exists():
        return json.loads(DB_FILE.read_text(encoding="utf-8"))
    return {
        "desired_version": {"stable": None, "beta": None},
        "devices": {},          # device_id -> registro
        "events": [],           # histórico
        "builds": [],           # histórico de builds
        "rollout": {},          # versao -> pct 0..100
        "mode": {"stable": "manual", "beta": "auto"},  # auto|manual|forced
    }


def save_db(db: dict) -> None:
    tmp = DB_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(db, indent=2), encoding="utf-8")
    os.replace(tmp, DB_FILE)


def log_event(db: dict, kind: str, detail: dict) -> None:
    db["events"].append({"ts": now(), "kind": kind, **detail})
    db["events"] = db["events"][-5000:]


# ---------------------------------------------------------------- helpers
def sign_manifest(manifest: dict) -> dict:
    secret = os.environ.get("TBOT_MANIFEST_SECRET")
    body = {k: v for k, v in manifest.items() if k != "signature"}
    if secret:
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        manifest["signature"] = hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
    return manifest


def read_release(version: str) -> dict | None:
    p = RELEASES / version / "manifest.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def device_in_rollout(device_id: str, version: str, db: dict) -> bool:
    pct = db.get("rollout", {}).get(version, 100)
    if pct >= 100:
        return True
    h = int(hashlib.sha256(f"{device_id}:{version}".encode()).hexdigest(), 16)
    return (h % 100) < pct


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "TBotUpdateServer/1.0"

    def _send(self, code: int, payload, raw: bytes | None = None) -> None:
        body = raw if raw is not None else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if raw is None
                         else "application/zip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _check_device(self) -> bool:
        key = self.headers.get("X-Api-Key", "")
        expected = os.environ.get("TBOT_DEVICE_API_KEY")
        return (not expected) or hmac.compare_digest(key, expected)

    def _check_admin(self) -> bool:
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        admin = os.environ.get("TBOT_ADMIN_TOKEN")
        return bool(admin) and hmac.compare_digest(token, admin)

    def log_message(self, fmt, *args):  # silencioso-ish
        pass

    # ------------------------- GET -------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        with LOCK:
            db = load_db()
        if u.path == "/api/v1/updates/check":
            if not self._check_device():
                return self._send(401, {"error": "api key inválida"})
            ch = q.get("channel", "stable")
            desired = db["desired_version"].get(ch)
            current = q.get("current", "0.0.0")
            avail = bool(desired and _gt(desired, current))
            return self._send(200, {
                "update_available": avail,
                "latest_version": desired,
                "current_version": current,
                "mode": db["mode"].get(ch, "manual"),
                "mandatory": db["mode"].get(ch) == "forced",
            })
        if u.path == "/api/v1/updates/manifest":
            m = read_release(q.get("version", ""))
            return self._send(200 if m else 404, m or {"error": "versão não publicada"})
        if u.path == "/api/v1/updates/download":
            v = q.get("version", "")
            pkg = RELEASES / v / f"tbot-{v}.zip"
            if not VERSION_RE.match(v) or not pkg.exists():
                return self._send(404, {"error": "pacote não encontrado"})
            return self._send(200, None, raw=pkg.read_bytes())
        if u.path == "/api/v1/devices":
            if not self._check_admin():
                return self._send(403, {"error": "admin required"})
            return self._send(200, list(db["devices"].values()))
        if u.path == "/api/v1/admin/status":
            if not self._check_admin():
                return self._send(403, {"error": "admin required"})
            return self._send(200, {
                "desired_version": db["desired_version"],
                "mode": db["mode"],
                "rollout": db["rollout"],
                "builds": db["builds"][-20:],
                "events": db["events"][-50:],
                "device_count": len(db["devices"]),
            })
        if u.path == "/healthz":
            return self._send(200, {"ok": True, "time": now()})
        return self._send(404, {"error": "rota desconhecida"})

    # ------------------------- POST ------------------------
    def do_POST(self):
        u = urlparse(self.path)
        body = self._json_body()
        with LOCK:
            db = load_db()
            if u.path == "/api/v1/devices/register":
                if not self._check_device():
                    return self._send(401, {"error": "api key inválida"})
                did = body.get("device_id")
                if not did:
                    return self._send(400, {"error": "device_id obrigatório"})
                db["devices"][did] = {
                    "device_id": did,
                    "hostname": body.get("hostname", ""),
                    "installed_version": body.get("installed_version"),
                    "channel": body.get("channel", "stable"),
                    "last_seen": now(),
                    "last_status": "registered",
                }
                log_event(db, "register", {"device_id": did})
                save_db(db)
                return self._send(200, {"ok": True})

            if u.path == "/api/v1/updates/report":
                if not self._check_device():
                    return self._send(401, {"error": "api key inválida"})
                did = body.get("device_id")
                dev = db["devices"].setdefault(did, {"device_id": did})
                dev.update({
                    "installed_version": body.get("installed_version"),
                    "last_status": body.get("status"),
                    "last_error": body.get("error"),
                    "last_seen": now(),
                })
                log_event(db, "update_report", {
                    "device_id": did, "status": body.get("status"),
                    "target": body.get("target_version"), "error": body.get("error")})
                save_db(db)
                return self._send(200, {"ok": True})

            # ---- rotas administrativas ----
            if not self._check_admin():
                return self._send(403, {"error": "admin required"})

            if u.path == "/api/v1/admin/publish":
                v = body.get("version", "")
                if not VERSION_RE.match(v):
                    return self._send(400, {"error": "versão inválida"})
                m = read_release(v)
                if not m:
                    return self._send(404, {"error": "release não carregada no servidor"})
                log_event(db, "publish", {"version": v})
                save_db(db)
                return self._send(200, {"ok": True, "manifest": m})

            if u.path == "/api/v1/admin/deploy":
                v, ch = body.get("version"), body.get("channel", "stable")
                if ch not in ("stable", "beta"):
                    return self._send(400, {"error": "canal inválido"})
                if not read_release(v):
                    return self._send(404, {"error": "versão não publicada"})
                db["desired_version"][ch] = v
                db["rollout"][v] = int(body.get("rollout_pct", 100))
                log_event(db, "deploy", {"version": v, "channel": ch,
                                         "rollout": db["rollout"][v]})
                save_db(db)
                return self._send(200, {"ok": True, "desired_version": v})

            if u.path == "/api/v1/admin/mode":
                ch = body.get("channel", "stable")
                mode = body.get("mode")
                if mode not in ("auto", "manual", "forced"):
                    return self._send(400, {"error": "modo inválido"})
                db["mode"][ch] = mode
                log_event(db, "mode", {"channel": ch, "mode": mode})
                save_db(db)
                return self._send(200, {"ok": True})

            if u.path == "/api/v1/admin/rollback":
                ch = body.get("channel", "stable")
                prev = db["desired_version"].get(ch)
                versions = sorted((p.name for p in RELEASES.iterdir()
                                   if p.is_dir() and VERSION_RE.match(p.name)),
                                  key=_vtuple)
                if prev in versions:
                    idx = versions.index(prev)
                    if idx == 0:
                        return self._send(400, {"error": "não há versão anterior"})
                    db["desired_version"][ch] = versions[idx - 1]
                    log_event(db, "server_rollback",
                              {"from": prev, "to": db["desired_version"][ch]})
                    save_db(db)
                    return self._send(200, {"ok": True,
                                            "desired_version": db["desired_version"][ch]})
                return self._send(400, {"error": "versão atual não encontrada"})

            if u.path.startswith("/api/v1/admin/ingest/"):
                # Recebe o pacote + manifesto gerados pelo runner Windows.
                v = u.path.rsplit("/", 1)[-1]
                if not VERSION_RE.match(v):
                    return self._send(400, {"error": "versão inválida"})
                kind = q.get("file", "")
                n = int(self.headers.get("Content-Length", 0))
                blob = self.rfile.read(n)
                rel = RELEASES / v
                rel.mkdir(parents=True, exist_ok=True)
                if kind == "manifest":
                    (rel / "manifest.json").write_bytes(blob)
                elif kind == "package":
                    (rel / f"tbot-{v}.zip").write_bytes(blob)
                    m = json.loads((rel / "manifest.json").read_text(encoding="utf-8"))
                    digest = hashlib.sha256(blob).hexdigest()
                    if not hmac.compare_digest(digest, m["package_sha256"]):
                        (rel / f"tbot-{v}.zip").unlink(missing_ok=True)
                        return self._send(422, {"error": "SHA256 do pacote não confere"})
                else:
                    return self._send(400, {"error": "use ?file=manifest ou ?file=package"})
                log_event(db, "ingest", {"version": v, "file": kind, "bytes": n})
                save_db(db)
                return self._send(200, {"ok": True})

            if u.path == "/api/v1/admin/build":
                # O build real roda no GitHub Actions (runner Windows).
                # O servidor registra a solicitação e o workflow a consome.
                bid = secrets.token_hex(6)
                db["builds"].append({"id": bid, "requested_at": now(),
                                     "commit": body.get("commit"),
                                     "version": body.get("version"),
                                     "status": "queued"})
                log_event(db, "build_requested", {"build_id": bid,
                                                  "version": body.get("version")})
                save_db(db)
                return self._send(202, {"build_id": bid,
                                        "note": "compilação executada pelo runner Windows do GitHub Actions"})

            return self._send(404, {"error": "rota desconhecida"})


def _vtuple(v: str) -> tuple:
    return tuple(int(x) for x in v.split("."))


def _gt(a: str, b: str) -> bool:
    try:
        return _vtuple(a) > _vtuple(b)
    except ValueError:
        return False


def serve(port: int = 8300) -> None:
    RELEASES.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"TBot Update Server ouvindo em :{port} (home={ROOT})")
    srv.serve_forever()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("TBOT_PORT", 8300)))
    serve(ap.parse_args().port)
