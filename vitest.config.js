// vitest.config.js — Quality Gate do T BOT — Autonomous Tibia Bot (MVP 1.0)
// Garante que TODOS os testes em tests/**/*.test.js sejam executados com exit code 0.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false,
    // Cada teste sobe um servidor HTTP efêmero em porta própria; sem paralelismo excessivo.
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ['default'],
  },
});
