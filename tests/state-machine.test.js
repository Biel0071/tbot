import { describe, it, expect } from 'vitest';
import { StateMachine } from '../runtime/state-machine/machine.js';
import { BotStates } from '../core/types/index.js';

function mkStates(log) {
  const states = new Map();
  for (const id of ['A', 'B', 'STOPPING', 'STOPPED', 'ERROR']) {
    states.set(id, {
      id,
      async enter() { log.push(`enter:${id}`); },
      async tick(ctx) {
        log.push(`tick:${id}`);
        if (id === 'A') await ctx.__go('B');
      },
      async exit() { log.push(`exit:${id}`); },
    });
  }
  return states;
}

describe('StateMachine — runtime lifecycle (§37)', () => {
  it('start → runs ticks and transitions A→B with enter/exit hooks', async () => {
    const log = [];
    const states = mkStates(log);
    const sm = new StateMachine({ states, tickMs: 10 });
    const ctx = {
      cancelAll() { log.push('cancel'); },
      __go: async (s) => sm.transition(s),
    };
    await sm.start(ctx, 'A');
    await new Promise(r => setTimeout(r, 60));
    await sm.stop();
    expect(sm.current).toBe(BotStates.STOPPED ? 'STOPPED' : sm.current);
    expect(log).toContain('enter:A');
    expect(log).toContain('tick:A');
    expect(log).toContain('exit:A');
    expect(log).toContain('enter:B');
    expect(log).toContain('cancel'); // stop cancels current action first (§4.2)
    expect(sm.running).toBe(false);
  });

  it('pause stops ticking, resume restores it', async () => {
    const log = [];
    const sm = new StateMachine({ states: mkStates(log), tickMs: 10 });
    const ctx = { __go: async (s) => sm.transition(s) };
    // start directly in B so no auto-transition noise
    await sm.start(ctx, 'B');
    await new Promise(r => setTimeout(r, 40));
    const n1 = log.filter(l => l === 'tick:B').length;
    await sm.pause();
    await new Promise(r => setTimeout(r, 60));
    const n2 = log.filter(l => l === 'tick:B').length;
    expect(n2).toBe(n1); // no ticks while paused
    await sm.resume();
    await new Promise(r => setTimeout(r, 40));
    const n3 = log.filter(l => l === 'tick:B').length;
    expect(n3).toBeGreaterThan(n2);
    await sm.stop();
  });

  it('stop is immediate and never leaves tasks running (§4.2)', async () => {
    const log = [];
    const sm = new StateMachine({ states: mkStates(log), tickMs: 10 });
    let stoppedEntered = false;
    sm.states.get('STOPPED').enter = async () => { stoppedEntered = true; };
    await sm.start({}, 'B');
    await sm.stop();
    expect(stoppedEntered).toBe(true);
    expect(sm.current).toBe('STOPPED');
    const before = log.length;
    await new Promise(r => setTimeout(r, 50));
    expect(log.length).toBe(before); // nothing executes after stop
  });

  it('restart works after stop', async () => {
    const log = [];
    const sm = new StateMachine({ states: mkStates(log), tickMs: 10 });
    await sm.start({ __go: async (s) => sm.transition(s) }, 'B');
    await sm.stop();
    await sm.start({ __go: async (s) => sm.transition(s) }, 'A');
    expect(sm.running).toBe(true);
    await sm.stop();
  });
});
