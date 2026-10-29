'use strict';

/**
 * tests/rubinot-modules.test.js
 * Quality Gate — T BOT — Autonomous Tibia Bot (MVP 1.0)
 *
 * Cobre:
 *  - POST /api/client/launch  (abre se fechado / foca se aberto; VITEST simulado)
 *  - POST /api/client/click   (registro de cliques + aprendizado em tempo real)
 *  - GET  /api/learning       (telemetria de cliques/movimentos/teclas)
 *  - GET  /api/client/frame   (SVG determinístico quando VITEST==='true')
 *  - Cache-Control: no-store nos estáticos e endpoints
 *  - CSS char-fullscreen sem faixa preta (grid-template-columns:1fr + grid-column:1/-1)
 *  - Logo central interativa (#centerLogoLauncher / #btnLaunchClientLogo) na UI
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

const require = createRequire(import.meta.url);

// Garante modo determinístico do adapter (SVG sempre; detecção simulada)
process.env.VITEST = 'true';

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tbot-test-'));

let server;
let baseUrl;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString('utf8'));
          } catch (_e) {
            /* não-json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buf, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  const { createServer } = require(path.join(ROOT, 'runtime', 'api', 'server.js'));
  server = createServer({
    managerOpts: {
      stateFile: path.join(TMP, 'rubinot_win32_state.json'),
      logFile: path.join(TMP, 'runtime-live.log'),
      dataDir: TMP,
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
});

describe('POST /api/client/launch — logo central abre/foca o RubinOT Client', () => {
  it('retorna ok:true com action launched em modo simulado (VITEST)', async () => {
    const r = await request('POST', `${baseUrl}/api/client/launch`, { source: 'center-logo' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(['launched', 'focused']).toContain(r.json.action);
    expect(r.json.client).toBeTruthy();
    expect(r.json.client.detected).toBe(true);
  });

  it('funciona tanto com cliente fechado quanto aberto (idempotente: 2º clique foca/relança)', async () => {
    const first = await request('POST', `${baseUrl}/api/client/launch`, { source: 'center-logo' });
    const second = await request('POST', `${baseUrl}/api/client/launch`, { source: 'center-logo' });
    expect(first.json.ok).toBe(true);
    expect(second.json.ok).toBe(true);
    // contador de launches aumenta (aprendizado registra ambos)
    const l = await request('GET', `${baseUrl}/api/learning`);
    expect(l.json.summary.launches).toBeGreaterThanOrEqual(2);
  });

  it('incrementa totalLaunches no aprendizado após launch', async () => {
    const before = await request('GET', `${baseUrl}/api/learning`);
    await request('POST', `${baseUrl}/api/client/launch`, {});
    const after = await request('GET', `${baseUrl}/api/learning`);
    expect(after.json.summary.launches).toBeGreaterThan(before.json.summary.launches);
  });
});

describe('POST /api/client/click — registro de cliques em tempo real', () => {
  it('registra clique válido com clickCount crescente', async () => {
    const r1 = await request('POST', `${baseUrl}/api/client/click`, { x: 400, y: 310, button: 'left', source: 'live-frame-click' });
    expect(r1.status).toBe(200);
    expect(r1.json.ok).toBe(true);
    expect(r1.json.click.x).toBe(400);
    expect(r1.json.click.y).toBe(310);
    expect(r1.json.clickCount).toBeGreaterThanOrEqual(1);

    const r2 = await request('POST', `${baseUrl}/api/client/click`, { x: 405, y: 315, button: 'right' });
    expect(r2.json.clickCount).toBeGreaterThan(r1.json.clickCount);
    expect(r2.json.click.button).toBe('right');
  });

  it('alimenta hot zones e patterns do aprendizado', async () => {
    await request('POST', `${baseUrl}/api/client/click`, { x: 100, y: 100, button: 'left' });
    const l = await request('GET', `${baseUrl}/api/learning`);
    expect(l.json.ok).toBe(true);
    expect(l.json.summary.clicks).toBeGreaterThanOrEqual(1);
    expect(Object.keys(l.json.learning.hotZones).length).toBeGreaterThan(0);
    expect(Object.keys(l.json.learning.patterns).length).toBeGreaterThan(0);
  });

  it('rejeita coordenadas inválidas com 400', async () => {
    const r = await request('POST', `${baseUrl}/api/client/click`, { x: 'abc', y: null });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
  });

  it('aceita aliases clientX/clientY', async () => {
    const r = await request('POST', `${baseUrl}/api/client/click`, { clientX: 250, clientY: 200, button: 'middle' });
    expect(r.status).toBe(200);
    expect(r.json.click.x).toBe(250);
    expect(r.json.click.button).toBe('middle');
  });
});

describe('GET /api/learning — telemetria de cliques/movimentos/teclas', () => {
  it('retoma summary completo e consistente', async () => {
    const r = await request('GET', `${baseUrl}/api/learning`);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.summary).toMatchObject({
      clicks: expect.any(Number),
      moves: expect.any(Number),
      keys: expect.any(Number),
      launches: expect.any(Number),
    });
    expect(Array.isArray(r.json.recentClicks)).toBe(true);
    expect(r.json.generatedAt).toBeTruthy();
  });

  it('registra movimentos e teclas via /api/client/move e /api/client/key', async () => {
    await request('POST', `${baseUrl}/api/client/move`, { x: 300, y: 250 });
    await request('POST', `${baseUrl}/api/client/key`, { key: 'e' });
    const l = await request('GET', `${baseUrl}/api/learning`);
    expect(l.json.summary.moves).toBeGreaterThanOrEqual(1);
    expect(l.json.summary.keys).toBeGreaterThanOrEqual(1);
    expect(l.json.recentKeys.some((k) => k.key === 'e')).toBe(true);
  });
});

describe('GET /api/client/frame — cliente real no meio da tela', () => {
  it('em VITEST===true retorna SVG determinístico (não quebra testes existentes)', async () => {
    const r = await request('GET', `${baseUrl}/api/client/frame`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('image/svg+xml');
    expect(r.text).toContain('<svg');
    expect(r.text).toContain('T BOT');
    expect(r.headers['x-frame-source']).toBe('svg-fallback');
  });

  it('cada frame incrementa o seq (live preview ao vivo)', async () => {
    const a = await request('GET', `${baseUrl}/api/client/frame`);
    const b = await request('GET', `${baseUrl}/api/client/frame`);
    expect(Number(b.headers['x-frame-seq'])).toBeGreaterThan(Number(a.headers['x-frame-seq']));
  });
});

describe('Cache-Control: no-store em arquivos estáticos e API', () => {
  it('GET / (apps/desktop/index.html) serve com no-store', async () => {
    const r = await request('GET', `${baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['cache-control']).toContain('must-revalidate');
  });

  it('GET /apps/desktop/ui/app.js serve com no-store', async () => {
    const r = await request('GET', `${baseUrl}/apps/desktop/ui/app.js`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
  });

  it('GET /api/status responde JSON com no-store', async () => {
    const r = await request('GET', `${baseUrl}/api/status`);
    expect(r.status).toBe(200);
    expect(r.json.product).toContain('T BOT');
    expect(r.headers['cache-control']).toContain('no-store');
  });
});

describe('CSS char-fullscreen — zero faixa preta no meio (?charFull=1)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'index.html'), 'utf8');

  it('body.char-fullscreen #app usa grid-template-columns:1fr e rows 34px 1fr 38px', () => {
    expect(html).toMatch(/body\.char-fullscreen\s+#app\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(html).toMatch(/body\.char-fullscreen\s+#app\s*\{[^}]*grid-template-rows:\s*34px\s+1fr\s+38px/);
  });

  it('header, main e footer recebem grid-column:1/-1 em char-fullscreen', () => {
    expect(html).toMatch(/body\.char-fullscreen\s+header[\s\S]{0,160}?body\.char-fullscreen\s+main[\s\S]{0,160}?body\.char-fullscreen\s+footer\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });

  it('nav e aside ficam display:none em char-fullscreen (sem coluna 0px fantasma)', () => {
    expect(html).toMatch(/body\.char-fullscreen\s+nav#rail,[\s\S]{0,80}?body\.char-fullscreen\s+aside#sidePanel\s*\{\s*display:\s*none/);
  });
});

describe('Logo central interativa no meio da tela (index.html + app.js)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'ui', 'app.js'), 'utf8');

  it('#centerLogoLauncher e #btnLaunchClientLogo existem dentro de #centerClientViewport', () => {
    expect(html).toContain('id="centerClientViewport"');
    expect(html).toContain('id="centerLogoLauncher"');
    expect(html).toContain('id="btnLaunchClientLogo"');
    expect(html).toContain('id="liveCharFrame"');
  });

  it('a logo fica posicionada no MEIO da tela (left/top 50% + translate -50%)', () => {
    expect(html).toMatch(/#centerLogoLauncher\s*\{[\s\S]*?left:\s*50%;[\s\S]*?top:\s*50%;/);
    expect(html).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/);
  });

  it('clique na logo chama POST /api/client/launch e renderiza /api/client/frame', () => {
    expect(ui).toContain('/api/client/launch');
    expect(ui).toContain('/api/client/frame');
    expect(ui).toContain('/api/client/click');
    expect(ui).toContain('/api/learning');
    expect(ui).toMatch(/getElementById\(['"]centerLogoLauncher['"]\)/);
    expect(ui).toMatch(/getElementById\(['"]btnLaunchClientLogo['"]\)/);
  });
});

describe('Adapter Win32 — comportamento fora do Vitest é honesto (sem cache falso)', () => {
  it('scanClient marca detected=false quando não há processo real (ambiente Linux/CI)', () => {
    const { RubinotWin32Adapter } = require(path.join(ROOT, 'runtime', 'adapters', 'rubinot-win32.js'));
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const a = new RubinotWin32Adapter({ stateFile: path.join(TMP, 'honest-state.json') });
      const c = a.scanClient();
      if (process.platform !== 'win32') {
        expect(c.detected).toBe(false);
        expect(c.running).toBe(false);
      } else {
        expect(typeof c.detected).toBe('boolean');
      }
    } finally {
      process.env.VITEST = saved;
    }
  });

  it('captureFrame mantém SVG determinístico em VITEST===true', () => {
    const { RubinotWin32Adapter } = require(path.join(ROOT, 'runtime', 'adapters', 'rubinot-win32.js'));
    process.env.VITEST = 'true';
    const a = new RubinotWin32Adapter({ stateFile: path.join(TMP, 'svg-state.json') });
    const f = a.captureFrame();
    expect(f.contentType).toBe('image/svg+xml');
    expect(String(f.body)).toContain('<svg');
  });

  it('sendClick registra clickHistory e clickCount', () => {
    const { RubinotWin32Adapter } = require(path.join(ROOT, 'runtime', 'adapters', 'rubinot-win32.js'));
    process.env.VITEST = 'true';
    const a = new RubinotWin32Adapter({ stateFile: path.join(TMP, 'click-state.json') });
    a.sendClick(120, 240, 'left');
    a.sendClick(130, 250, 'right');
    expect(a.clickCount).toBe(2);
    expect(a.clickHistory.length).toBe(2);
    expect(a.getLearning().summary.clicks).toBe(2);
  });
});
