/**
 * T BOT — State Machine (spec §5, §41)
 * Real FSM: each state has enter/tick/exit. Transitions are explicit.
 * Stop has maximum priority (§4.2): cancels current action, runs exit hooks,
 * persists session and lands in STOPPED. No task may keep running after stop.
 */

import { BotStates, TelemetryEvents } from '../../core/types/index.js';

export class StateMachine {
  /**
   * @param {object} opts
   * @param {Map<string, BotStateDef>} opts.states
   * @param {(ev: object) => void} opts.onEvent  telemetry sink
   * @param {number} [opts.tickMs]
   */
  constructor({ states, onEvent, tickMs = 50 }) {
    this.states = states;
    this.onEvent = onEvent || (() => {});
    this.tickMs = tickMs;
    this.current = null;
    this.context = null;
    this.running = false;
    this.paused = false;
    this._timer = null;
    this._ticking = false;
    this.history = [];
  }

  register(id, def) { this.states.set(id, def); }

  async start(context, initial = BotStates.STARTING) {
    if (this.running) return;
    this.context = context;
    this.running = true;
    this.paused = false;
    await this.transition(initial);
    this._timer = setInterval(() => this._tickLoop(), this.tickMs);
    if (this._timer.unref) this._timer.unref();
  }

  async transition(nextId, reason = '') {
    const next = this.states.get(nextId);
    if (!next) throw new Error(`Unknown state: ${nextId}`);
    const prev = this.current;
    if (prev) {
      const prevDef = this.states.get(prev);
      if (prevDef?.exit) await prevDef.exit(this.context);
    }
    this.current = nextId;
    this.history.push({ state: nextId, at: Date.now(), reason });
    this.onEvent({ type: TelemetryEvents.STATE_CHANGED, state: nextId, from: prev ?? undefined, reason });
    if (next.enter) await next.enter(this.context);
  }

  async _tickLoop() {
    if (!this.running || this._ticking) return; // never overlap ticks
    this._ticking = true;
    try {
      const def = this.states.get(this.current);
      if (def?.tick && !this.paused) await def.tick(this.context);
    } catch (err) {
      this.onEvent({ type: TelemetryEvents.ERROR, message: err.message, state: this.current });
      if (this.states.get(BotStates.ERROR)) {
        await this.transition(BotStates.ERROR, err.message).catch(() => {});
      }
    } finally {
      this._ticking = false;
    }
  }

  async pause() { this.paused = true; }
  async resume() { this.paused = false; }

  /** spec §4.2 — immediate stop with max priority */
  async stop() {
    if (!this.running) return;
    const ctx = this.context;
    if (ctx?.cancelAll) ctx.cancelAll();          // cancel current action
    await this.transition(BotStates.STOPPING, 'user_stop');
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    const stopped = this.states.get(BotStates.STOPPED);
    if (stopped?.enter) await stopped.enter(ctx); // persist session happens here
    this.current = BotStates.STOPPED;
    this.onEvent({ type: TelemetryEvents.BOT_STOPPED });
  }
}
