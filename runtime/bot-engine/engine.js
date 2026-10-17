/**
 * T BOT — Bot Engine (spec §2, §5, §41)
 * The REAL autonomous runtime. Wires Perception → Decision Core (FSM) →
 * Actions → Telemetry. No UI code lives here; the UI only observes this via
 * the Runtime API. Every state transition and statistic displayed anywhere
 * originates from actual execution against the WorldSource.
 */

import { BotStates, TelemetryEvents, WaypointTypes, distance } from '../../core/types/index.js';
import { StateMachine } from '../state-machine/machine.js';
import { PerceptionEngine } from '../perception/engine.js';
import { ActionLayer } from '../adapters/actions.js';
import { Navigator, Route } from '../navigation/navigator.js';
import { TargetEngine } from '../targeting/engine.js';
import { LootEngine } from '../loot/engine.js';
import { HotkeyEngine, ResourceManager } from '../hotkeys/engine.js';
import { TravelManager, BlessManager } from '../travel/manager.js';
import { CombatEngine, EmergencyManager, RecoveryManager } from '../combat/engine.js';
import { TelemetryEngine } from '../telemetry/engine.js';

export class BotContext {
  constructor({ profile, world, db }) {
    const hunt = profile.settings.hunt;

    this.perception = new PerceptionEngine(world);
    this.actions = new ActionLayer(world);
    this.telemetry = new TelemetryEngine({ db });
    this.dbRef = db;

    this.navigator = new Navigator({ actions: this.actions, perception: this.perception, telemetry: this.telemetry });
    this.targetEngine = new TargetEngine(profile.target.creatures);
    this.combat = new CombatEngine({ actions: this.actions, targetEngine: this.targetEngine });
    this.lootEngine = new LootEngine(profile.loot.rules, { action: profile.loot.defaultAction ?? 'KEEP' });
    this.hotkeys = new HotkeyEngine(profile.hotkeys.keys.filter(k => k.enabled), this.actions);
    this.resources = new ResourceManager({
      minHpPercent: hunt.minHp,
      minManaPercent: hunt.minMana,
      minPotions: hunt.minPotions,
      maxCapacity: hunt.maxCapacity,
      emergencyHpPercent: hunt.emergency?.hp ?? 30,
    });
    this.travel = new TravelManager();
    this.bless = new BlessManager({ required: !!hunt.bless?.required, actions: this.actions });
    this.emergency = new EmergencyManager({ config: hunt.emergency, actions: this.actions, travel: this.travel });
    this.recovery = new RecoveryManager({ actions: this.actions, telemetry: this.telemetry });

    this.profile = profile;
    this.huntConfig = hunt;
    this.world = world;                 // native bridge in real build
    this.huntStartedAt = null;
    this.lastSnapshot = null;
    this.debugInfo = {};                // spec §36
    this.cancelToken = { cancelled: false };
  }

  cancelAll() { this.cancelToken.cancelled = true; }

  async snap() {
    const s = await this.perception.snapshot();
    this.lastSnapshot = s;
    this.telemetry.updateFromSnapshot(s);
    return s;
  }

  routeFor(name) {
    const def = this.profile.cavebot.routes.find(r => r.route === name);
    if (!def) throw new Error(`Route not found in profile: ${name}`);
    return new Route(def);
  }
}

export class BotEngine {
  /**
   * @param {object} opts { profile, world, db, tickMs, onEvent }
   */
  constructor({ profile, world, db, tickMs = 50, onEvent = null }) {
    this.ctx = new BotContext({ profile, world, db });
    this.tickMs = tickMs;
    if (onEvent) this.ctx.telemetry.onRealtime = onEvent;
    this.machine = new StateMachine({
      states: buildStates(this.ctx),
      onEvent: (e) => this.ctx.telemetry.record(e),
      tickMs,
    });
    this.status = BotStates.OFFLINE;
    this.ctx.machine_ref = this.machine;
  }

  async start() {
    const ctx = this.ctx;
    const snap = await ctx.snap();
    ctx.telemetry.startSession({
      character: ctx.profile.settings.name,
      levelStart: snap.level, xpStart: snap.experience,
    });
    await this.machine.start(ctx, BotStates.STARTING);
    this.status = this.machine.current;
    ctx.telemetry.log('INFO', `Bot engine started (profile: ${ctx.profile.settings.name})`);
    return ctx.telemetry.session;
  }

  async stop() {
    await this.machine.stop();
    this.status = BotStates.STOPPED;
  }

  async pause() { await this.machine.pause(); }
  async resume() { await this.machine.resume(); }

  /** live status object consumed by API/UI/overlay — always derived from runtime */
  health() {
    const ctx = this.ctx;
    return {
      bot: this.machine.running ? (this.machine.paused ? 'paused' : 'running') : 'stopped',
      state: this.machine.current,
      perception: ctx.perception.health(),
      navigation: ctx.navigator.status(),
      snapshot: ctx.lastSnapshot ? {
        hpPercent: ctx.lastSnapshot.hpPercent,
        manaPercent: ctx.lastSnapshot.manaPercent,
        capacity: ctx.lastSnapshot.capacity,
        position: ctx.lastSnapshot.position,
        level: ctx.lastSnapshot.level,
        battleList: ctx.lastSnapshot.battleList ?? [],
        containers: ctx.lastSnapshot.containers ?? [],
        target: ctx.targetEngine.currentTarget?.name ?? null,
      } : null,
      statistics: ctx.telemetry.statistics(),
      debug: ctx.debugInfo,
      errors: ctx.perception.errors,
    };
  }
}

/* ------------------------------------------------------------------ */
/* STATE DEFINITIONS (spec §5) — each with enter/tick/exit             */
/* ------------------------------------------------------------------ */

function buildStates(ctx) {
  const S = new Map();

  const go = async (state, reason) => {
    if (ctx.cancelToken.cancelled) return; // stop has max priority (§4.2)
    await ctx.machine_ref.transition(state, reason);
  };

  S.set(BotStates.STARTING, {
    id: BotStates.STARTING,
    async enter() { ctx.telemetry.log('INFO', 'STARTING — verifying character'); },
    async tick() {
      const snap = await ctx.snap();
      if (snap.dead) return go(BotStates.DEAD, 'dead at login');
      if (snap.level <= 0) return go(BotStates.LOGIN_CHECK, 'no character');
      await go(BotStates.PREPARE, 'character verified');
    },
  });

  S.set(BotStates.LOGIN_CHECK, {
    id: BotStates.LOGIN_CHECK,
    async tick() {
      const snap = await ctx.snap();
      if (snap.level > 0) return go(BotStates.PREPARE, 'login ok');
      ctx.telemetry.log('ERROR', 'Character not logged in — waiting');
    },
  });

  S.set(BotStates.PREPARE, {
    id: BotStates.PREPARE,
    async enter() {
      ctx.telemetry.log('INFO', 'PREPARE — loading route & blessings');
      ctx.navigator.loadRoute(ctx.routeFor(ctx.huntConfig.route));
      ctx.navigator.recoveryAttempts = 0;
      ctx.cancelToken = { cancelled: false };
    },
    async tick() {
      const snap = await ctx.snap();
      if (ctx.bless.needsBless(snap)) return go(BotStates.BLESS, 'bless missing');
      await go(BotStates.TRAVEL, 'prepared');
    },
  });

  S.set(BotStates.BLESS, {
    id: BotStates.BLESS,
    async enter() {
      ctx.telemetry.log('INFO', 'BLESS — casting blessings (§17)');
      await ctx.bless.getBless();
    },
    async tick() {
      const snap = await ctx.snap();
      if (snap.playerStatus?.blessed) return go(BotStates.TRAVEL, 'blessed');
      await go(BotStates.ERROR, 'bless failed');
    },
  });

  S.set(BotStates.TRAVEL, {
    id: BotStates.TRAVEL,
    async enter() {
      ctx.telemetry.record({ type: TelemetryEvents.TRAVEL_STARTED, payload: { to: 'hunt' } });
      ctx.telemetry.log('INFO', 'TRAVEL — heading to hunt location');
    },
    async tick() {
      const snap = await ctx.snap();
      // Safety net (§30): if the TRAVEL tick ever runs while already at a
      // city-side destination, hand over to REFILL instead of looping here.
      // (Prevents the BANK→TRAVEL→REFILL livelock: teleport keeps us at city.)
      const cityPosNow = ctx.travel.resolve('city');
      const needsNow = ctx.resources.evaluate(snap);
      if ((needsNow.refill || needsNow.sell) && cityPosNow && distance(snap.position, cityPosNow) < 5) {
        ctx.telemetry.record({ type: TelemetryEvents.TRAVEL_COMPLETED, payload: { arrived: 'city' } });
        return go(BotStates.REFILL, 'already at city — refill pipeline');
      }
      const res = await ctx.navigator.tickWaypoint({
        resolveTravel: (name) => ctx.travel.resolve(name),
      });
      if (res.error) return go(BotStates.ERROR, res.error);
      if (res.ok === false && res.reason === 'unreachable') return go(BotStates.DANGER, 'route unreachable');
      const wpAfter = ctx.navigator.currentWaypoint();
      // A city-side waypoint only diverts to REFILL when the engine actually
      // needs supplies/space; otherwise it is just traversed by the route.
      if (wpAfter && [WaypointTypes.SELL, WaypointTypes.REFILL, WaypointTypes.BANK, WaypointTypes.DEPOSIT].includes(wpAfter.type)) {
        const needs = ctx.resources.evaluate(snap);
        if (needs.refill || needs.sell) {
          ctx.telemetry.record({ type: TelemetryEvents.TRAVEL_COMPLETED, payload: { arrived: 'city' } });
          return go(BotStates.REFILL, 'arrived at city for refill/sell');
        }
      }
      const atHunt = wpAfter?.type === WaypointTypes.HUNT ||
        distance(snap.position, ctx.travel.resolve('hunt')) < 20;
      if (atHunt) {
        ctx.telemetry.record({ type: TelemetryEvents.TRAVEL_COMPLETED, payload: { arrived: 'hunt' } });
        ctx.huntStartedAt = Date.now();
        await go(BotStates.HUNT, 'arrived at hunt');
      }
    },
  });

  S.set(BotStates.HUNT, {
    id: BotStates.HUNT,
    async enter() { ctx.telemetry.log('INFO', 'HUNT — engaging cycle'); },
    async tick() {
      const snap = await ctx.snap();
      if (snap.dead) return go(BotStates.DEAD, 'death detected');
      if (ctx.emergency.shouldTrigger(snap)) return go(BotStates.EMERGENCY, 'emergency condition');

      const needs = ctx.resources.evaluate(snap);
      if (needs.warning) ctx.telemetry.log('WARNING', needs.warning);

      await ctx.hotkeys.apply(snap); // hotkeys run continuously (§13)

      const wp = ctx.navigator.currentWaypoint();
      if (wp && wp.type !== WaypointTypes.HUNT && wp.type !== WaypointTypes.REFILL) {
        const res = await ctx.navigator.tickWaypoint({ resolveTravel: n => ctx.travel.resolve(n) });
        if (res.ok === false && res.reason === 'unreachable') return go(BotStates.DANGER, 'route unreachable');
      }

      const sel = ctx.targetEngine.select(snap);
      if (sel.target) return go(BotStates.TARGET, `target ${sel.target.name}`);

      const corpse = ctx.lootEngine.nextCorpse(snap);
      if (corpse) return go(BotStates.LOOT, 'corpse available');

      if (needs.refill || needs.sell) return go(BotStates.EVALUATE, 'resources need handling');

      if (ctx.huntConfig.duration && ctx.huntStartedAt &&
          Date.now() - ctx.huntStartedAt > ctx.huntConfig.duration * 1000) {
        return go(BotStates.EVALUATE, 'hunt objective complete');
      }

      const center = ctx.travel.resolve('hunt');
      await ctx.navigator.walkTo(center);
      ctx.debugInfo = {
        state: 'HUNT', position: posStr(snap.position), next: ctx.navigator.status().nextWaypoint,
        decision: 'no targets — repositioning in hunt area', lastAction: ctx.actions.lastAction?.name,
      };
    },
  });

  S.set(BotStates.TARGET, {
    id: BotStates.TARGET,
    async enter() {
      const t = ctx.targetEngine.currentTarget;
      if (t) {
        ctx.telemetry.record({ type: TelemetryEvents.TARGET_SELECTED, payload: { name: t.name, id: t.id } });
        ctx.telemetry.log('INFO', `Target: ${t.name}`);
      }
    },
    async tick() {
      const snap = await ctx.snap();
      if (snap.dead) return go(BotStates.DEAD, 'death during targeting');
      if (ctx.emergency.shouldTrigger(snap)) return go(BotStates.EMERGENCY, 'emergency during target');
      const sel = ctx.targetEngine.select(snap);
      if (!sel.target) return go(BotStates.HUNT, 'target lost');
      await go(BotStates.COMBAT, `attacking ${sel.target.name}`);
    },
  });

  S.set(BotStates.COMBAT, {
    id: BotStates.COMBAT,
    async enter() { ctx.combat.attackingSince = null; },
    async tick() {
      const snap = await ctx.snap();
      if (snap.dead) return go(BotStates.DEAD, 'died in combat');
      await ctx.hotkeys.apply(snap); // potions keep firing in combat (§13)
      if (ctx.emergency.shouldTrigger(snap)) return go(BotStates.EMERGENCY, 'emergency in combat');

      const res = await ctx.combat.tick(snap);
      ctx.debugInfo = {
        state: 'COMBAT', target: ctx.targetEngine.currentTarget?.name,
        position: posStr(snap.position),
        decision: `priority ${ctx.targetEngine.ruleFor(ctx.targetEngine.currentTarget?.name)?.priority ?? '-'}`,
        lastAction: res.action,
      };
      if (res.action === 'KILL') {
        // refresh snapshot so kills/xp are already accounted when telemetry
        // and LOOT state read the session statistics (§20/§21)
        await ctx.snap();
        ctx.telemetry.record({ type: TelemetryEvents.TARGET_KILLED, payload: { name: res.target, id: res.targetId } });
        ctx.telemetry.log('INFO', `${res.target} killed`);
        return go(BotStates.LOOT, 'kill confirmed');
      }
      if (!res.fighting) return go(BotStates.HUNT, 'no target');
    },
  });

  S.set(BotStates.LOOT, {
    id: BotStates.LOOT,
    async tick() {
      const snap = await ctx.snap();
      if (snap.dead) return go(BotStates.DEAD, 'death while looting');
      const res = await ctx.lootEngine.lootNearest(snap, ctx.actions);
      if (res.approaching) return; // walking to corpse — retry next tick at the tile
      if (res.ok && res.items) {
        ctx.telemetry.record({ type: TelemetryEvents.LOOT_COLLECTED, payload: { items: res.items } });
        ctx.telemetry.log('INFO', `Loot collected (${res.items})`);
        // value comes from the world's own accounting when bag is sold;
        // here we track item count only until SELL converts it to gold.
      }
      const more = ctx.lootEngine.nextCorpse(ctx.lastSnapshot);
      if (more) return; // keep looting/approaching next tick
      const needs = ctx.resources.evaluate(ctx.lastSnapshot);
      if (needs.sell || needs.refill) return go(BotStates.EVALUATE, 'after loot');
      await go(BotStates.HUNT, 'loot done');
    },
  });

  S.set(BotStates.EVALUATE, {
    id: BotStates.EVALUATE,
    async tick() {
      const snap = await ctx.snap();
      const needs = ctx.resources.evaluate(snap);
      ctx.telemetry.log('INFO', `EVALUATE — refill:${needs.refill} sell:${needs.sell} emergency:${needs.emergency}`);
      if (needs.emergency) return go(BotStates.EMERGENCY, 'evaluated emergency');
      if (needs.refill || needs.sell) {
        try { ctx.navigator.loadRoute(ctx.routeFor('city-loop')); } catch {
          ctx.navigator.loadRoute(new Route({
            route: 'city-loop-auto', loop: false,
            waypoints: [{ type: 'TRAVEL', destination: 'city' }],
          }));
        }
        return go(BotStates.TRAVEL, 'returning for refill/sell');
      }
      ctx.navigator.loadRoute(ctx.routeFor(ctx.huntConfig.route));
      ctx.huntStartedAt = Date.now();
      await go(BotStates.HUNT, 'resources OK — resume hunt');
    },
  });

  S.set(BotStates.REFILL, {
    id: BotStates.REFILL,
    async enter() {
      ctx.telemetry.record({ type: TelemetryEvents.REFILL_STARTED, payload: {} });
      ctx.telemetry.log('INFO', 'REFILL — buying supplies at shop NPC');
    },
    async tick() {
      const snap = await ctx.snap();
      const inv = Object.fromEntries((snap.inventory || []).map(i => [i.name, i.count]));
      const want = (ctx.huntConfig.minPotions ?? 50) * 2;
      let didSomething = false;
      if ((inv.healthPotion ?? 0) < ctx.huntConfig.minPotions) { await ctx.actions.buyPotions('health', want); didSomething = true; }
      if ((inv.manaPotion ?? 0) < ctx.huntConfig.minPotions) { await ctx.actions.buyPotions('mana', want); didSomething = true; }
      if ((inv.spear ?? 0) < 100) { await ctx.actions.buyAmmunition(200); didSomething = true; }
      if (!didSomething) {
        ctx.telemetry.record({ type: TelemetryEvents.REFILL_COMPLETED, payload: {} });
        ctx.telemetry.log('INFO', 'REFILL completed');
        await go(BotStates.SELL_LOOT, 'refill done → sell');
      }
    },
  });

  S.set(BotStates.SELL_LOOT, {
    id: BotStates.SELL_LOOT,
    async tick() {
      const r = await ctx.actions.sell();
      if (r.sold > 0) {
        ctx.telemetry.counters.lootValue += r.gold;
        ctx.telemetry.log('INFO', `Sold ${r.sold} items for ${r.gold} gold`);
      }
      await go(BotStates.BANK, 'sold loot');
    },
  });

  S.set(BotStates.BANK, {
    id: BotStates.BANK,
    async tick() {
      const snap = await ctx.snap();
      const gold = snap.playerStatus?.gold ?? 0;
      if (gold > 10_000) {
        const d = await ctx.actions.deposit(gold - 1000);
        ctx.telemetry.log('INFO', `Deposited ${d} gold`);
      }
      ctx.navigator.loadRoute(ctx.routeFor(ctx.huntConfig.route));
      ctx.huntStartedAt = Date.now();
      await go(BotStates.TRAVEL, 'banked — back to hunt');
    },
  });

  S.set(BotStates.DANGER, {
    id: BotStates.DANGER,
    async tick() {
      const snap = await ctx.snap();
      ctx.telemetry.log('WARNING', `DANGER level ${snap.dangerLevel} — retreating locally`);
      const center = ctx.travel.resolve('hunt');
      await ctx.navigator.walkTo({ x: center.x + 10, y: center.y + 10, z: center.z });
      if (ctx.emergency.shouldTrigger(snap)) return go(BotStates.EMERGENCY, 'danger escalated');
      await go(BotStates.HUNT, 'danger passed');
    },
  });

  S.set(BotStates.EMERGENCY, {
    id: BotStates.EMERGENCY,
    async enter() {
      ctx.telemetry.record({ type: TelemetryEvents.EMERGENCY, payload: { trigger: ctx.lastSnapshot?.hpPercent } });
      ctx.telemetry.log('ERROR', 'EMERGENCY — full retreat to city');
    },
    async tick() {
      await ctx.emergency.retreat();
      const snap = await ctx.snap();
      const safe = distance(snap.position, ctx.travel.resolve('city')) < 5 && snap.hpPercent > 50;
      if (safe) {
        ctx.telemetry.log('INFO', 'Emergency resolved — evaluating recovery plan');
        await go(BotStates.EVALUATE, 'safe in city');
      }
    },
  });

  S.set(BotStates.DEAD, {
    id: BotStates.DEAD,
    async enter() {
      const snap = ctx.lastSnapshot ?? await ctx.snap();
      const evt = ctx.recovery.onDeath(snap, { route: ctx.navigator.route?.name });
      if (ctx.dbRef) ctx.dbRef.saveDeath?.(evt, ctx.telemetry.session?.sessionId);
    },
    async tick() {
      await go(BotStates.RECOVERY, 'begin recovery flow');
    },
  });

  S.set(BotStates.RECOVERY, {
    id: BotStates.RECOVERY,
    async tick() {
      await ctx.recovery.recover(ctx.lastSnapshot);
      const snap = await ctx.snap();
      if (snap.dead) return; // respawn pending, retry next tick
      const needs = ctx.resources.evaluate(snap);
      if (needs.refill || needs.sell) {
        try { ctx.navigator.loadRoute(ctx.routeFor('city-loop')); } catch {}
        return go(BotStates.EVALUATE, 'post-death restock');
      }
      if (ctx.bless.needsBless(snap)) return go(BotStates.BLESS, 'post-death bless');
      ctx.navigator.loadRoute(ctx.routeFor(ctx.huntConfig.route));
      ctx.huntStartedAt = Date.now();
      await go(BotStates.TRAVEL, 'recovered — returning to route');
    },
  });

  S.set(BotStates.PAUSED, { id: BotStates.PAUSED, async tick() {} });

  S.set(BotStates.STOPPING, {
    id: BotStates.STOPPING,
    async enter() {
      ctx.telemetry.log('INFO', 'STOPPING — cancelling actions, halting movement/combat/loot/travel');
      ctx.targetEngine.clear();
    },
    async tick() {},
  });

  S.set(BotStates.STOPPED, {
    id: BotStates.STOPPED,
    async enter() {
      const s = ctx.telemetry.endSession(); // persist session (§4.2)
      if (s) ctx.telemetry.log('INFO', 'Runtime fully stopped, session persisted');
    },
    async tick() {},
  });

  S.set(BotStates.ERROR, {
    id: BotStates.ERROR,
    async enter() {
      ctx.telemetry.log('ERROR', 'ERROR state entered — halting automation');
    },
    async tick() {
      // MVP policy: one safe return to city, then STOPPED. Never blind-resume (§30).
      await ctx.emergency.retreat();
      await ctx.machine_ref.stop();
    },
  });

  return S;
}

function posStr(p) { return `${p.x}/${p.y}/${p.z}`; }
