/**
 * T BOT — Loot Engine (spec §12)
 * Corpse looting driven by loot rules (KEEP/SELL/DEPOSIT/IGNORE/ALERT),
 * with capacity awareness and per-session accounting.
 */

import { distance } from '../../core/types/index.js';

export class LootEngine {
  /** @param {LootRule[]} rules e.g. [{itemId:123,name:'Dragon Ham',action:'SELL'}] */
  constructor(rules = [], defaults = { action: 'KEEP' }) {
    this.rules = rules;
    this.defaults = defaults;
    this.collected = 0;
    this.ignored = 0;
    this.valueGained = 0;
  }

  ruleFor(item) {
    return this.rules.find(r =>
      (r.itemId && r.itemId === item.itemId) ||
      (r.name && r.name.toLowerCase() === String(item.name).toLowerCase())
    ) || { action: this.defaults.action };
  }

  shouldPickup(item) {
    const a = this.ruleFor(item).action;
    return a !== 'IGNORE';
  }

  /** Find nearest unlooted corpse in the snapshot (real distance from perception) */
  nextCorpse(snapshot) {
    const corpses = (snapshot.containers || []).filter(c => /corpse/i.test(c.name));
    if (!corpses.length) return null;
    return corpses
      .map(c => ({ ...c, dist: c.position ? distance(snapshot.position, c.position) : 0 }))
      .sort((a, b) => a.dist - b.dist)[0];
  }

  /**
   * Attempt to loot the nearest corpse. If it is out of reach we walk to it
   * first — looting always happens at the corpse tile, never remotely.
   * Returns outcome for telemetry/stats.
   */
  async lootNearest(snapshot, actions) {
    const corpse = this.nextCorpse(snapshot);
    if (!corpse) return { ok: false, reason: 'no_corpse' };
    if (corpse.position && distance(snapshot.position, corpse.position) > 1.5) {
      const r = await actions.moveTo(corpse.position, snapshot.position);
      return { ok: true, approaching: true, arrived: !!r.arrived };
    }
    const res = await actions.loot(corpse.id);
    if (!res.ok) return res;
    // value accounting uses real items that entered the bag
    const picked = res.items ?? 0;
    this.collected += picked;
    if (res.full) this.lastFullAt = Date.now();
    return res;
  }

  creditSold(items) {
    for (const it of items) {
      const v = it.value ?? 0;
      this.valueGained += v;
    }
  }

  stats() {
    return { collected: this.collected, ignored: this.ignored, valueGained: this.valueGained };
  }
}
