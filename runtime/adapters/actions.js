/**
 * T BOT — Action Layer (spec §3 architecture "ACTIONS")
 * Translates bot intents into WorldSource commands. In the real build these
 * become memory-writes / input events against the Tibia client; here they go
 * through whatever adapter is attached. Actions are fire-and-track: every
 * action returns whether the world acknowledged it (used by StuckDetector).
 */

import { distance } from '../../core/types/index.js';

const STEP = 0.9; // one tile per movement command

export class ActionLayer {
  /** @param {object} world adapter exposing move/attack/etc (SimulatedWorld or native bridge) */
  constructor(world) {
    this.world = world;
    this.lastAction = null;
    this.actionCount = 0;
  }

  _track(name, detail) {
    this.actionCount++;
    this.lastAction = { name, detail, at: Date.now() };
  }

  async moveTo(targetPos, currentPos) {
    const dx = targetPos.x - currentPos.x;
    const dy = targetPos.y - currentPos.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return { ok: true, arrived: true };
    // step diagonally toward target, one tile per axis
    const sx = Math.abs(dx) >= 1 ? Math.sign(dx) : 0;
    const sy = Math.abs(dy) >= 1 ? Math.sign(dy) : 0;
    const ok = this.world.move(sx * STEP, sy * STEP);
    this._track('MOVE', { dx: sx, dy: sy });
    return { ok, arrived: false };
  }

  async attack(targetId) {
    const r = this.world.attack(targetId);
    this._track('ATTACK', { targetId, ...r });
    return r;
  }

  async usePotion(kind) {
    const ok = kind === 'health' ? this.world.useHealthPotion() : this.world.useManaPotion();
    this._track('POTION', { kind, ok });
    return ok;
  }

  async eat() {
    const ok = this.world.eat();
    this._track('EAT', { ok });
    return ok;
  }

  async loot(corpsedId) {
    const r = this.world.lootCorpse(corpsedId);
    this._track('LOOT', { corpseId: corpsedId, ...r });
    return r;
  }

  async sell() {
    const r = this.world.sellBag();
    this._track('SELL', r);
    return r;
  }

  async deposit(amount) {
    const d = this.world.depositToBank(amount);
    this._track('DEPOSIT', { amount: d });
    return d;
  }

  async buyPotions(kind, count) {
    const n = this.world.buyPotions(kind, count);
    this._track('BUY', { kind, count: n });
    return n;
  }

  async buyAmmunition(count) {
    const n = this.world.buyAmmunition(count);
    this._track('BUY_AMMO', { count: n });
    return n;
  }

  async bless(names) {
    for (const n of names) this.world.castBless(n);
    this._track('BLESS', { names });
    return true;
  }

  async travel(destinationPos) {
    this.world.teleport(destinationPos);
    this._track('TRAVEL', destinationPos);
    return true;
  }

  async respawnHere() {
    if (this.world.respawn) this.world.respawn();
    this._track('RESPAWN', {});
    return true;
  }
}
