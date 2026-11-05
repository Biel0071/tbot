'use strict';

/**
 * runtime/bot/in-game-engine.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0) — In-Game Combat & Healing Engine
 *
 * Executa o loop autônomo in-game com avaliação de prioridades P1..P5:
 *   P1: Cura Crítica (Potion/Strong Heal) quando HP% <= healCritHp
 *   P2: Cura Regular (Spell) quando HP% <= healMinHp
 *   P3: Restauração de Mana (Potion) quando MP% <= manaMinMp
 *   P4: Seleção de Target / Auto-Attack (SPACE ou Target Key)
 *   P5: Caminhada de Cavebot por teclas direcionais Win32 (Setas/WASD)
 *
 * Registra todas as ações no BehaviorLearner e envia teclas reais Win32
 * quando IS_WINDOWS===true e o cliente está detectado.
 */

class InGameEngine {
  constructor(manager, opts = {}) {
    this.manager = manager;
    this.config = {
      healMinHp: opts.healMinHp ?? 85,
      healSpellKey: opts.healSpellKey || 'F1',
      healCritHp: opts.healCritHp ?? 45,
      healCritKey: opts.healCritKey || 'F2',
      manaMinMp: opts.manaMinMp ?? 60,
      manaPotionKey: opts.manaPotionKey || 'F3',
      attackKey: opts.attackKey || 'Space',
      walkRoute: opts.walkRoute || ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'],
      tickIntervalMs: opts.tickIntervalMs || 250,
      spellCooldownMs: opts.spellCooldownMs || 1000,
      potionCooldownMs: opts.potionCooldownMs || 1000,
      attackCooldownMs: opts.attackCooldownMs || 1500,
      walkCooldownMs: opts.walkCooldownMs || 800,
    };

    this.snapshot = {
      hpPercent: 100,
      manaPercent: 100,
      target: null,
      position: { x: 998, y: 1000, z: 7 },
    };

    this.cooldowns = {
      spell: 0,
      potion: 0,
      attack: 0,
      walk: 0,
    };

    this.stats = {
      healsCount: 0,
      critHealsCount: 0,
      manasCount: 0,
      attacksCount: 0,
      stepsCount: 0,
      totalTicks: 0,
      lastAction: null,
      lastActionAt: null,
    };

    this._timer = null;
    this._now = () => Date.now();
  }

  configure(opts = {}) {
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && k in this.config) {
        this.config[k] = v;
      }
    }
    return { ok: true, config: this.config };
  }

  updateSnapshot(snap = {}) {
    if (typeof snap.hpPercent === 'number') this.snapshot.hpPercent = Math.max(0, Math.min(100, snap.hpPercent));
    if (typeof snap.manaPercent === 'number') this.snapshot.manaPercent = Math.max(0, Math.min(100, snap.manaPercent));
    if (snap.target !== undefined) this.snapshot.target = snap.target;
    if (snap.position && typeof snap.position === 'object') {
      this.snapshot.position = { ...this.snapshot.position, ...snap.position };
    }
    return this.snapshot;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try {
        this.tick();
      } catch (_e) {
        /* loop protegido */
      }
    }, this.config.tickIntervalMs);
    this._timer.unref && this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Avalia um ciclo de prioridades do bot e despacha a ação necessária.
   */
  tick() {
    this.stats.totalTicks += 1;
    const now = this._now();

    // Se o agente principal não estiver 'running', não envia comandos in-game
    if (this.manager && this.manager.status !== 'running') {
      return { action: 'idle', reason: 'agent-not-running' };
    }

    const mods = (this.manager && this.manager.modules) || {};
    const adapter = this.manager && this.manager.adapter;

    // -------------------------------------------------- P1: Cura Crítica --
    if (mods.autoHeal && this.snapshot.hpPercent <= this.config.healCritHp) {
      if (now >= this.cooldowns.potion) {
        this.cooldowns.potion = now + this.config.potionCooldownMs;
        this.stats.critHealsCount += 1;
        this.stats.healsCount += 1;
        this.stats.lastAction = `CRIT_HEAL (${this.config.healCritKey})`;
        this.stats.lastActionAt = new Date().toISOString();
        if (adapter) {
          adapter.registerKey(this.config.healCritKey, { deliver: true, method: 'in-game-crit-heal' });
        }
        return { action: 'crit-heal', key: this.config.healCritKey, hp: this.snapshot.hpPercent };
      }
    }

    // -------------------------------------------------- P2: Cura Regular --
    if (mods.autoHeal && this.snapshot.hpPercent <= this.config.healMinHp) {
      if (now >= this.cooldowns.spell) {
        this.cooldowns.spell = now + this.config.spellCooldownMs;
        this.stats.healsCount += 1;
        this.stats.lastAction = `SPELL_HEAL (${this.config.healSpellKey})`;
        this.stats.lastActionAt = new Date().toISOString();
        if (adapter) {
          adapter.registerKey(this.config.healSpellKey, { deliver: true, method: 'in-game-spell-heal' });
        }
        return { action: 'spell-heal', key: this.config.healSpellKey, hp: this.snapshot.hpPercent };
      }
    }

    // --------------------------------------------------- P3: Mana Restore --
    if (mods.manaRestore && this.snapshot.manaPercent <= this.config.manaMinMp) {
      if (now >= this.cooldowns.potion) {
        this.cooldowns.potion = now + this.config.potionCooldownMs;
        this.stats.manasCount += 1;
        this.stats.lastAction = `MANA_POTION (${this.config.manaPotionKey})`;
        this.stats.lastActionAt = new Date().toISOString();
        if (adapter) {
          adapter.registerKey(this.config.manaPotionKey, { deliver: true, method: 'in-game-mana-potion' });
        }
        return { action: 'mana-potion', key: this.config.manaPotionKey, mp: this.snapshot.manaPercent };
      }
    }

    // -------------------------------------------------- P4: Auto Attack --
    if (mods.autoAttack && (!this.snapshot.target || this.snapshot.target === 'none')) {
      if (now >= this.cooldowns.attack) {
        this.cooldowns.attack = now + this.config.attackCooldownMs;
        this.stats.attacksCount += 1;
        this.snapshot.target = 'Target Selecionado';
        this.stats.lastAction = `AUTO_ATTACK (${this.config.attackKey})`;
        this.stats.lastActionAt = new Date().toISOString();
        if (adapter) {
          adapter.registerKey(this.config.attackKey, { deliver: true, method: 'in-game-auto-attack' });
        }
        return { action: 'auto-attack', key: this.config.attackKey, target: this.snapshot.target };
      }
    }

    // ---------------------------------------------------- P5: Cavebot Walk --
    if (mods.cavebot) {
      if (now >= this.cooldowns.walk) {
        this.cooldowns.walk = now + this.config.walkCooldownMs;
        const route = Array.isArray(this.config.walkRoute) && this.config.walkRoute.length ? this.config.walkRoute : ['ArrowRight'];
        const stepKey = route[this.stats.stepsCount % route.length];
        this.stats.stepsCount += 1;
        this.stats.lastAction = `CAVEBOT_WALK (${stepKey})`;
        this.stats.lastActionAt = new Date().toISOString();
        if (adapter) {
          adapter.registerKey(stepKey, { deliver: true, method: 'in-game-cavebot-walk' });
        }
        return { action: 'cavebot-walk', key: stepKey, step: this.stats.stepsCount };
      }
    }

    return { action: 'pass', lastAction: this.stats.lastAction };
  }

  getStatus() {
    return {
      ok: true,
      active: this.manager ? this.manager.status === 'running' : false,
      config: this.config,
      snapshot: this.snapshot,
      stats: this.stats,
      cooldowns: {
        spellRemaining: Math.max(0, this.cooldowns.spell - this._now()),
        potionRemaining: Math.max(0, this.cooldowns.potion - this._now()),
        attackRemaining: Math.max(0, this.cooldowns.attack - this._now()),
        walkRemaining: Math.max(0, this.cooldowns.walk - this._now()),
      },
    };
  }
}

module.exports = { InGameEngine };
