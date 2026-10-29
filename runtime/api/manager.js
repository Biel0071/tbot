'use strict';

/**
 * runtime/api/manager.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0) — RuntimeManager
 *
 * Orquestra o adapter Win32 do RubinOT Client e expõe:
 *   - launchClient()      → POST /api/client/launch  (abre ou foca o cliente real)
 *   - sendClientClick()   → POST /api/client/click   (registra cliques + aprendizado)
 *   - getLearning()       → GET  /api/learning       (telemetria de aprendizado)
 *   - getClientFrame()    → GET  /api/client/frame   (PNG real ou SVG determinístico)
 */

const fs = require('fs');
const path = require('path');
const { RubinotWin32Adapter } = require('../adapters/rubinot-win32');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

class RuntimeManager {
  constructor(opts = {}) {
    this.startedAt = new Date().toISOString();
    this.dataDir = opts.dataDir || DATA_DIR;
    this.adapter = new RubinotWin32Adapter({
      stateFile: opts.stateFile || path.join(this.dataDir, 'rubinot_win32_state.json'),
    });
    this.events = [];
    this.logFile = opts.logFile || path.join(this.dataDir, 'runtime-live.log');
    this.status = 'idle'; // idle | running | paused | error
    // Módulos do agente autônomo (expostos em GET /api/status e controláveis
    // via POST /api/control { cmd:'modules', payload:{...} })
    this.modules = {
      autoHeal: true,
      manaRestore: true,
      autoAttack: true,
      cavebot: true,
      autoLoot: true,
      autoEat: true,
      autoRefill: true,
      win32Input: true,
    };
    this._lastScanMs = 0;
    this._persistStatus();
  }

  _nowIso() {
    return new Date().toISOString();
  }

  _emit(type, payload = {}) {
    const ev = { at: this._nowIso(), type, ...payload };
    this.events.push(ev);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${ev.at} [${type}] ${JSON.stringify(payload)}\n`);
    } catch (_e) {
      /* log é best-effort */
    }
    return ev;
  }

  _persistStatus() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.dataDir, 'runtime-status.json'),
        JSON.stringify(
          {
            product: 'T BOT — Autonomous Tibia Bot (MVP 1.0)',
            port: 8791,
            startedAt: this.startedAt,
            updatedAt: this._nowIso(),
            status: this.status,
            client: this.adapter.client,
            clickCount: this.adapter.clickCount,
          },
          null,
          2
        )
      );
    } catch (_e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- status ---

  getStatus() {
    // Fora do Vitest: re-scan em tempo real (throttle 1.5s) para refletir com
    // honestidade se o cliente abriu ou fechou — nunca estado cacheado antigo.
    if (process.env.VITEST !== 'true' && Date.now() - (this._lastScanMs || 0) > 1500) {
      this._lastScanMs = Date.now();
      try {
        this.adapter.scanClient();
      } catch (_e) {
        /* scan best-effort; status continua respondendo */
      }
    }
    return {
      ok: true,
      product: 'T BOT — Autonomous Tibia Bot (MVP 1.0)',
      version: '1.0.0',
      startedAt: this.startedAt,
      status: this.status,
      bot: this.status === 'idle' ? 'stopped' : this.status,
      state: this.status.toUpperCase(),
      modules: this.modules,
      learning: this.adapter.getLearning().summary,
      client: this.adapter.client,
      counters: {
        clicks: this.adapter.clickCount,
        moves: this.adapter.learning.totalMoves,
        keys: this.adapter.learning.totalKeys,
        launches: this.adapter.learning.totalLaunches,
      },
      recentEvents: this.events.slice(-25),
    };
  }

  scanClient() {
    const client = this.adapter.scanClient();
    this._emit('client-scan', { detected: client.detected, pid: client.pid });
    this._persistStatus();
    return client;
  }

  // ------------------------------------------------- launch / focus -----

  /**
   * POST /api/client/launch — abre o RubinOT Client real se fechado,
   * ou foca a janela se já estiver aberto. Sempre responde ok:true no modo
   * simulado (VITEST==='true').
   */
  launchClient(body = {}) {
    const result = this.adapter.launchClient();
    this.status = result.ok ? 'running' : 'error';
    this._emit('client-launch', {
      action: result.action,
      ok: result.ok,
      source: body.source || 'center-logo',
      preview: !!result.preview,
    });
    this._persistStatus();
    return result;
  }

  // ------------------------------------------------------ click input ----

  /**
   * POST /api/client/click — registra clique (x,y,button) em tempo real,
   * alimenta clickHistory/clickCount e o módulo de aprendizado.
   */
  sendClientClick(body = {}) {
    if (body.action === 'abrir-jogo') {
      const r = this.adapter.sendText('', { action: 'abrir-jogo' });
      this._emit('client-click', { x: 620, y: 530, button: 'left', action: 'abrir-jogo' });
      this._persistStatus();
      return { ...r, learning: this.adapter.getLearning().summary };
    }
    const x = body.x !== undefined ? body.x : body.clientX;
    const y = body.y !== undefined ? body.y : body.clientY;
    const button = body.button || 'left';
    const result = this.adapter.sendClick(x, y, button, {
      relX: body.relX,
      relY: body.relY,
      source: body.source || 'live-frame',
      target: body.target,
    });
    if (result.ok) {
      this._emit('client-click', { x: result.click.x, y: result.click.y, button: result.click.button });
      this._persistStatus();
      return { ...result, learning: this.adapter.getLearning().summary };
    }
    return { ok: false, status: 400, error: result.error || 'clique inválido' };
  }

  registerMove(body = {}) {
    const r = this.adapter.registerMove(body.x, body.y);
    if (r.ok && this.adapter.learning.totalMoves % 20 === 0) {
      this._emit('mouse-move', { total: r.moveCount });
    }
    return r;
  }

  registerKey(body = {}) {
    const r = this.adapter.registerKey(body.key, {
      masked: Boolean(body.masked),
      deliver: body.deliver,
      method: body.method || 'ui',
    });
    if (r.ok) this._emit('key-press', { key: body.masked ? '*' : body.key, total: r.keyCount, delivered: r.delivered });
    return r;
  }

  sendClientText(body = {}) {
    const r = this.adapter.sendText(body.text || '', {
      field: body.field,
      masked: Boolean(body.masked || body.field === 'password'),
      submit: Boolean(body.submit),
      clear: body.clear,
      action: body.action,
    });
    if (r.ok) {
      this._emit('client-type', { field: r.field, length: r.length, delivered: r.delivered });
      this._persistStatus();
    }
    return r;
  }

  // --------------------------------------------------------- learning ----

  /**
   * GET /api/learning — telemetria de cliques/movimentos/teclas e padrões
   * aprendidos em tempo real.
   */
  getLearning() {
    return this.adapter.getLearning();
  }

  // ------------------------------------------------------------ frame ----

  /**
   * GET /api/client/frame — imagem atual do cliente:
   *  - VITEST==='true': SVG determinístico (não quebra testes existentes)
   *  - fora do Vitest: PNG real (PrintWindow/CopyFromScreen/screenshots) com fallback SVG
   */
  getClientFrame() {
    const frame = this.adapter.captureFrame();
    return {
      contentType: frame.contentType,
      body: frame.body,
      source: frame.source,
      meta: {
        seq: this.adapter.frameCounter,
        clickCount: this.adapter.clickCount,
        detected: this.adapter.client.detected,
      },
    };
  }

  // -------------------------------------------------------- bot control ---

  startAgent() {
    this.status = 'running';
    this._emit('agent-start', {});
    this._persistStatus();
    return { ok: true, status: this.status };
  }

  stopAgent() {
    this.status = 'idle';
    this._emit('agent-stop', {});
    this._persistStatus();
    return { ok: true, status: this.status };
  }

  pauseAgent() {
    this.status = 'paused';
    this._emit('agent-pause', {});
    this._persistStatus();
    return { ok: true, status: this.status };
  }

  /**
   * POST /api/control — comando unificado do agente:
   * cmd ∈ start | stop | pause | launch | scan | click | key | modules
   */
  control(body = {}) {
    const cmd = String(body.cmd || body.action || '').toLowerCase();
    const payload = body.payload || body.args || {};
    switch (cmd) {
      case 'start':
        return { ok: true, cmd, result: this.startAgent() };
      case 'stop':
        return { ok: true, cmd, result: this.stopAgent() };
      case 'pause':
        return { ok: true, cmd, result: this.pauseAgent() };
      case 'launch':
        return { ok: true, cmd, result: this.launchClient(payload) };
      case 'scan':
        return { ok: true, cmd, result: this.scanClient() };
      case 'click':
        return { ok: true, cmd, result: this.sendClientClick(payload) };
      case 'key':
        return { ok: true, cmd, result: this.registerKey(payload) };
      case 'type':
        return { ok: true, cmd, result: this.sendClientText(payload) };
      case 'move':
        return { ok: true, cmd, result: this.registerMove(payload) };
      case 'restart':
        setTimeout(() => process.exit(0), 120).unref();
        return { ok: true, cmd, message: 'restarting server' };
      case 'modules': {
        if (payload && typeof payload === 'object') {
          for (const k of Object.keys(this.modules)) {
            if (typeof payload[k] === 'boolean') this.modules[k] = payload[k];
          }
        }
        this._emit('modules-update', { modules: this.modules });
        return { ok: true, cmd, modules: this.modules };
      }
      default:
        return {
          ok: false,
          status: 400,
          error: `comando desconhecido: '${cmd || '(vazio)'}'`,
          allowed: ['start', 'stop', 'pause', 'launch', 'scan', 'click', 'key', 'move', 'modules'],
        };
    }
  }
}

module.exports = { RuntimeManager };
