/**
 * T BOT — Travel Engine (spec §16) + Refill flow helpers (§15) + Bless (§17)
 * Abstraction over city/boat/teleport/NPC destinations. In the simulated world
 * travel is a teleport to a named destination; in the real build each
 * destination maps to a cavebot sub-route (NPC dialog → boat → arrival wp).
 */

import { distance } from '../../core/types/index.js';

export class TravelManager {
  constructor(destinations = {}) {
    // name -> Position (or sub-route id in real build)
    this.destinations = {
      city: { x: 800, y: 800, z: 7 },
      shop: { x: 798, y: 800, z: 7 },
      depot: { x: 802, y: 800, z: 7 },
      temple: { x: 805, y: 795, z: 7 },
      hunt: { x: 1000, y: 1000, z: 7 },
      ...destinations,
    };
  }
  resolve(name) { return this.destinations[name]; }
  register(name, pos) { this.destinations[name] = pos; }
  at(name, snapshot, tolerance = 3) {
    const d = this.resolve(name);
    return d ? distance(snapshot.position, d) <= tolerance : false;
  }
}

export const BLESS_NAMES = ['ADORI', 'UTANI GRAV', 'EVIS MAJ', 'INTE GRAV', 'AUSVO GRANT'];

export class BlessManager {
  constructor({ required = true, actions }) {
    this.required = required;
    this.actions = actions;
  }
  needsBless(snapshot) {
    return this.required && !snapshot.playerStatus?.blessed;
  }
  async getBless() {
    return this.actions.bless(BLESS_NAMES);
  }
}
