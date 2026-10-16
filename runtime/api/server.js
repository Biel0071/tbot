/**
 * T BOT — Runtime API server (spec §28)
 * Local HTTP API + WebSocket (/ws/runtime) exposing ONLY real runtime state.
 * Uses node:http (no deps). UI/Electron renderer talks to this same API —
 * there is exactly one source of truth: the RuntimeManager.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { RuntimeManager } from './manager.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

export function createServer({ manager = new RuntimeManager(), port = 8791 } = {}) {
  const clients = new Set(); // ws sockets
  manager.onEvent((evt) => broadcast(clients, evt));

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      /* ---- spec §28 endpoints ---- */
      if (p === '/api/status') return json(res, 200, manager.status());
      if (p === '/api/health') return json(res, 200, manager.health());

      if (p === '/api/bot/start' && req.method === 'POST') {
        const b = await readBody(req);
        const s = await manager.start(b.profile);
        return json(res, 200, { ok: true, session: s });
      }
      if (p === '/api/bot/stop' && req.method === 'POST') {
        const r = await manager.stop();
        return json(res, 200, { ok: true, ...r });
      }
      if (p === '/api/bot/pause' && req.method === 'POST') { await manager.pause(); return json(res, 200, { ok: true }); }
      if (p === '/api/bot/resume' && req.method === 'POST') { await manager.resume(); return json(res, 200, { ok: true }); }

      if (p === '/api/session') return json(res, 200, manager.engine?.ctx.telemetry.session ?? null);
      if (p === '/api/statistics') return json(res, 200, manager.engine?.ctx.telemetry.statistics() ?? { active: false });
      if (p === '/api/logs') {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return json(res, 200, (manager.engine?.ctx.telemetry.logs ?? []).slice(-limit));
      }
      if (p === '/api/events') {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        return json(res, 200, (manager.engine?.ctx.telemetry.events ?? []).slice(-limit));
      }

      if (p === '/api/profiles') return json(res, 200, manager.profiles.list());
      if (p.startsWith('/api/profiles/') && req.method === 'POST') {
        const name = p.split('/')[3];
        manager.profiles.create(name);
        return json(res, 200, { ok: true, name });
      }
      if (p === '/api/config') {
        if (req.method === 'GET') return json(res, 200, manager.profile ?? manager.profiles.load(manager.profiles.list()[0] ?? 'character-1'));
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const name = b.name ?? manager.profile?.settings?.name ?? 'character-1';
          for (const [section, data] of Object.entries(b.sections ?? {})) manager.profiles.save(name, section, data);
          manager.loadProfile(name);
          return json(res, 200, { ok: true });
        }
      }

      if (p === '/api/routes' && req.method === 'GET') {
        const prof = manager.profile ?? manager.profiles.load(manager.profiles.list()[0] ?? 'character-1');
        return json(res, 200, prof.cavebot.routes);
      }
      if (p === '/api/routes' && req.method === 'POST') {
        const b = await readBody(req);
        const prof = manager.profile ?? manager.profiles.load(manager.profiles.list()[0] ?? 'character-1');
        prof.cavebot.routes.push(b);
        manager.profiles.save(prof.settings.name, 'cavebot', prof.cavebot);
        manager.loadProfile(prof.settings.name);
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/api/routes/') && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = decodeURIComponent(p.split('/')[3]);
        const prof = manager.profile ?? manager.profiles.load(manager.profiles.list()[0] ?? 'character-1');
        const idx = prof.cavebot.routes.findIndex(r => r.route === id);
        if (idx === -1) return json(res, 404, { error: 'route not found' });
        if (req.method === 'DELETE') prof.cavebot.routes.splice(idx, 1);
        else prof.cavebot.routes[idx] = await readBody(req);
        manager.profiles.save(prof.settings.name, 'cavebot', prof.cavebot);
        manager.loadProfile(prof.settings.name);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: `no route: ${req.method} ${p}` });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });

  /* ---- minimal WebSocket implementation (RFC6455 server side) ---- */
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws/runtime')) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acc}\r\n\r\n`
    );
    socket.setNoDelay(true);
    clients.add(socket);
    sendFrame(socket, { type: 'HELLO', health: manager.health() });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  // periodic realtime push so overlay/dashboard stay live
  const pusher = setInterval(() => {
    const st = manager.status();
    for (const c of clients) sendFrame(c, { type: 'STATUS', ...st });
  }, 500);
  if (pusher.unref) pusher.unref();
  server.on('close', () => clearInterval(pusher));

  server.listen(port, () => {
    console.log(`[tbot-runtime] API listening on http://127.0.0.1:${port} (ws: /ws/runtime)`);
  });
  return { server, manager, port };
}

function sendFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

function broadcast(clients, evt) {
  for (const c of clients) sendFrame(c, evt);
}

// direct run: `node runtime/api/server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = createServer({ port: Number(process.env.TBOT_PORT ?? 8791) });
  process.on('SIGINT', async () => {
    await ctx.manager.stop().catch(() => {});
    ctx.manager.close();
    ctx.server.close();
    process.exit(0);
  });
}
