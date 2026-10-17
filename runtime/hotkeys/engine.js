/**
 * T BOT — Hotkey Engine (spec §13) + Resource Manager (spec §14)
 * Conditional hotkeys evaluated every tick against the real snapshot.
 */

export class HotkeyEngine {
  /**
   * @param {Array} defs [{slot:'F1', action:'potion_health', condition:{field:'hpPercent',op:'<',value:60}}]
   * @param {object} actions ActionLayer
   */
  constructor(defs = [], actions) {
    this.defs = defs.map(d => ({ enabled: true, cooldownMs: 800, ...d, _lastUsed: 0 }));
    this.actions = actions;
    this.fired = {};
  }

  static defaultSet() {
    return [
      { slot: 'F1', action: 'potion_health', condition: { field: 'hpPercent', op: '<', value: 60 } },
      { slot: 'F2', action: 'potion_mana',   condition: { field: 'manaPercent', op: '<', value: 30 } },
      { slot: 'F3', action: 'eat',           condition: { field: 'food', op: '<', value: 10 } },
    ];
  }

  _resolveField(snapshot, field) {
    if (field in snapshot) return snapshot[field];
    const inv = (snapshot.inventory || []).find(i => i.name === field);
    if (inv) return inv.count;
    const alias = {
      healthPotion: 'healthPotion', manaPotion: 'manaPotion', spear: 'spear', food: 'food',
    }[field];
    if (alias) {
      const it = (snapshot.inventory || []).find(i => i.name === alias);
      return it ? it.count : 0;
    }
    return undefined;
  }

  _condOk(cond, snapshot) {
    if (!cond) return true;
    const v = this._resolveField(snapshot, cond.field);
    if (v === undefined) return false;
    switch (cond.op) {
      case '<':  return v <  cond.value;
      case '<=': return v <= cond.value;
      case '>':  return v >  cond.value;
      case '>=': return v >= cond.value;
      case '==': return v === cond.value;
      default: return false;
    }
  }

  async apply(snapshot) {
    const now = Date.now();
    const firedNow = [];
    for (const hk of this.defs) {
      if (!hk.enabled) continue;
      if (now - hk._lastUsed < hk.cooldownMs) continue;
      if (!this._condOk(hk.condition, snapshot)) continue;
      hk._lastUsed = now;
      this.fired[hk.slot] = (this.fired[hk.slot] || 0) + 1;
      firedNow.push(hk.slot);
      switch (hk.action) {
        case 'potion_health': await this.actions.usePotion('health'); break;
        case 'potion_mana':   await this.actions.usePotion('mana'); break;
        case 'eat':           await this.actions.eat(); break;
        default: break; // spell/rune actions route through combat layer in real build
      }
    }
    return firedNow;
  }
}

/** Resource Manager (spec §14): thresholds that trigger REFILL / SELL / EMERGENCY */
export class ResourceManager {
  constructor(config = {}) {
    this.cfg = {
      minHpPercent: 60,
      minManaPercent: 30,
      minPotions: 30,
      minAmmunition: 50,
      minFood: 10,
      maxCapacity: 85,
      emergencyHpPercent: 30,
      emergencyDanger: 4,
      ...config,
    };
  }

  evaluate(snapshot) {
    const inv = Object.fromEntries((snapshot.inventory || []).map(i => [i.name, i.count]));
    const needs = {
      refill: false, sell: false, bank: false, emergency: false, warning: null,
    };
    if ((inv.healthPotion ?? 999) < this.cfg.minPotions ||
        (inv.manaPotion ?? 999) < this.cfg.minPotions ||
        (inv.spear ?? 999) < this.cfg.minAmmunition ||
        (inv.food ?? 999) < this.cfg.minFood) {
      needs.refill = true;
      needs.warning = 'supplies low';
    }
    if (snapshot.capacity >= this.cfg.maxCapacity) {
      needs.sell = true;
      needs.warning = `capacity ${snapshot.capacity}%`;
    }
    if (snapshot.hpPercent < this.cfg.emergencyHpPercent && (inv.healthPotion ?? 0) <= 0) {
      needs.emergency = true;
    }
    if (snapshot.dangerLevel >= this.cfg.emergencyDanger) needs.emergency = true;
    if (snapshot.hpPercent < this.cfg.minHpPercent) needs.warning = needs.warning ?? 'hp below threshold';
    return needs;
  }
}
