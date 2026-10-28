import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RuntimeManager } from '../runtime/api/manager.js';
import { SimulatedWorld } from '../runtime/perception/engine.js';
import { BotStates } from '../core/types/index.js';
import fs from 'node:fs';

const TMP = 'data/test-integration';

function freshManager(monkeyPatch) {
  fs.rmSync(TMP, { recursive: true, force: true });
  const mgr = new RuntimeManager({ profilesRoot: `${TMP}/profiles`, dataFile: `${TMP}/tbot.db` });
  if (monkeyPatch) mgr.worldFactory = monkeyPatch;
  return mgr;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('Full hunt cycle integration (§38 criteria)', () => {
  it('START → PREPARE → TRAVEL → HUNT → TARGET → COMBAT → LOOT happens for real', async () => {
    const mgr = freshManager();
    const session = await mgr.start('character-1');
    expect(session.sessionId).toBeTruthy();

    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      await wait(40);
      const st = mgr.status();
      seen.add(st.state);
      if (seen.has(BotStates.LOOT)) break;
    }
    expect(seen.has(BotStates.PREPARE)).toBe(true);
    expect(seen.has(BotStates.TRAVEL)).toBe(true);
    expect(seen.has(BotStates.HUNT)).toBe(true);
    expect(seen.has(BotStates.TARGET)).toBe(true);
    expect(seen.has(BotStates.COMBAT)).toBe(true);
    expect(seen.has(BotStates.LOOT)).toBe(true);

    // telemetry recorded real kills & xp
    const stats = mgr.engine.ctx.telemetry.statistics();
    expect(stats.kills).toBeGreaterThan(0);
    expect(stats.xp).toBeGreaterThan(0);

    await mgr.stop();
    expect(mgr.status().state).toBe(BotStates.STOPPED);
    // session persisted to db
    const sessions = mgr.db.all('sessions');
    expect(sessions.length).toBe(1);
    expect(sessions[0].session_id).toBe(session.sessionId);
    mgr.close();
  }, 30_000);

  it('REFILL cycle triggers on low potions and returns to HUNT (§38 #10,#11)', async () => {
    let worldRef;
    const mgr = freshManager(() => (worldRef = new SimulatedWorld()));
    await mgr.start('refill-bot');
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      await wait(25);
      seen.add(mgr.status().state);
      // drain potions mid-run to force the refill path once seen enough hunting.
      // !seen.has(EVALUATE) guard: after the refill pipeline bought potions, we
      // must NOT keep zeroing them every tick — otherwise the bot gets stuck in
      // REFILL and never reaches SELL_LOOT.
      if (seen.has(BotStates.LOOT) && !seen.has(BotStates.EVALUATE) && worldRef.player.inventory.healthPotion > 5) {
        worldRef.player.inventory.healthPotion = 2;
        worldRef.player.inventory.manaPotion = 2;
        worldRef.player.gold = 20_000;
      }
      if (seen.has(BotStates.REFILL) && seen.has(BotStates.TRAVEL) && mgr.status().state === BotStates.HUNT) break;
    }
    expect(seen.has(BotStates.EVALUATE)).toBe(true);
    expect(seen.has(BotStates.REFILL)).toBe(true);
    expect(seen.has(BotStates.SELL_LOOT)).toBe(true);
    expect(worldRef.player.inventory.healthPotion).toBeGreaterThanOrEqual(50); // actually bought
    expect(mgr.engine.ctx.telemetry.events.some(e => e.type === 'REFILL_STARTED')).toBe(true);
    expect(mgr.engine.ctx.telemetry.events.some(e => e.type === 'REFILL_COMPLETED')).toBe(true);
    await mgr.stop();
    mgr.close();
  }, 40_000);

  it('DEATH → DEAD → RECOVERY → back on route (§38 #15)', async () => {
    let worldRef;
    const mgr = freshManager(() => (worldRef = new SimulatedWorld()));
    await mgr.start('death-bot');
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      await wait(25);
      seen.add(mgr.status().state);
      if (seen.has(BotStates.COMBAT)) {
        worldRef.player.hp = 1; // next monster retaliation kills us
      }
      if (seen.has(BotStates.RECOVERY) && mgr.status().state === BotStates.TRAVEL) break;
    }
    expect(seen.has(BotStates.DEAD)).toBe(true);
    expect(seen.has(BotStates.RECOVERY)).toBe(true);
    const deaths = mgr.engine.ctx.telemetry.events.filter(e => e.type === 'DEATH');
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    expect(deaths[0].payload.location).toMatch(/\d+\/\d+\/\d+/);
    mgr.close();
  }, 40_000);

  it('EMERGENCY triggers at critical HP with no potions (§38 #14)', async () => {
    let worldRef;
    const mgr = freshManager(() => (worldRef = new SimulatedWorld()));
    await mgr.start('emg-bot');
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      await wait(25);
      seen.add(mgr.status().state);
      if (seen.has(BotStates.HUNT)) {
        worldRef.player.hp = 20;         // ~5%
        worldRef.player.inventory.healthPotion = 0;
      }
      if (seen.has(BotStates.EMERGENCY)) break;
    }
    expect(seen.has(BotStates.EMERGENCY)).toBe(true);
    expect(mgr.engine.ctx.telemetry.events.some(e => e.type === 'EMERGENCY')).toBe(true);
    await mgr.stop();
    mgr.close();
  }, 30_000);

  it('STOP is immediate: engine halts, nothing ticks afterwards (§38 #16, §4.2)', async () => {
    const mgr = freshManager();
    await mgr.start('stop-bot');
    await wait(300);
    await mgr.stop();
    const eng = mgr.engine;
    const killsAtStop = eng.ctx.world.player.kills;
    const eventsAtStop = eng.ctx.telemetry.events.length;
    await wait(300);
    expect(eng.machine.running).toBe(false);
    expect(eng.ctx.world.player.kills).toBe(killsAtStop); // world untouched by bot after stop
    expect(eng.ctx.telemetry.events.length).toBeLessThanOrEqual(eventsAtStop + 1);
    expect(mgr.status().bot).toBe('stopped');
    mgr.close();
  }, 20_000);

  it('Watchdog does not blind-resume in unknown state (§30)', async () => {
    const mgr = freshManager(() => ({
      readState: async () => { throw new Error('client disconnected'); },
    }));
    await expect(mgr.start('wd-bot')).rejects.toThrow();
    // manager refuses to run against a dead perception source
    expect(mgr.errors).toBe(0); // never entered running mode
    mgr.close();
  });
});
