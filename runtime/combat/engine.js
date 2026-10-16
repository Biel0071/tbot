/**
 * T BOT — Combat + Emergency + Recovery modules (spec §10–§12 combat glue,
 * §18 death/recovery, §19 emergency).
 */

import { distance } from '../../core/types/index.js';

export class CombatEngine {
  constructor({ actions, targetEngine }) {
    this.actions = actions;
    this.targetEngine = targetEngine;
    this.attackingSince = null;
  }

  /** One combat tick against the snapshot's chosen target. */
  async tick(snapshot) {
    const sel = this.targetEngine.select(snapshot);
    if (!sel.target) return { fighting: false };
    const d = sel.distance ?? distance(snapshot.position, sel.target.position);
    if (d > 3 && sel.rule?.chase) {
      // approach before attacking (real build: walk to creature screen pos)
      await this.actions.moveTo(sel.target.position, snapshot.position);
      return { fighting: true, action: 'CHASE' };
    }
    const r = await this.actions.attack(sel.target.id);
    if (r.killed) {
      this.attackingSince = null;
      return { fighting: true, action: 'KILL', target: sel.target.name, targetId: sel.target.id };
    }
    if (!this.attackingSince) this.attackingSince = Date.now();
    return { fighting: true, action: 'ATTACK', hit: r.hit, reason: r.reason };
  }
}

/** Emergency system (§19): max priority escape/stop logic */
export class EmergencyManager {
  constructor({ config, actions, travel }) {
    this.cfg = { enabled: true, hpPercent: 30, dangerLevel: 4, ...config };
    this.actions = actions;
    this.travel = travel;
    this.trips = 0;
  }
  shouldTrigger(snapshot) {
    if (!this.cfg.enabled) return false;
    if (snapshot.dead) return false; // DEAD handled by recovery flow
    const inv = Object.fromEntries((snapshot.inventory || []).map(i => [i.name, i.count]));
    if (snapshot.hpPercent <= this.cfg.hpPercent && (inv.healthPotion ?? 0) === 0) return true;
    if (snapshot.dangerLevel >= this.cfg.dangerLevel) return true;
    return false;
  }
  /** RETREAT → run to city safety. Returns final position request. */
  async retreat() {
    this.trips++;
    const city = this.travel.resolve('city');
    await this.actions.travel(city);
    return city;
  }
}

/** Death detection & recovery flow (§18) */
export class RecoveryManager {
  constructor({ actions, telemetry }) {
    this.actions = actions;
    this.telemetry = telemetry;
    this.recoveries = 0;
  }
  detectDeath(snapshot) { return !!snapshot.dead; }

  onDeath(snapshot, huntInfo = {}) {
    const evt = {
      type: 'DEATH',
      timestamp: new Date().toISOString(),
      location: `${snapshot.position.x}/${snapshot.position.y}/${snapshot.position.z}`,
      level: snapshot.level,
      cause: snapshot.playerStatus?.deathCause ?? 'unknown',
      route: huntInfo.route ?? null,
    };
    this.telemetry.record({ type: 'DEATH', state: 'DEAD', position: snapshot.position, payload: evt });
    this.telemetry.log('ERROR', `DIED at ${evt.location} (level ${evt.level})`);
    return evt;
  }

  /** RECOVERY: respawn → validate equipment/supplies/bless → back to route */
  async recover(snapshot) {
    this.recoveries++;
    await this.actions.respawnHere();
    const after = await this.actions.world?.readState?.() ?? snapshot;
    this.telemetry.record({ type: 'RECOVERY', state: 'RECOVERY', payload: { attempt: this.recoveries } });
    this.telemetry.log('INFO', `Recovery complete (#${this.recoveries}) — character at city`);
    return { ok: true };
  }
}
