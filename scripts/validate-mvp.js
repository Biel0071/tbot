#!/usr/bin/env node
/**
 * T BOT — MVP 1.0 sequential validation (§43)
 * Boots the REAL runtime (API + RuntimeManager + BotEngine over SimulatedWorld
 * as deterministic test environment), walks the full pipeline and prints an
 * honest PASS/FAIL report. Exit code 0 only if everything passes.
 *
 * Usage: node scripts/validate-mvp.js   (or: npm run test:e2e)
 */
import { createServer } from '../runtime/api/server.js';

const results = [];
let BASE = '';

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
    return true;
  } catch (e) {
    record(name, false, e.message);
    return false;
  }
}

const get = async (p) => {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`GET ${p} -> HTTP ${r.status}`);
  return r.json();
};
const post = async (p) => {
  const r = await fetch(BASE + p, { method: 'POST' });
  if (!r.ok) throw new Error(`POST ${p} -> HTTP ${r.status}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------------------
console.log('========================================');
console.log('T BOT MVP VALIDATION');
console.log('========================================');

// START RUNTIME — real server on a free port (port 0)
const ctx = createServer({ port: 0 });
await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
BASE = `http://127.0.0.1:${ctx.server.address().port}`;
console.log(`runtime listening on ${BASE}\n`);

let botStarted = false;
try {
  // HEALTH CHECK
  await step('Runtime /api/health', async () => {
    const h = await get('/api/health');
    if (h.runtime !== 'online') throw new Error(`runtime=${h.runtime}`);
    return 'runtime online';
  });

  // STATUS
  await step('API /api/status', async () => {
    const s = await get('/api/status');
    if (!s || typeof s.state !== 'string') throw new Error('no state field');
    return `state=${s.state}`;
  });

  // STATIC UI (dashboard served by the runtime itself)
  await step('Dashboard static (/)', async () => {
    const r = await fetch(BASE + '/');
    if (!r.ok) throw new Error(`GET / -> ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) throw new Error(`content-type=${ct}`);
    const html = await r.text();
    if (!html.includes('T BOT')) throw new Error('dashboard html missing "T BOT"');
    return 'html served';
  });

  // LOAD PROFILE
  await step('Load profile', async () => {
    const cfg = await get('/api/config');
    if (!cfg?.settings) throw new Error('config has no settings');
    return cfg.settings.name ?? 'profile loaded';
  });

  // START BOT (real RuntimeManager -> BotEngine -> StateMachine)
  await step('POST /api/bot/start', async () => {
    const r = await post('/api/bot/start');
    if (!r.ok) throw new Error('start not ok');
    botStarted = true;
    return 'engine started';
  });

  // VERIFY STATE MACHINE cycle PREPARE -> TRAVEL -> HUNT (+TARGET/COMBAT/LOOT via events)
  await step('State machine PREPARE/TRAVEL/HUNT', async () => {
    await waitFor(async () => {
      const evs = await get('/api/events?limit=500');
      const states = evs.filter((e) => e.type === 'STATE_CHANGED').map((e) => e.payload?.to ?? e.state ?? '');
      return states.some((s) => String(s).includes('HUNT'));
    }, 30000, 'HUNT state');
    const evs = await get('/api/events?limit=500');
    const joined = JSON.stringify(evs);
    for (const need of ['PREPARE', 'TRAVEL', 'HUNT']) {
      if (!joined.includes(need)) throw new Error(`missing ${need} in events`);
    }
    return 'PREPARE → TRAVEL → HUNT observed';
  });

  // VERIFY TARGET / COMBAT / LOOT
  await step('Target / Combat / Loot', async () => {
    await waitFor(async () => {
      const st = await get('/api/statistics');
      return (st.kills ?? 0) > 0;
    }, 45000, 'first kill');
    const evs = await get('/api/events?limit=500');
    const types = new Set(evs.map((e) => e.type));
    if (!types.has('TARGET_SELECTED')) throw new Error('no TARGET_SELECTED event');
    if (!types.has('TARGET_KILLED')) throw new Error('no TARGET_KILLED event');
    if (!types.has('LOOT_COLLECTED')) throw new Error('no LOOT_COLLECTED event yet (may follow shortly)');
    return 'kill + loot recorded';
  });

  // VERIFY TELEMETRY / STATISTICS (real numbers, not hardcoded)
  await step('Statistics kills/xp > 0', async () => {
    const st = await get('/api/statistics');
    if (!(st.kills > 0)) throw new Error(`kills=${st.kills}`);
    if (!(st.xp > 0)) throw new Error(`xp=${st.xp}`);
    if (!(st.runtimeMs > 0 || st.runtime > 0)) throw new Error('no runtime counter');
    return `kills=${st.kills} xp=${st.xp}`;
  });

  await step('Telemetry session id present', async () => {
    const s = await get('/api/session');
    if (!s?.sessionId) throw new Error('session has no sessionId');
    return s.sessionId;
  });

  await step('Logs endpoint', async () => {
    const logs = await get('/api/logs?limit=50');
    if (!Array.isArray(logs) || logs.length === 0) throw new Error('no logs');
    return `${logs.length} log lines`;
  });

  // PAUSE / RESUME
  await step('Pause / Resume', async () => {
    await post('/api/bot/pause');
    let st = await get('/api/status');
    if (!/PAUS/i.test(st.state)) throw new Error(`after pause state=${st.state}`);
    await post('/api/bot/resume');
    st = await get('/api/status');
    if (/PAUS/i.test(st.state)) throw new Error(`after resume state=${st.state}`);
    return `paused → resumed (${st.state})`;
  });

  // STOP + clean shutdown
  await step('POST /api/bot/stop', async () => {
    await post('/api/bot/stop');
    await waitFor(async () => {
      const st = await get('/api/status');
      return st.state === 'STOPPED';
    }, 10000, 'STOPPED state');
    const evs = await get('/api/events?limit=500');
    if (!evs.some((e) => e.type === 'BOT_STOPPED')) throw new Error('no BOT_STOPPED event');
    return 'clean stop, BOT_STOPPED recorded';
  });
} finally {
  if (botStarted) await ctx.manager.stop().catch(() => {});
  ctx.manager.close();
  ctx.server.close();
}

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log('\n========================================');
console.log('RESULT');
console.log('========================================');
console.log(`${passed}/${total} PASS\n`);
if (passed === total) {
  console.log('T BOT MVP 1.0');
  console.log('OPERATIONAL');
  process.exit(0);
} else {
  console.log('NOT OPERATIONAL');
  process.exit(1);
}
