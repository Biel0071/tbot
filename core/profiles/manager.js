/**
 * T BOT — Profile Manager (spec §26, §31, §32)
 * Per-character folders: profiles/<name>/{settings,cavebot,target,loot,hotkeys}.json
 * Supports create / duplicate / import / export / reset.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILES = {
  settings: 'settings.json',
  cavebot: 'cavebot.json',
  target: 'target.json',
  loot: 'loot.json',
  hotkeys: 'hotkeys.json',
};

export const DEFAULT_PROFILE = {
  settings: {
    name: 'character-1',
    hunt: {
      name: 'Solo Hunt',
      route: 'main-hunt',
      minHp: 60,
      minMana: 30,
      minPotions: 50,
      maxCapacity: 85,
      refill: { enabled: true },
      bless: { required: true },
      emergency: { hp: 30, enabled: true },
    },
    debug: false,
  },
  cavebot: {
    routes: [
      {
        route: 'main-hunt',
        loop: true,
        waypoints: [
          { type: 'TRAVEL', destination: 'hunt' },
          { type: 'WALK', x: 995, y: 1000, z: 7 },
          { type: 'HUNT', duration: 3600 },
          { type: 'WALK', x: 1005, y: 1000, z: 7 },
          { type: 'HUNT', duration: 3600 },
          { type: 'REFILL' },
        ],
      },
      {
        route: 'city-loop',
        loop: false,
        waypoints: [
          { type: 'TRAVEL', destination: 'city' },
          { type: 'SELL' },
          { type: 'REFILL' },
          { type: 'BANK' },
        ],
      },
    ],
  },
  target: {
    creatures: [
      { name: 'Dragon', priority: 80, maxDistance: 7, chase: true, avoid: false },
      { name: 'Rotworm', priority: 40, maxDistance: 5, chase: true, avoid: false },
    ],
  },
  loot: {
    rules: [
      { itemId: 123, name: 'Dragon Ham', action: 'SELL' },
      { itemId: 3031, name: 'Rotworm Ham', action: 'SELL' },
    ],
    defaultAction: 'KEEP',
  },
  hotkeys: {
    keys: [
      { slot: 'F1', action: 'potion_health', condition: { field: 'hpPercent', op: '<', value: 60 }, enabled: true },
      { slot: 'F2', action: 'potion_mana', condition: { field: 'manaPercent', op: '<', value: 30 }, enabled: true },
      { slot: 'F3', action: 'eat', condition: { field: 'food', op: '<', value: 10 }, enabled: true },
    ],
  },
};

export class ProfileManager {
  constructor(root = 'profiles') {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  dir(name) { return path.join(this.root, name); }

  exists(name) { return fs.existsSync(this.dir(name)); }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(this.root, d.name, 'settings.json')))
      .map(d => d.name);
  }

  create(name, overrides = {}) {
    if (this.exists(name)) throw new Error(`Profile "${name}" already exists`);
    const prof = structuredClone(DEFAULT_PROFILE);
    prof.settings.name = name;
    deepMerge(prof, overrides);
    this._writeAll(name, prof);
    return prof;
  }

  load(name) {
    const out = {};
    for (const [key, file] of Object.entries(FILES)) {
      const p = path.join(this.dir(name), file);
      if (fs.existsSync(p)) out[key] = JSON.parse(fs.readFileSync(p, 'utf8'));
      else out[key] = structuredClone(DEFAULT_PROFILE[key]);
    }
    return out;
  }

  save(name, section, data) {
    if (!this.exists(name)) this.create(name);
    fs.writeFileSync(path.join(this.dir(name), FILES[section]), JSON.stringify(data, null, 2));
  }

  duplicate(src, dst) {
    const prof = this.load(src);
    prof.settings.name = dst;
    this._writeAll(dst, prof);
    return prof;
  }

  reset(name) {
    fs.rmSync(this.dir(name), { recursive: true, force: true });
    return this.create(name);
  }

  export(name) {
    return JSON.stringify({ name, profile: this.load(name) }, null, 2);
  }

  import(json) {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    const name = obj.name ?? obj.profile?.settings?.name;
    if (!name) throw new Error('Import requires a profile name');
    this._writeAll(name, obj.profile);
    return name;
  }

  _writeAll(name, prof) {
    fs.mkdirSync(this.dir(name), { recursive: true });
    for (const [key, file] of Object.entries(FILES)) {
      fs.writeFileSync(path.join(this.dir(name), file), JSON.stringify(prof[key], null, 2));
    }
  }
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}
