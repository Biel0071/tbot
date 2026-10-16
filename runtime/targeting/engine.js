/**
 * T BOT — Target Engine (spec §10, §11)
 * Priority-based target selection from the battle list. Pure decision code:
 * input = GameSnapshot + config, output = chosen creature or none.
 */

import { distance } from '../../core/types/index.js';

export class TargetEngine {
  /** @param {TargetRule[]} rules e.g. [{name:'Dragon',priority:80,maxDistance:7,chase:true,avoid:false}] */
  constructor(rules = []) {
    this.rules = rules.map(r => ({
      priority: 50, maxDistance: 7, chase: true, avoid: false, danger: 0, ...r,
    }));
    this.currentTarget = null;
    this.lostSince = null;
  }

  ruleFor(name) {
    return this.rules.find(r => r.name.toLowerCase() === String(name).toLowerCase());
  }

  /** Spec §11: distance, HP, priority, danger, count, position, LoS, user config */
  select(snapshot) {
    const candidates = (snapshot.battleList || [])
      .filter(c => c.type === 'monster' && c.hp > 0 && c.visible)
      .map(c => {
        const rule = this.ruleFor(c.name);
        if (!rule || rule.avoid) return null;
        const d = distance(snapshot.position, c.position);
        if (d > rule.maxDistance) return null;
        const hpFactor = 1 - (c.hp / c.maxHp) * 0.25;           // prefer wounded
        const distFactor = Math.max(0.7, 1 - d * 0.03);          // mild proximity bias
        // priority dominates (spec §10/§11: high-priority creature wins over a
        // slightly closer low-priority one); distance & HP act as tie-breakers
        const score = Math.round(rule.priority * hpFactor * distFactor + (7 - Math.min(d, 7)) * 0.5);
        return { creature: c, score, rule, distance: d };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] ?? null;

    if (best) {
      const same = this.currentTarget && this.currentTarget.id === best.creature.id;
      if (!same) {
        this.currentTarget = best.creature;
        this.lostSince = null;
      } else {
        // keep reference updated with latest snapshot data
        this.currentTarget = best.creature;
      }
      return { target: best.creature, score: best.score, rule: best.rule, distance: best.distance };
    }

    // current target lost/dead?
    if (this.currentTarget) {
      const still = (snapshot.battleList || []).find(c => c.id === this.currentTarget.id && c.hp > 0);
      if (!still) { this.currentTarget = null; this.lostSince = Date.now(); }
    }
    return { target: null };
  }

  clear() { this.currentTarget = null; }
}
