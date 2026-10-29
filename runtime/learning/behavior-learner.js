'use strict';

/**
 * runtime/learning/behavior-learner.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0) — BehaviorLearner
 *
 * Módulo de aprendizado por imitação: registra cliques, movimentos, teclas e
 * launches em tempo real e sintetiza dois resumos comportamentais:
 *   - comoAnda: cadência, passo médio, direções cardeais preferidas e estilo
 *     ('idle' | 'patrol' | 'direct-path');
 *   - ondeAnda: zonas 8x8 visitadas, topZone, bounds e trilha das últimas 20
 *     posições.
 *
 * O adapter Win32 delega todo registro para esta classe e mantém
 * `this.learning` sincronizado com `getSnapshot()`.
 */

const STAGE_W = 800; // espaço lógico do palco/cliente (mesmo do SVG)
const STAGE_H = 620;
const GRID = 8; // hot zones em grid 8x8

function zoneOf(x, y) {
  const zx = Math.min(GRID - 1, Math.max(0, Math.floor((Number(x) / STAGE_W) * GRID)));
  const zy = Math.min(GRID - 1, Math.max(0, Math.floor((Number(y) / STAGE_H) * GRID)));
  return `${zx}:${zy}`;
}

function directionOf(dx, dy) {
  // Convenção de tela: y cresce para baixo → N é dy negativo.
  const eps = 2;
  const north = dy <= -eps;
  const south = dy >= eps;
  const east = dx >= eps;
  const west = dx <= -eps;
  if (north && east) return 'NE';
  if (north && west) return 'NW';
  if (south && east) return 'SE';
  if (south && west) return 'SW';
  if (north) return 'N';
  if (south) return 'S';
  if (east) return 'E';
  if (west) return 'W';
  return null;
}

class BehaviorLearner {
  constructor(opts = {}) {
    this.stageW = opts.stageW || STAGE_W;
    this.stageH = opts.stageH || STAGE_H;

    this.totalClicks = 0;
    this.totalMoves = 0;
    this.totalKeys = 0;
    this.totalLaunches = 0;

    this.hotZones = {}; // "zx:zy" → contagem de cliques
    this.patterns = {}; // "button@zone" → contagem
    this.keyCounts = {}; // key → contagem

    this.lastPos = null; // última posição registrada de movimento
    this.moveTimes = []; // timestamps das últimas movimentações (cadência)
    this.trail = []; // últimas 20 posições

    this.comoAnda = {
      totalSteps: 0,
      avgStepPx: 0,
      cadencePerMin: 0,
      directions: { N: 0, S: 0, E: 0, W: 0, NE: 0, NW: 0, SE: 0, SW: 0 },
      style: 'idle',
    };

    this.ondeAnda = {
      zones: {}, // "zx:zy" → visitas de movimento
      topZone: null,
      bounds: { minX: null, maxX: null, minY: null, maxY: null },
      trail: [],
    };

    this.lastUpdate = null;
  }

  _touch(at) {
    this.lastUpdate = at || new Date().toISOString();
  }

  /** Registra um clique: incrementa totalClicks, hot zone 8x8 e padrão button@zone. */
  recordClick({ x, y, button = 'left', source = 'unknown', target = null, at = null } = {}) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: 'recordClick requer coordenadas numéricas x,y' };
    }
    const ts = at || new Date().toISOString();
    const zone = zoneOf(nx, ny);
    this.totalClicks += 1;
    this.hotZones[zone] = (this.hotZones[zone] || 0) + 1;
    const pattern = `${button}@${zone}`;
    this.patterns[pattern] = (this.patterns[pattern] || 0) + 1;
    this._touch(ts);
    return { ok: true, zone, pattern, totalClicks: this.totalClicks };
  }

  /** Registra um movimento: delta (dx,dy,dist), comoAnda (estilo/cadência) e ondeAnda. */
  recordMove({ x, y, at = null } = {}) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: 'recordMove requer coordenadas numéricas x,y' };
    }
    const ts = at || new Date().toISOString();
    const tMs = Date.parse(ts) || Date.now();

    this.totalMoves += 1;

    let dx = 0;
    let dy = 0;
    let dist = 0;
    if (this.lastPos) {
      dx = nx - this.lastPos.x;
      dy = ny - this.lastPos.y;
      dist = Math.hypot(dx, dy);
      const dir = directionOf(dx, dy);
      if (dir) this.comoAnda.directions[dir] += 1;
      this.comoAnda.totalSteps += 1;
      // média móvel do passo em px
      const prevAvg = this.comoAnda.avgStepPx;
      this.comoAnda.avgStepPx = Math.round(
        (prevAvg * (this.comoAnda.totalSteps - 1) + dist) / this.comoAnda.totalSteps
      );
    }

    // Cadência: movimentos na janela deslizante dos últimos 60s → por minuto
    this.moveTimes.push(tMs);
    if (this.moveTimes.length > 300) this.moveTimes.splice(0, this.moveTimes.length - 300);
    const windowStart = tMs - 60000;
    this.comoAnda.cadencePerMin = this.moveTimes.filter((t) => t >= windowStart).length;

    // Estilo comportamental: idle | patrol | direct-path
    const dirsTotal = Object.values(this.comoAnda.directions).reduce((a, b) => a + b, 0);
    if (this.comoAnda.totalSteps === 0 || this.comoAnda.avgStepPx < 4) {
      this.comoAnda.style = 'idle';
    } else if (dirsTotal >= 6) {
      const entries = Object.entries(this.comoAnda.directions);
      const maxDir = entries.reduce((a, b) => (b[1] > a[1] ? b : a), ['N', 0]);
      const dominantShare = maxDir[1] / Math.max(1, dirsTotal);
      this.comoAnda.style = dominantShare >= 0.65 ? 'direct-path' : 'patrol';
    } else {
      this.comoAnda.style = 'direct-path';
    }

    // ondeAnda: zonas visitadas, bounds e trilha (últimas 20 posições)
    const zone = zoneOf(nx, ny);
    this.ondeAnda.zones[zone] = (this.ondeAnda.zones[zone] || 0) + 1;
    const zn = Object.entries(this.ondeAnda.zones).sort((a, b) => b[1] - a[1])[0];
    this.ondeAnda.topZone = zn ? zn[0] : zone;

    const b = this.ondeAnda.bounds;
    b.minX = b.minX === null ? nx : Math.min(b.minX, nx);
    b.maxX = b.maxX === null ? nx : Math.max(b.maxX, nx);
    b.minY = b.minY === null ? ny : Math.min(b.minY, ny);
    b.maxY = b.maxY === null ? ny : Math.max(b.maxY, ny);

    this.trail.push({ at: ts, x: Math.round(nx), y: Math.round(ny) });
    if (this.trail.length > 20) this.trail.splice(0, this.trail.length - 20);
    this.ondeAnda.trail = this.trail.slice(-20);

    this.lastPos = { x: nx, y: ny, at: ts };
    this._touch(ts);
    return {
      ok: true,
      dx: Math.round(dx),
      dy: Math.round(dy),
      dist: Math.round(dist),
      zone,
      totalMoves: this.totalMoves,
    };
  }

  /** Registra uma tecla: incrementa totalKeys e keyCounts[key]. */
  recordKey({ key, action = 'press', method = 'ui', at = null } = {}) {
    const k = String(key || '').slice(0, 32);
    if (!k) return { ok: false, error: 'recordKey requer key' };
    const ts = at || new Date().toISOString();
    this.totalKeys += 1;
    this.keyCounts[k] = (this.keyCounts[k] || 0) + 1;
    this._touch(ts);
    return { ok: true, key: k, action, method, totalKeys: this.totalKeys };
  }

  /** Registra um launch/foco do cliente real. */
  recordLaunch({ action = 'launched', pid = null, exePath = null, at = null } = {}) {
    const ts = at || new Date().toISOString();
    this.totalLaunches += 1;
    this._touch(ts);
    return { ok: true, action, pid, exePath, totalLaunches: this.totalLaunches };
  }

  /** Snapshot completo do aprendizado (fonte única para GET /api/learning). */
  getSnapshot() {
    return {
      totalClicks: this.totalClicks,
      totalMoves: this.totalMoves,
      totalKeys: this.totalKeys,
      totalLaunches: this.totalLaunches,
      hotZones: this.hotZones,
      patterns: this.patterns,
      keyCounts: this.keyCounts,
      comoAnda: this.comoAnda,
      ondeAnda: this.ondeAnda,
      lastUpdate: this.lastUpdate,
    };
  }
}

module.exports = { BehaviorLearner, zoneOf, directionOf };
