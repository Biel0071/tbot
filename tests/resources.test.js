import { describe, it, expect } from 'vitest';
import { ResourceManager, HotkeyEngine } from '../runtime/hotkeys/engine.js';
import { LootEngine } from '../runtime/loot/engine.js';
import { ActionLayer } from '../runtime/adapters/actions.js';
import { SimulatedWorld } from '../runtime/perception/engine.js';
import { makeSnapshot } from '../core/types/index.js';

describe('Resource Manager thresholds (§37)', () => {
  const rm = new ResourceManager({ minPotions: 30, maxCapacity: 85, emergencyHpPercent: 30, emergencyDanger: 4 });

  it('low potions → refill needed', () => {
    const snap = makeSnapshot({
      capacity: 40, hpPercent: 90,
      inventory: [{ name: 'healthPotion', count: 10 }, { name: 'manaPotion', count: 80 }, { name: 'spear', count: 200 }, { name: 'food', count: 40 }],
    });
    expect(rm.evaluate(snap).refill).toBe(true);
  });

  it('high capacity → sell needed', () => {
    const snap = makeSnapshot({
      capacity: 87, hpPercent: 90,
      inventory: [{ name: 'healthPotion', count: 80 }, { name: 'manaPotion', count: 80 }, { name: 'spear', count: 200 }, { name: 'food', count: 40 }],
    });
    expect(rm.evaluate(snap).sell).toBe(true);
  });

  it('low HP with zero potions → emergency', () => {
    const snap = makeSnapshot({
      capacity: 40, hpPercent: 25,
      inventory: [{ name: 'healthPotion', count: 0 }, { name: 'manaPotion', count: 50 }, { name: 'spear', count: 200 }, { name: 'food', count: 40 }],
    });
    expect(rm.evaluate(snap).emergency).toBe(true);
  });

  it('low mana alone does NOT trigger emergency (only warning path)', () => {
    const snap = makeSnapshot({
      capacity: 40, hpPercent: 80, manaPercent: 10,
      inventory: [{ name: 'healthPotion', count: 80 }, { name: 'manaPotion', count: 80 }, { name: 'spear', count: 200 }, { name: 'food', count: 40 }],
    });
    const r = rm.evaluate(snap);
    expect(r.emergency).toBe(false);
  });

  it('danger level above threshold → emergency', () => {
    const snap = makeSnapshot({ capacity: 40, hpPercent: 80, dangerLevel: 5, inventory: [] });
    expect(rm.evaluate(snap).emergency).toBe(true);
  });
});

describe('Hotkey Engine conditions (§13)', () => {
  it('fires health potion hotkey when HP < 60% and consumes real potion', async () => {
    const world = new SimulatedWorld();
    world.player.hp = 100; // 25%
    const actions = new ActionLayer(world);
    const hk = new HotkeyEngine(HotkeyEngine.defaultSet(), actions);
    const snap = await world.readState();
    const fired = await hk.apply(snap);
    expect(fired).toContain('F1');
    expect(world.player.hp).toBeGreaterThan(100);
    expect(world.player.inventory.healthPotion).toBe(99);
  });

  it('does not fire when condition is false', async () => {
    const world = new SimulatedWorld();
    const actions = new ActionLayer(world);
    const hk = new HotkeyEngine(HotkeyEngine.defaultSet(), actions);
    const snap = await world.readState(); // full hp/mana
    const fired = await hk.apply(snap);
    expect(fired).not.toContain('F1');
    expect(fired).not.toContain('F2');
  });

  it('respects cooldown between fires', async () => {
    const world = new SimulatedWorld();
    world.player.hp = 50;
    const actions = new ActionLayer(world);
    const hk = new HotkeyEngine(HotkeyEngine.defaultSet(), actions);
    const snap = await world.readState();
    await hk.apply(snap);
    const second = await hk.apply(snap); // immediate re-apply → cooldown blocks
    expect(second).not.toContain('F1');
  });
});

describe('Loot Engine rules (§12)', () => {
  it('IGNORE items are not picked up per rule', () => {
    const le = new LootEngine([
      { itemId: 123, name: 'Dragon Ham', action: 'SELL' },
      { itemId: 999, name: 'Junk', action: 'IGNORE' },
    ]);
    expect(le.shouldPickup({ itemId: 123, name: 'Dragon Ham' })).toBe(true);
    expect(le.shouldPickup({ itemId: 999, name: 'Junk' })).toBe(false);
  });

  it('loots corpse via action layer and counts items', async () => {
    const world = new SimulatedWorld();
    const actions = new ActionLayer(world);
    const le = new LootEngine([{ itemId: 123, name: 'Dragon Ham', action: 'SELL' }]);
    // kill a dragon next to the player to create a corpse
    world.creatures.push({ id: 'zz', name: 'Dragon', type: 'monster', hp: 10, maxHp: 1000, position: { ...world.player.position, x: world.player.position.x + 1 }, visible: true, xp: 150, lootValue: 500 });
    world.attack('zz');
    const snap = await world.readState();
    const corpse = le.nextCorpse(snap);
    expect(corpse).toBeTruthy();
    const res = await le.lootNearest(snap, actions);
    expect(res.ok).toBe(true);
    expect(le.collected).toBeGreaterThan(0);
    expect(world.player.usedCapacity).toBeGreaterThan(100);
  });
});
