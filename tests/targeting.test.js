import { describe, it, expect } from 'vitest';
import { TargetEngine } from '../runtime/targeting/engine.js';
import { makeSnapshot } from '../core/types/index.js';

const rules = [
  { name: 'Dragon', priority: 80, maxDistance: 7, chase: true, avoid: false },
  { name: 'Rotworm', priority: 40, maxDistance: 5, chase: true, avoid: false },
  { name: 'Wolf', priority: 90, maxDistance: 7, chase: true, avoid: false },
  { name: 'Bear', priority: 20, maxDistance: 3, chase: false, avoid: true },
];

function creature(id, name, x, y, hp = 100, maxHp = 100) {
  return { id, name, type: 'monster', hp, maxHp, position: { x, y, z: 7 }, visible: true };
}

describe('Target Engine — priority & selection (§37)', () => {
  it('picks highest score considering priority + distance (spec §11 example → C)', () => {
    const te = new TargetEngine(rules);
    const snap = makeSnapshot({
      position: { x: 100, y: 100, z: 7 },
      battleList: [
        creature('a', 'Dragon', 102, 100),   // dist 2, prio 80
        creature('b', 'Rotworm', 105, 100),  // dist 5, prio 40
        creature('c', 'Wolf', 103, 100),     // dist 3, prio 90  ← should win
      ],
    });
    const sel = te.select(snap);
    expect(sel.target.id).toBe('c');
  });

  it('respects maxDistance filter', () => {
    const te = new TargetEngine(rules);
    const snap = makeSnapshot({
      position: { x: 100, y: 100, z: 7 },
      battleList: [creature('d', 'Rotworm', 120, 100)], // dist 20 > 5
    });
    expect(te.select(snap).target).toBe(null);
  });

  it('never selects avoided creatures', () => {
    const te = new TargetEngine(rules);
    const snap = makeSnapshot({
      position: { x: 100, y: 100, z: 7 },
      battleList: [creature('e', 'Bear', 101, 100)],
    });
    expect(te.select(snap).target).toBe(null);
  });

  it('prefers wounded targets at equal priority', () => {
    const te = new TargetEngine([{ name: 'Dragon', priority: 80, maxDistance: 7 }]);
    const full = creature('f1', 'Dragon', 102, 100, 1000, 1000);
    const hurt = creature('f2', 'Dragon', 102, 104, 200, 1000);
    const sel = te.select(makeSnapshot({ position: { x: 100, y: 100, z: 7 }, battleList: [full, hurt] }));
    expect(sel.target.id).toBe('f2');
  });

  it('target lost / target dead clears current target', () => {
    const te = new TargetEngine(rules);
    const withT = makeSnapshot({ position: { x: 100, y: 100, z: 7 }, battleList: [creature('g', 'Dragon', 102, 100)] });
    te.select(withT);
    expect(te.currentTarget?.id).toBe('g');
    // dead: removed from battle list
    const empty = makeSnapshot({ position: { x: 100, y: 100, z: 7 }, battleList: [] });
    const sel = te.select(empty);
    expect(sel.target).toBe(null);
    expect(te.currentTarget).toBe(null);
    expect(te.lostSince).not.toBeNull();
  });
});
