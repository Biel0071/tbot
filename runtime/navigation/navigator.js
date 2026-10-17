/**
 * T BOT — Navigation / Cavebot (spec §7–§9)
 * Routes, waypoints, navigator, pathfinder (per-tile stepping), stuck detector
 * and recovery. Route files follow the spec §8 JSON schema.
 */

import { WaypointTypes, distance } from '../../core/types/index.js';

export class Route {
  constructor(def) {
    if (!def?.route) throw new Error('Route requires a name');
    this.name = def.route;
    this.loop = !!def.loop;
    this.waypoints = (def.waypoints || []).map((w, i) => ({ index: i, ...w }));
    if (!this.waypoints.length) throw new Error('Route requires waypoints');
  }
  static fromJSON(json) { return new Route(typeof json === 'string' ? JSON.parse(json) : json); }
  toJSON() { return { route: this.name, loop: this.loop, waypoints: this.waypoints }; }
}

/** Stuck detector per spec §9: no progress for N ms → recalc → still stuck → recovery */
export class StuckDetector {
  constructor({ patienceMs = 5000, maxRecalcs = 3 } = {}) {
    this.patienceMs = patienceMs;
    this.maxRecalcs = maxRecalcs;
    this.lastPos = null;
    this.lastChangeAt = Date.now();
    this.recalcCount = 0;
  }
  observe(pos) {
    const now = Date.now();
    if (!this.lastPos || pos.x !== this.lastPos.x || pos.y !== this.lastPos.y) {
      this.lastPos = { ...pos };
      this.lastChangeAt = now;
      this.recalcCount = 0;
      return { stuck: false };
    }
    if (now - this.lastChangeAt > this.patienceMs) {
      // consume one recalc budget per patience window (not per tick),
      // so escalation to recovery happens after maxRecalcs windows (§9)
      this.lastChangeAt = now;
      this.recalcCount++;
      if (this.recalcCount > this.maxRecalcs) return { stuck: true, needRecovery: true };
      return { stuck: true, needRecovery: false }; // recalculate path
    }
    return { stuck: false };
  }
  reset() { this.lastPos = null; this.lastChangeAt = Date.now(); this.recalcCount = 0; }
}

export class Navigator {
  /**
   * @param {object} deps { actions, perception, telemetry }
   */
  constructor(deps) {
    this.actions = deps.actions;
    this.perception = deps.perception;
    this.telemetry = deps.telemetry;
    this.route = null;
    this.wpIndex = 0;
    this.stuck = new StuckDetector({ patienceMs: deps.stuckPatienceMs ?? 5000 });
    this.recoveryAttempts = 0;
  }

  loadRoute(route) {
    this.route = route instanceof Route ? route : Route.fromJSON(route);
    this.wpIndex = 0;
    this.stuck.reset();
    this.telemetry?.log('INFO', `Route loaded: ${this.route.name} (${this.route.waypoints.length} waypoints)`);
    return this.route;
  }

  currentWaypoint() {
    if (!this.route) return null;
    if (this.wpIndex >= this.route.waypoints.length) {
      if (!this.route.loop) return null;
      this.wpIndex = 0;
    }
    return this.route.waypoints[this.wpIndex];
  }

  advance() {
    this.wpIndex++;
    this.stuck.reset();
    if (this.route?.loop && this.wpIndex >= this.route.waypoints.length) this.wpIndex = 0;
  }

  /** Move toward a point with stuck detection + recovery (§9). */
  async walkTo(targetPos) {
    const snap = await this.perception.snapshot();
    const d = distance(snap.position, targetPos);
    if (d < 1) return { ok: true, arrived: true };

    const chk = this.stuck.observe(snap.position);
    if (chk.stuck) {
      if (chk.needRecovery) {
        this.recoveryAttempts++;
        this.telemetry?.record({ type: 'STUCK', state: 'NAVIGATE', payload: { attempts: this.recoveryAttempts } });
        this.telemetry?.log('WARNING', `Stuck detected — recovery maneuver #${this.recoveryAttempts}`);
        // recovery: sidestep to break local obstruction; keep the stuck budget
        // consumed so repeated failures escalate (§9) instead of resetting.
        // The sidesteps themselves must not count as progress against THIS
        // waypoint or escalation would reset forever (root cause of the old
        // "recovery never fires" bug).
        const sx = snap.position.x, sy = snap.position.y;
        await this.actions.moveTo({ x: sx + 2, y: sy - 2 }, snap.position);
        await this.actions.moveTo({ x: sx - 2, y: sy + 2 }, { x: sx + 2, y: sy - 2, z: snap.position.z });
        // Re-baseline WITHOUT granting progress credit: reset() would clear
        // recalcCount and the detector would never escalate past recalc (§9).
        // Keep lastPos pinned to the current position so blocked movement
        // (no displacement) keeps escalating recoveryAttempts (§9).
        this.stuck.lastPos = { ...snap.position };
        this.stuck.lastChangeAt = Date.now();
        if (this.recoveryAttempts > 6) return { ok: false, reason: 'unreachable' };
        return { ok: true, arrived: false, recovering: true };
      }
      this.telemetry?.log('WARNING', 'Stuck — recalculating path');
    }

    const r = await this.actions.moveTo(targetPos, snap.position);
    return { ok: r.ok, arrived: !!r.arrived };
  }

  /** Execute one tick of the current waypoint; returns info about what happened */
  async tickWaypoint(extraHooks = {}) {
    const wp = this.currentWaypoint();
    if (!wp) return { done: true };
    switch (wp.type) {
      case WaypointTypes.WALK:
      case WaypointTypes.STAND: {
        const res = await this.walkTo({ x: wp.x, y: wp.y, z: wp.z });
        if (res.arrived) { this.advance(); return { advanced: true, wp }; }
        return { moving: true, wp, ...res };
      }
      case WaypointTypes.TRAVEL: {
        const dest = extraHooks.resolveTravel?.(wp.destination);
        if (!dest) return { done: true, error: `unknown travel destination: ${wp.destination}` };
        await this.actions.travel(dest);
        this.telemetry?.record({ type: 'TRAVEL_COMPLETED', payload: { destination: wp.destination } });
        this.advance();
        return { traveled: true, wp };
      }
      case WaypointTypes.LABEL:
      case WaypointTypes.NODE:
        this.advance();
        return { advanced: true, wp };
      case WaypointTypes.REFILL:
      case WaypointTypes.BANK:
      case WaypointTypes.SELL:
      case WaypointTypes.DEPOSIT: {
        // city-side waypoint: walk toward it; once co-located (d < 1) advance
        // so the higher-level REFILL pipeline takes over (§15).
        if (wp.x === undefined) return { actionWaypoint: true, wp };
        const res = await this.walkTo({ x: wp.x, y: wp.y, z: wp.z });
        if (res.arrived) { this.advance(); return { advanced: true, wp }; }
        return { moving: true, wp, ...res };
      }
      default:
        // ACTION/HUNT/etc are consumed by higher-level states
        return { actionWaypoint: true, wp };
    }
  }

  status() {
    const wp = this.currentWaypoint();
    return {
      route: this.route?.name ?? null,
      waypointIndex: this.wpIndex,
      total: this.route?.waypoints.length ?? 0,
      nextWaypoint: wp ? `${wp.type}@${wp.x ?? '-'}/${wp.y ?? '-'}/${wp.z ?? '-'}` : null,
      recoveryAttempts: this.recoveryAttempts,
    };
  }
}
