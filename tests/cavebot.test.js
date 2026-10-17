import { describe, it, expect } from 'vitest';
import { Route, Navigator, StuckDetector } from '../runtime/navigation/navigator.js';
import { PerceptionEngine, SimulatedWorld } from '../runtime/perception/engine.js';
import { ActionLayer } from '../runtime/adapters/actions.js';
import { TelemetryEngine } from '../runtime/telemetry/engine.js';

function mkNav(stuckPatienceMs = 30) {
  const world = new SimulatedWorld();
  const perception = new PerceptionEngine(world);
  const actions = new ActionLayer(world);
  const telemetry = new TelemetryEngine();
  const nav = new Navigator({ actions, perception, telemetry, stuckPatienceMs });
  return { world, nav, telemetry };
}

describe('Cavebot — routes, waypoints, loops, stuck recovery (§37)', () => {
  it('loads a route from spec §8 JSON schema', () => {
    const r = Route.fromJSON({
      route: 'hunt_rubini', loop: true,
      waypoints: [
        { type: 'WALK', x: 100, y: 200, z: 7 },
        { type: 'TRAVEL', destination: 'hunt' },
        { type: 'HUNT', duration: 3600 },
        { type: 'REFILL' },
      ],
    });
    expect(r.name).toBe('hunt_rubini');
    expect(r.waypoints.length).toBe(4);
    expect(() => Route.fromJSON({ route: 'x', waypoints: [] })).toThrow();
  });

  it('walks waypoints in order and advances on arrival', async () => {
    const { world, nav } = mkNav();
    world.player.position = { x: 0, y: 0, z: 7 };
    nav.loadRoute(new Route({
      route: 't', loop: false,
      waypoints: [
        { type: 'WALK', x: 3, y: 0, z: 7 },
        { type: 'WALK', x: 3, y: 3, z: 7 },
      ],
    }));
    for (let i = 0; i < 30 && nav.wpIndex < 2; i++) {
      await nav.tickWaypoint({ resolveTravel: () => ({ x: 0, y: 0, z: 7 }) });
    }
    expect(nav.wpIndex).toBe(2); // both walk wps reached
    expect(world.player.position.x).toBe(3);
    expect(world.player.position.y).toBe(3);
  });

  it('loops back to index 0 when route.loop=true', async () => {
    const { world, nav } = mkNav();
    world.player.position = { x: 0, y: 0, z: 7 };
    nav.loadRoute(new Route({
      route: 'loop1', loop: true,
      waypoints: [{ type: 'WALK', x: 2, y: 0, z: 7 }],
    }));
    for (let i = 0; i < 20; i++) await nav.tickWaypoint();
    expect(nav.wpIndex).toBe(0); // wrapped around
  });

  it('TRAVEL waypoint resolves through TravelManager hook', async () => {
    const { world, nav } = mkNav();
    nav.loadRoute(new Route({
      route: 'tr', loop: false,
      waypoints: [{ type: 'TRAVEL', destination: 'hunt' }],
    }));
    const res = await nav.tickWaypoint({ resolveTravel: (n) => n === 'hunt' ? { x: 500, y: 500, z: 7 } : null });
    expect(res.traveled).toBe(true);
    expect(world.player.position.x).toBe(500);
  });

  it('StuckDetector: no progress → recalc → recovery escalation (§9)', () => {
    const sd = new StuckDetector({ patienceMs: 5, maxRecalcs: 2 });
    const pos = { x: 10, y: 10, z: 7 };
    expect(sd.observe(pos).stuck).toBe(false);
    // freeze time by not changing position
    let out;
    for (let i = 0; i < 200; i++) out = sd.observe(pos);
    // after first patience window we get recalc results; repeated observes escalate
    const s2 = new StuckDetector({ patienceMs: 1, maxRecalcs: 1 });
    s2.observe(pos);
    const start = s2.lastChangeAt;
    // simulate passage of time
    s2.lastChangeAt = Date.now() - 10_000;
    expect(s2.observe(pos)).toEqual({ stuck: true, needRecovery: false }); // first: recalc
    s2.lastChangeAt = Date.now() - 10_000;
    expect(s2.observe(pos).needRecovery).toBe(true); // exceeded recalcs → recovery
  });

  it('navigator performs recovery maneuver when unreachable keeps failing', async () => {
    const { world, nav, telemetry } = mkNav(5);
    // Block movement entirely: dead player can't move but perception still reads
    world.player.dead = true;
    nav.loadRoute(new Route({ route: 'z', loop: false, waypoints: [{ type: 'WALK', x: 999, y: 999, z: 7 }] }));
    // force the detector into recovery repeatedly by pinning last change in past
    for (let i = 0; i < 12; i++) {
      nav.stuck.lastChangeAt = Date.now() - 60_000;
      await nav.walkTo({ x: 999, y: 999, z: 7 });
    }
    expect(nav.recoveryAttempts).toBeGreaterThan(0);
    expect(telemetry.events.some(e => e.type === 'STUCK')).toBe(true);
  });
});
