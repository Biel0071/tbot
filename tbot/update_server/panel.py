"""Painel administrativo do TBot Control Center (HTML servido pelo update server).

Abra:  http://<servidor>:8300/  — para não poluir a API, este arquivo é
servido separadamente via:  python -m tbot.update_server.panel
(usando o mesmo servidor HTTP; registre a rota estática em produção nginx).
"""

from __future__ import annotations

import os
import urllib.request
import json

PAGE = """<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>TBot Control Center</title>
<style>
 body{background:#1e1e2e;color:#cdd6f4;font-family:Arial,sans-serif;margin:24px}
 h1{color:#89b4fa} .card{background:#181825;border-radius:10px;padding:16px;margin:12px 0}
 button{background:#89b4fa;border:0;color:#11111b;font-weight:bold;padding:10px 16px;
        border-radius:6px;margin-right:8px;cursor:pointer}
 table{border-collapse:collapse;width:100%} td,th{padding:6px 10px;border-bottom:1px solid #313244;text-align:left}
 .ok{color:#a6e3a1}.err{color:#f38ba8}.warn{color:#f9e2af}
 input,select{background:#313244;color:#cdd6f4;border:0;padding:8px;border-radius:6px}
</style></head><body>
<h1>⚡ TBot Control Center</h1>
<div class="card">Token admin: <input id="tok" type="password" size="30">
 <button onclick="save()">Salvar token</button></div>
<div class="card"><b>Versão desejada:</b> <span id="desired">-</span>
 | <b>Dispositivos:</b> <span id="dcount">-</span></div>
<div class="card">
 <button onclick="syncGithub()">SINCRONIZAR GITHUB</button>
 <button onclick="post('/api/v1/admin/build',{version:ver()})">COMPILAR WINDOWS</button>
 <button onclick="post('/api/v1/admin/publish',{version:ver()})">PUBLICAR VERSÃO</button>
 <button onclick="deploy()">ATUALIZAR DISPOSITIVOS</button>
 <button onclick="post('/api/v1/admin/rollback',{channel:'stable'})">ROLLBACK</button>
 <input id="v" placeholder="versão ex.: 1.1.0" size="10">
 <select id="ch"><option>stable</option><option>beta</option></select>
 <select id="mode"><option>manual</option><option>auto</option><option>forced</option></select>
</div>
<div class="card"><h3>Dispositivos</h3><table id="devs"></table></div>
<div class="card"><h3>Últimos eventos</h3><pre id="events"></pre></div>
<script>
let tok = sessionStorage.getItem('tok')||'';
const api=(p,o={})=>fetch(p,{...o,headers:{'Authorization':'Bearer '+tok,'Content-Type':'application/json',...(o.headers||{})}}).then(r=>r.json());
function save(){tok=document.getElementById('tok').value;sessionStorage.setItem('tok',tok);refresh();}
function ver(){return document.getElementById('v').value;}
function post(p,b){api(p,{method:'POST',body:JSON.stringify(b)}).then(refresh);}
function deploy(){post('/api/v1/admin/deploy',{version:ver(),channel:ch(),mode:modesel()});}
function ch(){return document.getElementById('ch').value;}
function modesel(){return document.getElementById('mode').value;}
function syncGithub(){window.open('https://github.com/Biel0071/tbot/actions/workflows/windows-release.yml','_blank');}
async function refresh(){
 try{const s=await api('/api/v1/admin/status');
  document.getElementById('desired').textContent=JSON.stringify(s.desired_version);
  document.getElementById('dcount').textContent=s.device_count;
  document.getElementById('devs').innerHTML='<tr><th>Host</th><th>Versão</th><th>Status</th><th>Visto</th></tr>'+
   (await api('/api/v1/devices')).map(d=>`<tr><td>${d.hostname}</td><td>${d.installed_version||'-'}</td><td class="${d.last_status=='success'?'ok':d.last_status=='failed'?'err':'warn'}">${d.last_status||'-'}</td><td>${d.last_seen||'-'}</td></tr>`).join('');
  document.getElementById('events').textContent=s.events.slice(-15).reverse().map(e=>`${e.ts} ${e.kind} ${e.device_id||''} ${e.version||''} ${e.status||''}`).join('\\n');
 }catch(e){document.getElementById('desired').textContent='erro: '+e;}}
refresh();setInterval(refresh,10000);
</script></body></html>"""


def serve_panel(port: int = 8301) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    print(f"TBot Control Center em http://0.0.0.0:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8301)
    serve_panel(ap.parse_args().port)
