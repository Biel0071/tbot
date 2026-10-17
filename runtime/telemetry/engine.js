/**
 * T BOT — Telemetry Engine (spec §21, §20, §22)
 * Structured events + session accounting + logs. Everything the dashboard and
 * overlay display is READ from here — never fabricated in the UI (§41).
 */

import { TelemetryEvents } from '../../core/types/index.js';

export class TelemetryEngine {
  constructor({ db = null, onRealtime = null } = {}) {
    this.db = db;
    this.onRealtime = onRealtime; // websocket broadcast hook
    this.session = null;
    this.events = [];
    this.logs = [];
    this.counters = { kills: 0, deaths: 0, lootValue: 0, xpGained: 0 };
  }

  startSession({ character, levelStart, xpStart }) {
    this.session = {
      sessionId: `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startTime: Date.now(), endTime: null,
      character, levelStart, levelEnd: levelStart,
      xpStart, xpEnd: xpStart,
      lootStart: 0, lootEnd: 0,
      deaths: 0, runtimeMs: 0,
    };
    this.log('INFO', `Session ${this.session.sessionId} started for ${character}`);
    this.record({ type: TelemetryEvents.BOT_STARTED, state: 'STARTING', payload: { ...this.session } });
    return this.session;
  }

  endSession() {
    if (!this.session) return null;
    this.session.endTime = Date.now();
    this.session.runtimeMs = this.session.endTime - this.session.startTime;
    this.record({ type: TelemetryEvents.BOT_STOPPED, payload: { ...this.session } });
    if (this.db) this.db.saveSession(this.session);
    this.log('INFO', `Session ${this.session.sessionId} ended (${fmtDuration(this.session.runtimeMs)})`);
    const s = this.session;
    this.session = null;
    return s;
  }

  updateFromSnapshot(snap) {
    if (!this.session) return;
    this.session.levelEnd = snap.level;
    if (snap.experience > this.session.xpEnd) {
      this.counters.xpGained += snap.experience - this.session.xpEnd;
    }
    this.session.xpEnd = Math.max(this.session.xpEnd, snap.experience);
    if (snap.playerStatus?.kills !== undefined) this.counters.kills = snap.playerStatus.kills;
    if (snap.playerStatus?.deaths !== undefined) this.counters.deaths = snap.playerStatus.deaths;
  }

  record(evt) {
    const e = {
      timestamp: Date.now(),
      sessionId: this.session?.sessionId ?? null,
      type: evt.type,
      state: evt.state ?? null,
      position: evt.position ?? null,
      payload: evt.payload ?? {},
    };
    this.events.push(e);
    if (this.events.length > 5000) this.events.splice(0, 1000);
    if (this.db) this.db.saveEvent(e);
    if (this.onRealtime) this.onRealtime(e);
    return e;
  }

  log(level, message) {
    const entry = { at: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 2000) this.logs.splice(0, 500);
    if (this.onRealtime) this.onRealtime({ type: 'LOG', ...entry });
    return entry;
  }

  /** Dashboard statistics block (spec §20) — all computed from real data */
  statistics() {
    const s = this.session;
    if (!s) return { active: false };
    const runtimeMs = (s.endTime ?? Date.now()) - s.startTime;
    const hours = runtimeMs / 3_600_000;
    const xp = s.xpEnd - s.xpStart;
    return {
      active: true,
      sessionId: s.sessionId,
      character: s.character,
      time: fmtDuration(runtimeMs),
      runtimeMs,
      xp: xp,
      xpPerHour: hours > 0 ? Math.round(xp / hours) : 0,
      kills: this.counters.kills,
      deaths: this.counters.deaths,
      lootValue: this.counters.lootValue,
      lootPerHour: hours > 0 ? Math.round(this.counters.lootValue / hours) : 0,
      levelStart: s.levelStart, levelEnd: s.levelEnd,
    };
  }
}

export function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
