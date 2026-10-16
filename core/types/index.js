/**
 * T BOT — Core Types & Constants (spec §5, §6, §8, §10, §31)
 * Single source of truth for state ids, event types and data shapes.
 */

export const BotStates = Object.freeze({
  OFFLINE: 'OFFLINE',
  STARTING: 'STARTING',
  LOGIN_CHECK: 'LOGIN_CHECK',
  PREPARE: 'PREPARE',
  TRAVEL: 'TRAVEL',
  HUNT: 'HUNT',
  TARGET: 'TARGET',
  COMBAT: 'COMBAT',
  LOOT: 'LOOT',
  EVALUATE: 'EVALUATE',
  REFILL: 'REFILL',
  SELL_LOOT: 'SELL_LOOT',
  BANK: 'BANK',
  BLESS: 'BLESS',
  RECOVER: 'RECOVER',
  DANGER: 'DANGER',
  EMERGENCY: 'EMERGENCY',
  DEAD: 'DEAD',
  RECOVERY: 'RECOVERY',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
});

export const WaypointTypes = Object.freeze({
  WALK: 'WALK', STAND: 'STAND', NODE: 'NODE', LABEL: 'LABEL',
  ACTION: 'ACTION', REFILL: 'REFILL', BANK: 'BANK', SELL: 'SELL',
  TRAVEL: 'TRAVEL', HUNT: 'HUNT', DEPOSIT: 'DEPOSIT', LOOT: 'LOOT',
  RECOVER: 'RECOVER',
});

export const LootActions = Object.freeze({
  KEEP: 'KEEP', SELL: 'SELL', DEPOSIT: 'DEPOSIT', IGNORE: 'IGNORE', ALERT: 'ALERT',
});

export const TelemetryEvents = Object.freeze({
  BOT_STARTED: 'BOT_STARTED',
  BOT_STOPPED: 'BOT_STOPPED',
  STATE_CHANGED: 'STATE_CHANGED',
  TARGET_SELECTED: 'TARGET_SELECTED',
  TARGET_KILLED: 'TARGET_KILLED',
  LOOT_COLLECTED: 'LOOT_COLLECTED',
  REFILL_STARTED: 'REFILL_STARTED',
  REFILL_COMPLETED: 'REFILL_COMPLETED',
  TRAVEL_STARTED: 'TRAVEL_STARTED',
  TRAVEL_COMPLETED: 'TRAVEL_COMPLETED',
  DEATH: 'DEATH',
  RECOVERY: 'RECOVERY',
  ERROR: 'ERROR',
  STUCK: 'STUCK',
  EMERGENCY: 'EMERGENCY',
});

export const LogLevel = Object.freeze({ INFO: 'INFO', WARNING: 'WARNING', ERROR: 'ERROR' });

/**
 * @typedef {Object} Position
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {Object} Creature
 * @property {string} id
 * @property {string} name
 * @property {string} type        // 'player' | 'monster' | 'npc'
 * @property {number} hp
 * @property {number} maxHp
 * @property {Position} position
 * @property {boolean} visible
 */

/**
 * @typedef {Object} GameSnapshot  (spec §6)
 * @property {number} hp
 * @property {number} hpPercent
 * @property {number} mana
 * @property {number} manaPercent
 * @property {number} stamina
 * @property {number} capacity     // used %
 * @property {Position} position
 * @property {number} level
 * @property {number} experience
 * @property {Creature[]} battleList
 * @property {Creature|undefined} currentTarget
 * @property {Array} containers
 * @property {Array} inventory
 * @property {Array} cooldowns
 * @property {number} dangerLevel
 * @property {Object} playerStatus
 * @property {boolean} dead
 * @property {number} timestamp
 */

/**
 * @typedef {Object} BotStateDef   (spec §5)
 * @property {string} id
 * @property {(ctx: any) => Promise<void>} [enter]
 * @property {(ctx: any) => Promise<void>} tick
 * @property {(ctx: any) => Promise<void>} [exit]
 */

export function distance(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const dz = Math.abs(a.z - b.z) * 2; // z levels count double on Tibia maps
  return Math.max(dx, dy) + dz;
}

export function makeSnapshot(partial = {}) {
  return {
    hp: 0, hpPercent: 0, mana: 0, manaPercent: 0,
    stamina: 0, capacity: 0,
    position: { x: 0, y: 0, z: 0 },
    level: 0, experience: 0,
    battleList: [], currentTarget: undefined,
    containers: [], inventory: [], cooldowns: [],
    dangerLevel: 0, playerStatus: {},
    dead: false, timestamp: Date.now(),
    ...partial,
  };
}
