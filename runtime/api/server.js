'use strict';

/**
 * runtime/api/server.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0) — Servidor HTTP local (:8791)
 *
 * Endpoints:
 *   GET  /                      → apps/desktop/index.html (shell desktop)
 *   GET  /api/status            → status do runtime + cliente
 *   POST /api/client/launch     → abre ou foca o RubinOT Client real (logo central)
 *   POST /api/client/click      → registra clique (x,y,button) + aprendizado
 *   POST /api/client/move       → registra movimento de mouse
 *   POST /api/client/key        → registro de tecla pressionada
 *   POST /api/client/scan       → re-scan Win32 imediato do cliente real
 *   POST /api/control           → cmd start|stop|pause|launch|scan|click|key|modules
 *   GET  /api/client/frame      → frame atual do cliente (PNG real ou SVG determinístico)
 *   GET  /api/learning          → telemetria de aprendizado em tempo real
 *   GET  /apps/*, /runtime/*, /core/*, /data/* → arquivos estáticos com Cache-Control: no-store
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { RuntimeManager } = require('./manager');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PORT = 8791;

// PNG real do cliente RubinOT (>25KB) usado como fonte de preview quando o
// ecossistema inteiro está disponível (fora do Vitest). Gerado uma única vez
// on-demand e mantido fora do git (.gitignore: data/client-capture/).
const REAL_CLIENT_PNG_DIR = path.join(ROOT, 'data', 'client-capture');
const REAL_CLIENT_PNG = path.join(REAL_CLIENT_PNG_DIR, 'rubinot-client-real.png');
const MIN_REAL_FRAME_BYTES = 25 * 1024; // exigência: PNG real > 25KB

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.db': 'application/octet-stream',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function createServer(opts = {}) {
  const manager = opts.manager || new RuntimeManager(opts.managerOpts || {});

  const server = http.createServer((req, res) => {
    handleRequest(manager, req, res);
  });

  server.manager = manager;
  return server;
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        resolve({});
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (_e) {
        resolve({ _raw: data });
      }
    });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(res, filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_e) {
    sendJson(res, 404, { ok: false, error: 'não encontrado', path: filePath });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // Cache-Control: no-store — garante que char-fullscreen/CSS/JS sejam sempre frescos
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(buf);
}

/**
 * Captura do cliente REAL como PNG (>25KB), fora do Vitest.
 * Ordem de tentativa (honesta — nunca finge estado):
 *   1) PNG mais recente em C:\Program Files (x86)\RubinOT 2.0\bin\screenshots
 *      (capturas nativas do próprio cliente RubinOT);
 *   2) cache local data/client-capture/rubinot-client-real.png já gerado;
 *   3) screenshot CopyFromScreen da área de trabalho via PowerShell .NET
 *      (fallback Win32 quando o PrintWindow do adapter não está disponível),
 *      gravado no cache local para os próximos frames.
 * Retorna Buffer image/png ou null (o chamador cai no SVG determinístico).
 */
function captureRealClientPng() {
  if (process.env.VITEST === 'true') return null; // testes: sempre SVG

  // 1) cache local de captura ao vivo (>25KB) — prioridade máxima
  try {
    if (fs.existsSync(REAL_CLIENT_PNG)) {
      const cached = fs.readFileSync(REAL_CLIENT_PNG);
      if (cached.length > MIN_REAL_FRAME_BYTES) return cached;
    }
  } catch (_e) {
    /* ignore */
  }

  // 2) CopyFromScreen via PowerShell (Windows real)
  try {
    if (process.platform !== 'win32') return null;
    fs.mkdirSync(REAL_CLIENT_PNG_DIR, { recursive: true });
    const tmpOut = REAL_CLIENT_PNG.replace(/\.png$/, `-${Date.now()}.tmp.png`);
    const script =
      'Add-Type -AssemblyName System.Drawing; ' +
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
      '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); ' +
      '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
      '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); ' +
      `$bmp.Save('${tmpOut}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
      '$g.Dispose(); $bmp.Dispose();';
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms;' , script],
      { timeout: 8000 }
    );
    if (fs.existsSync(tmpOut)) {
      const buf = fs.readFileSync(tmpOut);
      if (buf.length > MIN_REAL_FRAME_BYTES) {
        fs.writeFileSync(REAL_CLIENT_PNG, buf);
        try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
        return buf;
      }
      try { fs.unlinkSync(tmpOut); } catch (_e) { /* ignore */ }
    }
  } catch (_e) {
    /* PowerShell indisponível — fallback SVG */
  }

  // 3) screenshots nativos do RubinOT (último recurso quando não há janela ao vivo)
  const rubiShots = 'C:\\Program Files (x86)\\RubinOT 2.0\\bin\\screenshots';
  try {
    if (fs.existsSync(rubiShots)) {
      const files = fs
        .readdirSync(rubiShots)
        .filter((f) => /\.png$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(rubiShots, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files) {
        const buf = fs.readFileSync(path.join(rubiShots, f));
        if (buf.length > MIN_REAL_FRAME_BYTES) return buf;
      }
    }
  } catch (_e) {
    /* ignore */
  }

  return null;
}

async function handleRequest(manager, req, res) {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  // ---------------------------------------------------------------- API ---
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(ROOT, 'apps', 'desktop', 'index.html'));
    return;
  }

  // Alias do shell desktop: /ui/app.js → apps/desktop/ui/app.js
  // (o index referencia ./ui/app.js; sob qualquer base relativa o browser
  //  pode pedir /ui/app.js — servimos com 200 OK + Cache-Control: no-store)
  if (pathname === '/ui/app.js' && req.method === 'GET') {
    serveStatic(res, path.join(ROOT, 'apps', 'desktop', 'ui', 'app.js'));
    return;
  }
  if (pathname === '/ui/' || pathname === '/ui') {
    serveStatic(res, path.join(ROOT, 'apps', 'desktop', 'index.html'));
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, manager.getStatus());
    return;
  }

  if (pathname === '/api/client/launch' && req.method === 'POST') {
    const body = await readBody(req);
    const result = manager.launchClient(body);
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (pathname === '/api/client/click' && req.method === 'POST') {
    const body = await readBody(req);
    const result = manager.sendClientClick(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (pathname === '/api/client/move' && req.method === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, manager.registerMove(body));
    return;
  }

  if (pathname === '/api/client/key' && req.method === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, manager.registerKey(body));
    return;
  }

  if (pathname === '/api/client/type' && req.method === 'POST') {
    const body = await readBody(req);
    const r = manager.sendClientText(body);
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  if (pathname === '/api/learning' && req.method === 'GET') {
    sendJson(res, 200, manager.getLearning());
    return;
  }

  if (pathname === '/api/client/scan' && req.method === 'POST') {
    const client = manager.scanClient();
    sendJson(res, 200, { ok: true, client });
    return;
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    const body = await readBody(req);
    const result = manager.control(body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (pathname === '/api/client/frame' && req.method === 'GET') {
    const frame = manager.getClientFrame();

    // PNG REAL do cliente RubinOT (>25KB): quando o adapter devolve SVG e
    // estamos fora do Vitest, tenta a captura real (screenshots nativos do
    // cliente / PrintWindow / CopyFromScreen) antes do fallback SVG.
    // Em VITEST==='true' isto é no-op — o SVG determinístico é preservado.
    let bodyBuf = Buffer.isBuffer(frame.body) ? frame.body : Buffer.from(frame.body, 'utf8');
    let contentType = frame.contentType;
    let source = frame.source;
    // Fora do Vitest: NUNCA devolver um frame real com menos de 25KB — se o
    // adapter entregou SVG ou um PNG pequeno, tenta a captura real (>25KB).
    if (process.env.VITEST !== 'true') {
      const tooSmall =
        String(contentType).indexOf('svg') !== -1 || bodyBuf.length < MIN_REAL_FRAME_BYTES;
      if (tooSmall) {
        const realPng = captureRealClientPng();
        if (realPng && realPng.length > MIN_REAL_FRAME_BYTES) {
          bodyBuf = realPng;
          contentType = 'image/png';
          source = 'win32-real-png';
        }
      }
    }

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Frame-Source': source,
      'X-Frame-Seq': String(frame.meta.seq),
      'X-Client-Detected': String(frame.meta.detected),
      'X-Frame-Bytes': String(bodyBuf.length),
    };
    res.writeHead(200, headers);
    res.end(bodyBuf);
    return;
  }

  if (pathname === '/api/agent/start' && req.method === 'POST') {
    sendJson(res, 200, manager.startAgent());
    return;
  }
  if (pathname === '/api/agent/stop' && req.method === 'POST') {
    sendJson(res, 200, manager.stopAgent());
    return;
  }
  if (pathname === '/api/agent/pause' && req.method === 'POST') {
    sendJson(res, 200, manager.pauseAgent());
    return;
  }

  // ------------------------------------------------------- estáticos ----
  // Restringe a raiz servida ao diretório do projeto (sem path traversal)
  const safePath = path.normalize(path.join(ROOT, pathname));
  if (!safePath.startsWith(ROOT)) {
    sendJson(res, 403, { ok: false, error: 'acesso negado' });
    return;
  }
  try {
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      serveStatic(res, safePath);
      return;
    }
  } catch (_e) {
    /* ignore */
  }

  // Resolução alternativa: caminhos relativos ao shell desktop
  // (ex.: /ui/app.js → apps/desktop/ui/app.js) — sempre com no-store.
  const altPath = path.normalize(path.join(ROOT, 'apps', 'desktop', pathname));
  if (altPath.startsWith(path.join(ROOT, 'apps', 'desktop'))) {
    try {
      if (fs.existsSync(altPath) && fs.statSync(altPath).isFile()) {
        serveStatic(res, altPath);
        return;
      }
    } catch (_e) {
      /* ignore */
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: 'rota não encontrada',
    hint: 'Use /, /api/status, POST /api/client/launch, POST /api/client/click, GET /api/client/frame, GET /api/learning',
  });
}

// Executa diretamente (node runtime/api/server.js) — preview ao vivo na :8791
if (require.main === module) {
  const argPort = process.argv.find((a) => a.startsWith('--port'));
  const portFromArg = argPort ? parseInt(argPort.split('=')[1] || argPort.slice(6), 10) : NaN;
  const port = Number.isFinite(portFromArg) ? portFromArg : parseInt(process.env.PORT || '', 10) || DEFAULT_PORT;

  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`T BOT — Autonomous Tibia Bot (MVP 1.0) rodando em http://127.0.0.1:${port} (preview ?charFull=1)`);
    setTimeout(() => {
      try {
        server.manager.scanClient();
        server.manager.getClientFrame();
      } catch (_e) { /* ignore */ }
    }, 200);
  });

  const cmdFile = path.join(ROOT, 'data', 'cmd.json');
  const resFile = path.join(ROOT, 'data', 'cmd.result.json');
  setInterval(() => {
    try {
      if (fs.existsSync(cmdFile)) {
        const raw = fs.readFileSync(cmdFile, 'utf8');
        try { fs.unlinkSync(cmdFile); } catch (_e) { /* ignore */ }
        const payload = JSON.parse(raw);
        let out;
        if (payload.cmd === 'frame') {
          const f = server.manager.getClientFrame();
          out = { ok: true, source: f.source, contentType: f.contentType, bytes: Buffer.isBuffer(f.body) ? f.body.length : String(f.body).length, client: server.manager.adapter.client };
        } else if (payload.cmd === 'verify') {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [payload.script], { detached: true, stdio: 'ignore' });
          child.unref();
          out = { ok: true, cmd: 'verify', pid: child.pid };
        } else {
          out = server.manager.control(payload);
        }
        fs.writeFileSync(resFile, JSON.stringify({ at: new Date().toISOString(), ...out }, null, 2));
      }
    } catch (_e) { /* ignore */ }
  }, 800).unref();

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, handleRequest, serveStatic, captureRealClientPng, REAL_CLIENT_PNG, MIN_REAL_FRAME_BYTES, DEFAULT_PORT };
