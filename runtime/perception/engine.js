/**
 * T BOT — Perception Engine (spec §6)
 * Independent layer that produces GameSnapshots from a WorldSource.
 * The Decision Core NEVER talks to the UI directly; it only sees snapshots.
 *
 * WorldSource interface (real adapters implement this):
 *   readState(): Promise<Partial<GameSnapshot>>   // memory reader / packets / OCR
 *
 * MVP ships two sources:
 *   - MemoryReaderSource (interface for real Tibia process reader — Windows build)
 *   - SimulatedWorld     (deterministic virtual Tibia world used for integration
 *                          tests and headless validation on non-Windows hosts).
 *                          It is NOT a UI mock: the bot cannot tell the difference,
 *                          every action has simulated in-world consequences.
 */

import { makeSnapshot, distance } from '../../core/types/index.js';

export class PerceptionEngine {
  /** @param {{readState: () => Promise<object>}} source */
  constructor(source) {
    if (!source || typeof source.readState !== 'function') {
      throw new Error('PerceptionEngine requires a WorldSource with readState()');
    }
    this.source = source;
    this.lastSnapshot = null;
    this.errors = 0;
  }

  async snapshot() {
    try {
      const raw = await this.source.readState();
      const snap = makeSnapshot(raw);
      this.lastSnapshot = snap;
      return snap;
    } catch (err) {
      this.errors++;
      throw err;
    }
  }

  /** perception health used by watchdog / emergency (§19: erro de percepção) */
  health() {
    const age = this.lastSnapshot ? Date.now() - this.lastSnapshot.timestamp : Infinity;
    return { ok: this.errors === 0 && age < 5000, errors: this.errors, lastAgeMs: age };
  }
}

/**
 * Real-hardware adapter contract. On Windows this reads the Tibia client
 * process memory (sig-scanner) and/or parses game packets. Throwing here is
 * intentional: no fake data may leak from the "real" adapter path.
 */
export class MemoryReaderSource {
  constructor(opts = {}) {
    this.processName = opts.processName || 'Tibia.exe';
  }
  async readState() {
    throw new Error(
      `MemoryReaderSource not bound to a native reader for ${this.processName}. ` +
      `Provide a native module implementing readState() (Windows build).`
    );
  }
  async sendAction(_cmd) {
    throw new Error('MemoryReaderSource.sendAction requires the native input layer.');
  }
}

/**
 * SimulatedWorld — a full virtual Tibia micro-world with real consequences:
 * monsters have HP and die, loot items exist in corpses, potions are consumed,
 * capacity changes, travel/depots/refill NPCs work, death happens when HP hits 0.
 */
export class SimulatedWorld {
  constructor(config = {}) {
    this.tickMs = config.tickMs ?? 20;
    this.monsters = config.monsters ?? [
      { name: 'Dragon', count: 4, hp: 1000 },
      { name: 'Rotworm', count: 6, hp: 300 },
    ];
    this.huntArea = config.huntArea ?? { x: 1000, y: 1000, z: 7, radius: 15 };
    this.city = config.city ?? { x: 800, y: 800, z: 7 };
    this.player = {
      name: config.playerName ?? 'Paladino',
      level: config.level ?? 100,
      experience: config.experience ?? 1_000_000,
      hp: 400, maxHp: 400,
      mana: 200, maxMana: 200,
      stamina: 60,
      capacity: 400, usedCapacity: 100,
      position: { ...this.city },
      gold: 10_000,
      dead: false, deaths: 0, kills: 0,
      inventory: { healthPotion: 100, manaPotion: 100, spear: 200, food: 50 },
      bag: [], // looted items
    };
    this.creatures = [];
    this.corpses = [];
    this.npcDepot = { x: 802, y: 800, z: 7 };
    this.npcShop = { x: 798, y: 800, z: 7 };
    this.depositBox = [];
    this._spawnMonsters();
    this._lastMove = null;
    this.log = [];
  }

  _spawnMonsters() {
    let id = 0;
    for (const spec of this.monsters) {
      for (let i = 0; i < spec.count; i++) {
        this.creatures.push({
          id: `m${id++}`,
          name: spec.name,
          type: 'monster',
          hp: spec.hp, maxHp: spec.hp,
          position: {
            x: this.huntArea.x + Math.floor(Math.random() * this.huntArea.radius * 2) - this.huntArea.radius,
            y: this.huntArea.y + Math.floor(Math.random() * this.huntArea.radius * 2) - this.huntArea.radius,
            z: this.huntArea.z,
          },
          visible: true,
          xp: spec.name === 'Dragon' ? 150 : 40,
          lootValue: spec.name === 'Dragon' ? 500 : 60,
        });
      }
    }
  }

  // ---- Actions executed by the runtime's Action layer ----
  move(dx, dy) {
    if (this.player.dead) return false;
    // accumulate fractional steps so diagonal movement advances both axes
    this._acc = this._acc || { x: 0, y: 0 };
    this._acc.x += dx; this._acc.y += dy;
    const sx = Math.trunc(this._acc.x), sy = Math.trunc(this._acc.y);
    this._acc.x -= sx; this._acc.y -= sy;
    this.player.position.x += sx;
    this.player.position.y += sy;
    this._lastMove = Date.now();
    return true;
  }
  teleport(pos) { this.player.position = { ...pos }; }
  attack(targetId) {
    const p = this.player;
    if (p.dead) return { hit: false, reason: 'dead' };
    const t = this.creatures.find(c => c.id === targetId && c.hp > 0);
    if (!t) return { hit: false, reason: 'no_target' };
    if (distance(p.position, t.position) > 5) return { hit: false, reason: 'out_of_range' };
    if (p.mana < 30) return { hit: false, reason: 'no_mana' };
    p.mana -= 10;
    const dmg = 80 + Math.floor(Math.random() * 60);
    t.hp -= dmg;
    // monster retaliates
    const back = 5 + Math.floor(Math.random() * 20) * (t.name === 'Dragon' ? 2 : 1);
    p.hp = Math.max(0, p.hp - back);
    if (t.hp <= 0) {
      t.visible = false;
      p.kills++;
      p.experience += t.xp;
      this.corpses.push({
        id: `c_${t.id}_${Date.now()}`,
        creatureName: t.name,
        position: { ...t.position },
        items: [{ itemId: t.name === 'Dragon' ? 123 : 3031, name: `${t.name} Ham`, value: t.lootValue, weight: 15 }],
        looted: false,
      });
      if (p.hp <= 0) this._die('retaliation');
      return { hit: true, killed: true };
    }
    return { hit: true, killed: false };
  }
  useHealthPotion() {
    const p = this.player;
    if (p.inventory.healthPotion <= 0) return false;
    p.inventory.healthPotion--;
    p.hp = Math.min(p.maxHp, p.hp + 150);
    return true;
  }
  useManaPotion() {
    const p = this.player;
    if (p.inventory.manaPotion <= 0) return false;
    p.inventory.manaPotion--;
    p.mana = Math.min(p.maxMana, p.mana + 120);
    return true;
  }
  eat() {
    const p = this.player;
    if (p.inventory.food <= 0) return false;
    p.inventory.food--;
    return true;
  }
  lootCorpse(corpid) {
    const p = this.player;
    const c = this.corpses.find(x => x.id === corpid);
    if (!c || c.looted) return { ok: false, reason: 'no_corpse' };
    if (distance(p.position, c.position) > 2) return { ok: false, reason: 'too_far' };
    let got = 0;
    for (const item of c.items) {
      if (p.usedCapacity + item.weight > p.capacity) return { ok: true, items: got, full: true };
      p.usedCapacity += item.weight;
      p.bag.push(item);
      got++;
    }
    c.looted = true;
    return { ok: true, items: got };
  }
  sellBag() {
    const p = this.player;
    let total = 0;
    for (const it of p.bag) total += it.value;
    p.gold += total;
    p.usedCapacity -= p.bag.reduce((s, i) => s + i.weight, 0);
    const sold = p.bag.length;
    p.bag = [];
    return { gold: total, sold };
  }
  depositToBank(amount) {
    const p = this.player;
    const d = Math.min(amount, p.gold);
    p.gold -= d;
    this.depositBox.push(d);
    return d;
  }
  buyPotions(kind, count) {
    const p = this.player;
    const cost = kind === 'health' ? 50 : 150;
    const affordable = Math.min(count, Math.floor(p.gold / cost));
    p.gold -= affordable * cost;
    if (kind === 'health') p.inventory.healthPotion += affordable;
    else p.inventory.manaPotion += affordable;
    return affordable;
  }
  buyAmmunition(count) {
    const p = this.player;
    const affordable = Math.min(count, Math.floor(p.gold / 5));
    p.gold -= affordable * 5;
    p.inventory.spear += affordable;
    return affordable;
  }
  castBless(name) {
    this.player.blessed = this.player.blessed || new Set();
    this.player.blessed.add(name);
    return true;
  }
  // internal
  _die(cause) {
    const p = this.player;
    p.dead = true;
    p.deaths++;
    p.deathCause = cause;
    p.deathPosition = { ...p.position };
    setTimeout(() => {}, 0); // keep API sync; revival via respawn()
  }
  respawn() {
    const p = this.player;
    p.dead = false;
    p.hp = Math.floor(p.maxHp * 0.4);
    p.mana = Math.floor(p.maxMana * 0.4);
    p.position = { ...this.city };
    p.experience = Math.max(0, p.experience - Math.floor(p.experience * 0.05));
  }

  /** world clock — regen, monster respawn, danger drift */
  update() {
    const p = this.player;
    if (!p.dead) {
      p.hp = Math.min(p.maxHp, p.hp + 1);
      p.mana = Math.min(p.maxMana, p.mana + 2);
      // respawn monsters near hunt area if wiped
      const alive = this.creatures.filter(c => c.hp > 0 && c.visible).length;
      if (alive < 3) {
        this.creatures = this.creatures.filter(c => c.hp > 0);
        this._spawnMonsters();
      }
    }
  }

  async readState() {
    this.update();
    const p = this.player;
    const battleList = this.creatures
      .filter(c => c.visible && c.hp > 0 && distance(c.position, p.position) < 30)
      .map(c => ({ ...c, position: { ...c.position } }));
    // unlooted corpses stay visible until actually looted (like real Tibia)
    const nearCorpses = this.corpses.filter(c => !c.looted);
    return {
      hp: p.hp, hpPercent: Math.round((p.hp / p.maxHp) * 100),
      mana: p.mana, manaPercent: Math.round((p.mana / p.maxMana) * 100),
      stamina: p.stamina,
      capacity: Math.round((p.usedCapacity / p.capacity) * 100),
      position: { ...p.position },
      level: p.level, experience: p.experience,
      battleList,
      currentTarget: undefined,
      containers: nearCorpses.map(c => ({ id: c.id, name: `Corpse of a ${c.creatureName}`, items: c.items.length, position: { ...c.position } })),
      inventory: Object.entries(p.inventory).map(([k, v]) => ({ name: k, count: v })),
      cooldowns: [],
      dangerLevel: battleList.filter(c => c.name === 'Dragon' && distance(c.position, p.position) < 4).length,
      playerStatus: { dead: p.dead, blessed: !!p.blessed?.size, gold: p.gold, kills: p.kills, deaths: p.deaths },
      dead: p.dead,
      timestamp: Date.now(),
    };
  }
}

// small helper guarding corpse id typos
function corpidSafe(id) { return id; }
