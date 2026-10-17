/**
 * T BOT — Database (spec §27)
 * SQLite via node:sqlite when available (Node >=22), otherwise a JSON-file
 * repository with the exact same table semantics. Schema is written so a
 * later PostgreSQL migration is a drop-in swap (same tables/columns).
 */

import fs from 'node:fs';
import path from 'node:path';

let NativeDatabase = null;
try {
  const mod = await import('node:sqlite');
  if (mod?.DatabaseSync) NativeDatabase = mod.DatabaseSync;
} catch { /* fall back to JSON store */ }

const TABLES = [
  'profiles', 'routes', 'waypoints', 'targets', 'loot_rules', 'hotkeys',
  'sessions', 'events', 'statistics', 'death_events', 'settings',
];

export class Database {
  constructor(file = 'data/tbot.db') {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (NativeDatabase) {
      this.db = new NativeDatabase(file);
      this._initSqlite();
      this.kind = 'sqlite';
    } else {
      this.store = { _seq: 0 };
      for (const t of TABLES) this.store[t] = [];
      this._jsonPath = file.endsWith('.db') ? file.replace(/\.db$/, '.json') : file + '.json';
      if (fs.existsSync(this._jsonPath)) {
        try { Object.assign(this.store, JSON.parse(fs.readFileSync(this._jsonPath, 'utf8'))); } catch {}
      }
      this.kind = 'json';
    }
  }

  _initSqlite() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY, name TEXT UNIQUE, data TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS routes(id INTEGER PRIMARY KEY, profile TEXT, name TEXT, data TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS waypoints(id INTEGER PRIMARY KEY, route_id INTEGER, idx INTEGER, type TEXT, x INTEGER, y INTEGER, z INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS targets(id INTEGER PRIMARY KEY, profile TEXT, name TEXT, priority INTEGER, max_distance INTEGER, chase INTEGER, avoid INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS loot_rules(id INTEGER PRIMARY KEY, profile TEXT, item_id INTEGER, name TEXT, action TEXT, value INTEGER, priority INTEGER);
      CREATE TABLE IF NOT EXISTS hotkeys(id INTEGER PRIMARY KEY, profile TEXT, slot TEXT, action TEXT, condition TEXT, enabled INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, session_id TEXT UNIQUE, character TEXT, start_time INTEGER, end_time INTEGER, level_start INTEGER, level_end INTEGER, xp_start INTEGER, xp_end INTEGER, loot_start INTEGER, loot_end INTEGER, deaths INTEGER, runtime_ms INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, timestamp INTEGER, session_id TEXT, type TEXT, state TEXT, x INTEGER, y INTEGER, z INTEGER, payload TEXT);
      CREATE TABLE IF NOT EXISTS statistics(id INTEGER PRIMARY KEY, session_id TEXT, key TEXT, value REAL);
      CREATE TABLE IF NOT EXISTS death_events(id INTEGER PRIMARY KEY, timestamp INTEGER, session_id TEXT, location TEXT, level INTEGER, cause TEXT, route TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  _flush() {
    if (this.kind !== 'json') return;
    if (this.closed) return; // avoid writes during/after teardown (prevents unhandled rejections in Vitest)
    try {
      fs.mkdirSync(path.dirname(this._jsonPath), { recursive: true });
      fs.writeFileSync(this._jsonPath, JSON.stringify(this.store));
    } catch {}
  }

  insert(table, row) {
    if (this.kind === 'sqlite') {
      const cols = Object.keys(row);
      const stmt = this.db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      );
      stmt.run(...cols.map(c => typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
      return { id: Number(stmt.lastInsertRowid ?? 0) };
    }
    const id = ++this.store._seq;
    this.store[table].push({ id, ...row });
    this._flush();
    return { id };
  }

  all(table, filter = {}) {
    if (this.kind === 'sqlite') {
      const keys = Object.keys(filter);
      const sql = `SELECT * FROM ${table}` + (keys.length ? ` WHERE ${keys.map(k => `${k}=?`).join(' AND ')}` : '');
      const rows = this.db.prepare(sql).all(...keys.map(k => filter[k]));
      return rows.map(r => this._parseJsonFields(r));
    }
    return (this.store[table] || []).filter(row =>
      Object.entries(filter).every(([k, v]) => row[k] === v)
    );
  }

  _parseJsonFields(r) {
    const out = { ...r };
    for (const k of ['data', 'payload', 'condition', 'value']) {
      if (typeof out[k] === 'string' && /^[[{"]/.test(out[k])) {
        try { out[k] = JSON.parse(out[k]); } catch {}
      }
    }
    return out;
  }

  saveSession(session) {
    return this.insert('sessions', {
      session_id: session.sessionId, character: session.character,
      start_time: session.startTime, end_time: session.endTime,
      level_start: session.levelStart, level_end: session.levelEnd,
      xp_start: session.xpStart, xp_end: session.xpEnd,
      loot_start: session.lootStart, loot_end: session.lootEnd,
      deaths: session.deaths, runtime_ms: session.runtimeMs,
    });
  }

  saveEvent(e) {
    return this.insert('events', {
      timestamp: e.timestamp, session_id: e.sessionId, type: e.type, state: e.state,
      x: e.position?.x ?? null, y: e.position?.y ?? null, z: e.position?.z ?? null,
      payload: e.payload,
    });
  }

  saveDeath(death, sessionId) {
    return this.insert('death_events', {
      timestamp: Date.now(), session_id: sessionId,
      location: death.location, level: death.level, cause: death.cause, route: death.route,
    });
  }

  close() {
    if (this.kind === 'sqlite') this.db.close();
    else { this._flush(); this.closed = true; }
  }
}
