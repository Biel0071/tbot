'use strict';

/**
 * scripts/validate-mvp.js
 * Quality Gate estático do T BOT — Autonomous Tibia Bot (MVP 1.0)
 *
 * Valida:
 *  1. Existência dos arquivos obrigatórios do ecossistema.
 *  2. Sintaxe de todos os módulos JS (node --check).
 *  3. CSS char-fullscreen sem faixa preta (grid-template-columns:1fr + grid-column:1/-1).
 *  4. Logo central interativa (#centerLogoLauncher / #btnLaunchClientLogo) na UI.
 *  5. Endpoints registrados no server: POST /api/client/launch, POST /api/client/click, GET /api/learning.
 *  6. Cache-Control: no-store em serveStatic().
 *  7. Zero credenciais/segredos expostos (heurística de padrões sensíveis).
 *
 * Exit code 0 = PASS | 1 = FAIL
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    const msg = fn();
    passes += 1;
    console.log(`  ✔ ${name}${msg ? ' — ' + msg : ''}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✘ ${name} — ${err.message}`);
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('T BOT — Quality Gate (validate-mvp)\n');

// 1) Arquivos obrigatórios
console.log('[1] Arquivos obrigatórios');
const REQUIRED_FILES = [
  'package.json',
  'vitest.config.js',
  'apps/desktop/index.html',
  'apps/desktop/ui/app.js',
  'runtime/adapters/rubinot-win32.js',
  'runtime/api/manager.js',
  'runtime/api/server.js',
  'tests/rubinot-modules.test.js',
];
for (const f of REQUIRED_FILES) {
  check(f, () => {
    must(fs.existsSync(path.join(ROOT, f)), 'ausente');
    return `${fs.statSync(path.join(ROOT, f)).size} bytes`;
  });
}

// 2) Sintaxe JS (vitest.config.js é ESM → validado com --input-type=module)
console.log('\n[2] Sintaxe (node --check)');
const JS_FILES = [
  'apps/desktop/ui/app.js',
  'runtime/adapters/rubinot-win32.js',
  'runtime/api/manager.js',
  'runtime/api/server.js',
  'scripts/validate-mvp.js',
];
for (const f of JS_FILES) {
  check(f, () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    return 'ok';
  });
}
check('vitest.config.js (ESM)', () => {
  const src = read('vitest.config.js');
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
  return 'ok';
});

// 3) CSS char-fullscreen
console.log('\n[3] CSS char-fullscreen sem faixa preta');
check('body.char-fullscreen #app grid 1fr + rows 34px 1fr 38px', () => {
  const html = read('apps/desktop/index.html');
  must(/body\.char-fullscreen\s+#app\s*\{[^}]*grid-template-columns:\s*1fr/.test(html), 'faltando grid-template-columns:1fr');
  must(/body\.char-fullscreen\s+#app\s*\{[^}]*grid-template-rows:\s*34px\s+1fr\s+38px/.test(html), 'faltando grid-template-rows');
  return 'grid corrigido';
});
check('header/main/footer grid-column:1/-1 em char-fullscreen', () => {
  const html = read('apps/desktop/index.html');
  must(
    /body\.char-fullscreen\s+header[\s\S]{0,160}?body\.char-fullscreen\s+main[\s\S]{0,160}?body\.char-fullscreen\s+footer\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(html),
    'faltando grid-column:1/-1'
  );
  return 'sem coluna 0px fantasma';
});

// 4) Logo central
console.log('\n[4] Logo central interativa');
check('#centerLogoLauncher + #btnLaunchClientLogo + #liveCharFrame', () => {
  const html = read('apps/desktop/index.html');
  const ui = read('apps/desktop/ui/app.js');
  must(html.includes('id="centerLogoLauncher"'), 'logo ausente no HTML');
  must(html.includes('id="btnLaunchClientLogo"'), 'botão ausente no HTML');
  must(html.includes('id="liveCharFrame"'), 'frame ausente no HTML');
  must(ui.includes('/api/client/launch'), 'UI não chama /api/client/launch');
  must(ui.includes('/api/client/frame'), 'UI não usa /api/client/frame');
  return 'clica e abre/foca cliente real';
});

// 5) Endpoints
console.log('\n[5] Endpoints do runtime');
check('POST /api/client/launch | POST /api/client/click | GET /api/learning', () => {
  const srv = read('runtime/api/server.js');
  must(srv.includes("'/api/client/launch'") && srv.includes("req.method === 'POST'"), 'launch ausente');
  must(srv.includes("'/api/client/click'"), 'click ausente');
  must(srv.includes("'/api/learning'"), 'learning ausente');
  const mgr = read('runtime/api/manager.js');
  must(mgr.includes('launchClient') && mgr.includes('sendClientClick') && mgr.includes('getLearning'), 'métodos do manager ausentes');
  return '3 endpoints ok';
});

// 6) Cache-Control
console.log('\n[6] Cache-Control no-store');
check("serveStatic() com 'no-store, no-cache, must-revalidate'", () => {
  const srv = read('runtime/api/server.js');
  must(srv.includes("'Cache-Control': 'no-store, no-cache, must-revalidate'"), 'faltando header no-store');
  return 'estáticos sempre frescos';
});

// 7) Segredos
console.log('\n[7] Zero segredos expostos');
check('heurística de credenciais', () => {
  const filesToScan = [...REQUIRED_FILES.filter((f) => !f.endsWith('.json')), 'rubinot_bot/config/settings.py'];
  const patterns = [
    /(api[_-]?key|secret|password|token)\s*[=:]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    /AKIA[0-9A-Z]{16}/,
  ];
  for (const f of filesToScan) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf8');
    for (const re of patterns) {
      must(!re.test(content), `possível segredo em ${f}`);
    }
  }
  return 'nenhum padrão sensível';
});

console.log(`\nResultado: ${passes} PASS / ${failures} FAIL`);
if (failures > 0) {
  console.error('QUALITY GATE: FAIL');
  process.exit(1);
}
console.log('QUALITY GATE: PASS ✔');
process.exit(0);
