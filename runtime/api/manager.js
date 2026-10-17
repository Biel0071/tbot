/**
 * T BOT — Runtime Manager + Watchdog (spec §29, §30)
 * Owns the real BotEngine process-level lifecycle: start/stop/pause/resume/
 * restart, heartbeat, health and crash recovery. Watchdog never blind-resumes:
 * it restores session data, validates game state, then resumes safely.
 */

import { BotEngine } from '../bot-engine/engine.js';
import { Database } from '../../core/database/db.js';
import { ProfileManager } from '../../core/profiles/manager.js';
import { SimulatedWorld, MemoryReaderSource } from '../perception/engine.js';

export class RuntimeManager {
  constructor({ profilesRoot = 'profiles', dataFile = 'data/tbot.db', worldFactory = null } = {}) {
    this.profiles = new ProfileManager(profilesRoot);
    this.db = new Database(dataFile);
    this.engine = null;
    this.profile = null;
    this.worldFactory = worldFactory; // () => WorldSource ; defaults to simulated world
    this.startedAt = null;
    this.lastHeartbeat = null;
    this.errors = 0;
    this.crashLog = [];
    this._watchdog = null;
    this.listeners = new Set();
  }

  /** attach a real Tibia memory reader instead of the simulation */
  useRealAdapter(opts) {
    this.worldFactory = () => new MemoryReaderSource(opts);
  }

  loadProfile(name) {
    if (!this.profiles.exists(name)) this.profiles.create(name);
    this.profile = this.profiles.load(name);
    this._emit({ type: 'PROFILE_LOADED', name });
    return this.profile;
  }

  _makeWorld() {
    if (this.worldFactory) return this.worldFactory();
    return new SimulatedWorld({ playerName: this.profile?.settings?.name ?? 'Bot' });
  }

  async start(profileName) {
    if (this.engine?.machine.running) throw new Error('Runtime already running');
    if (profileName) this.loadProfile(profileName);
    if (!this.profile) this.loadProfile(this.profiles.list()[0] ?? 'character-1');

    const world = this._makeWorld();
    this.engine = new BotEngine({
      profile: this.profile,
      world,
      db: this.db,
      tickMs: 40,
      onEvent: (e) => this._emit(e),
    });
    const session = await this.engine.start();
    this.startedAt = Date.now();
    this.lastHeartbeat = Date.now();
    this._startWatchdog();
    this._emit({ type: 'RUNTIME_ONLINE', sessionId: session.sessionId });
    return session;
  }

  async stop() {
    if (!this.engine) return { stopped: false };
    await this.engine.stop();
    this._stopWatchdog();
    this._emit({ type: 'RUNTIME_OFFLINE' });
    return { stopped: true, session: this.db.all('sessions').at(-1) ?? null };
  }

  async pause() { await this.engine?.pause(); this._emit({ type: 'BOT_PAUSED' }); }
  async resume() { await this.engine?.resume(); this._emit({ type: 'BOT_RESUMED' }); }

  async restart() {
    await this.stop().catch(() => {});
    return this.start();
  }

  health() {
    return {
      runtime: this.engine ? 'online' : 'offline',
      bot: this.engine ? this.engine.health().bot : 'stopped',
      state: this.engine?.machine.current ?? 'OFFLINE',
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      lastHeartbeat: this.lastHeartbeat,
      errors: this.errors,
    };
  }

  status() {
    if (!this.engine) return { ...this.health(), navigation: null, snapshot: null, statistics: {}, debug: {} };
    return { ...this.health(), ...this.engine.health() };
  }

  _emit(evt) {
    for (const l of this.listeners) { try { l(evt); } catch {} }
  }

  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /* ---------------- Watchdog (§30) ---------------- */
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      try {
        const h = this.engine?.health();
        if (!h) return;
        const stale = Date.now() - (this.lastHeartbeat ?? 0) > 15_000;
        const perceptionDown = h.perception && !h.perception.ok && this.engine.machine.running;
        if (stale || perceptionDown) {
          this.errors++;
          this.crashLog.push({ at: Date.now(), reason: stale ? 'heartbeat_stale' : 'perception_failure' });
          this._emit({ type: 'WATCHDOG_TRIP', reason: stale ? 'heartbeat_stale' : 'perception_failure' });
          this._safeRestart();
        } else {
          this.lastHeartbeat = Date.now();
        }
      } catch (err) {
        this.errors++;
        this.crashLog.push({ at: Date.now(), reason: err.message });
        this._safeRestart();
      }
    }, 5000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _stopWatchdog() { if (this._watchdog) clearInterval(this._watchdog); this._watchdog = null; }

  /** crash recovery: save state → restart → restore session → validate → safe resume */
  async _safeRestart() {
    this._stopWatchdog();
    try { await this.engine?.stop(); } catch {}
    // validate game state before resuming automation (§30)
    const world = this._makeWorld();
    let snap = null;
    try { snap = await world.readState(); } catch { snap = null; }
    if (!snap || snap.level <= 0 || snap.dead) {
      this._emit({ type: 'WATCHDOG_HOLD', reason: 'unsafe_state_not_resuming' });
      return; // do NOT auto-execute in unknown state
    }
    this.engine = new BotEngine({
      profile: this.profile, world, db: this.db, tickMs: 40,
      onEvent: (e) => this._emit(e),
    });
    await this.engine.start();
    this.lastHeartbeat = Date.now();
    this._startWatchdog();
    this._emit({ type: 'WATCHDOG_RESTARTED' });
  }

  close() {
    this._stopWatchdog();
    // Stop the engine tick loop BEFORE closing the DB so no in-flight tick
    // writes to a closed database (avoids unhandled rejections on teardown).
    if (this.engine?.machine) this.engine.machine.running = false;
    this.db.close();
  }
}
