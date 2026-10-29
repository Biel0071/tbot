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
 *   GET  /api/client/frame      → frame atual do cliente (PNG real ou SVG determinístico)
 *   GET  /api/learning          → telemetria de aprendizado em tempo real
 *   GET  /apps/*, /runtime/*, /core/*, /data/* → arquivos estáticos com Cache-Control: no-store
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { RuntimeManager } = require('./manager');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PORT = 8791;

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

  if (pathname === '/api/learning' && req.method === 'GET') {
    sendJson(res, 200, manager.getLearning());
    return;
  }

  if (pathname === '/api/client/frame' && req.method === 'GET') {
    const frame = manager.getClientFrame();
    const headers = {
      'Content-Type': frame.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Frame-Source': frame.source,
      'X-Frame-Seq': String(frame.meta.seq),
      'X-Client-Detected': String(frame.meta.detected),
    };
    res.writeHead(200, headers);
    res.end(Buffer.isBuffer(frame.body) ? frame.body : Buffer.from(frame.body, 'utf8'));
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
  server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`T BOT — Autonomous Tibia Bot (MVP 1.0) rodando em http://127.0.0.1:${port} (preview ?charFull=1)`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, handleRequest, serveStatic, DEFAULT_PORT };
