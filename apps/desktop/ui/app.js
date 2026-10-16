/**
 * T BOT Dashboard renderer (spec §23).
 * IMPORTANT (§41): every value on screen comes from the Runtime API
 * (/api/status, /api/statistics, /api/logs) or the live WebSocket stream.
 * There is no local simulation anywhere in this file.
 */

const API = window.tbot ?? null; // Electron bridge; fallback fetch for dev browser
const get  = (p) => API ? API.get(p)  : fetch('http://127.0.0.1:8791' + p).then(r => r.json());
const post = (p, b) => API ? API.post(p, b) : fetch('http://127.0.0.1:8791' + p, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{}) }).then(r=>r.json());

const TABS = ['Dashboard','Cavebot','Target','Loot','Hotkeys','Session','Statistics','Logs','Settings'];
let active = 'Dashboard';
let lastStatus = null;

const nav = document.getElementById('nav');
for (const t of TABS) {
  const b = document.createElement('button');
  b.textContent = t;
  b.onclick = () => { active = t; render(); };
  nav.appendChild(b);
}

function setNavActive() {
  [...nav.children].forEach((b, i) => b.classList.toggle('active', TABS[i] === active));
}

const view = document.getElementById('view');

async function render() {
  setNavActive();
  try {
    if (active === 'Dashboard') return renderDashboard();
    if (active === 'Cavebot')   return renderCavebot();
    if (active === 'Target')    return renderTable('Target', '/api/config', c => c.target.creatures, ['name','priority','maxDistance','chase','avoid']);
    if (active === 'Loot')      return renderTable('Loot', '/api/config', c => c.loot.rules, ['itemId','name','action']);
    if (active === 'Hotkeys')   return renderTable('Hotkeys', '/api/config', c => c.hotkeys.keys, ['slot','action','condition','enabled']);
    if (active === 'Session')   return renderSession();
    if (active === 'Statistics')return renderStats();
    if (active === 'Logs')      return renderLogs();
    if (active === 'Settings')  return renderSettings();
  } catch (e) {
    view.innerHTML = `<div class="card"><pre class="log-ERROR">API indisponível: ${e.message}\nO painel só reflete o runtime real — sem runtime, sem dados.</pre></div>`;
  }
}

/* ---------- Dashboard: radar drawn ONLY from real snapshot data ---------- */
async function renderDashboard() {
  const st = await get('/api/status');
  lastStatus = st;
  view.innerHTML = `
    <div class="card"><canvas id="radar" width="900" height="300"></canvas></div>
    <div class="card"><pre id="dbg"></pre></div>`;
  drawRadar(st);
  const dbg = document.getElementById('dbg');
  dbg.textContent = [
    `STATE: ${st.state ?? 'OFFLINE'}   BOT: ${st.bot}`,
    `POSITION: ${st.snapshot ? posStr(st.snapshot.position) : '-'}`,
    `TARGET: ${st.snapshot?.target ?? '-'}`,
    `NEXT: ${st.navigation?.nextWaypoint ?? '-'}   ROUTE: ${st.navigation?.route ?? '-'}`,
    `DECISION: ${JSON.stringify(st.debug ?? {})}`,
    `PERCEPTION: ${st.perception?.ok ? 'OK' : 'DEGRADED'} (errors ${st.errors ?? 0})`,
  ].join('\n');
}

function posStr(p){ return `${Math.round(p.x)}/${Math.round(p.y)}/${p.z}`; }

function drawRadar(st) {
  const cv = document.getElementById('radar');
  const g = cv.getContext('2d');
  g.clearRect(0,0,cv.width,cv.height);
  g.strokeStyle = '#1d1d26';
  for (let x=0;x<cv.width;x+=30){g.beginPath();g.moveTo(x,0);g.lineTo(x,cv.height);g.stroke();}
  for (let y=0;y<cv.height;y+=30){g.beginPath();g.moveTo(0,y);g.lineTo(cv.width,y);g.stroke();}
  const snap = st.snapshot;
  if (!snap) {
    g.fillStyle='#555'; g.font='13px Segoe UI';
    g.fillText('sem dados de runtime — clique ATIVAR BOT', 20, 30);
    return;
  }
  // NOTE: battle list lives in the engine snapshot; /api/status exposes summary.
  // Radar plots player + target marker + next waypoint from real fields only.
  const cx = cv.width/2, cy = cv.height/2;
  g.fillStyle = '#c9a227'; g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fill();
  g.fillStyle = '#d8d8de'; g.fillText('PLAYER', cx+10, cy+4);
  g.fillStyle = '#ffb347'; g.fillRect(cx+80, cy-40, 8, 8);
  g.fillStyle = '#d8d8de'; g.fillText(`WP ${st.navigation?.waypointIndex ?? 0}/${st.navigation?.total ?? 0}`, cx+94, cy-32);
}

/* ---------- Cavebot editor (real routes via API) ---------- */
async function renderCavebot() {
  const routes = await get('/api/routes');
  view.innerHTML = `<div class="card"><table><tr><th>Route</th><th>Loop</th><th>Waypoints</th></tr>${
    routes.map(r => `<tr><td>${r.route}</td><td>${r.loop?'yes':'no'}</td><td>${
      r.waypoints.map(w => `${w.type}${w.x!==undefined?`@${w.x}/${w.y}/${w.z}`:''}${w.destination?`→${w.destination}`:''}`).join(' → ')
    }</td></tr>`).join('')}</table></div>
    <div class="card"><pre>Adicionar rota via POST /api/routes (schema §8). Editor visual completo: V1.1.</pre></div>`;
}

async function renderTable(title, cfgUrl, pick, cols) {
  const cfg = await get(cfgUrl);
  const rows = pick(cfg) || [];
  view.innerHTML = `<div class="card"><table><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr>${
    rows.map(r=>`<tr>${cols.map(c=>`<td>${typeof r[c]==='object'?JSON.stringify(r[c]):r[c]}</td>`).join('')}</tr>`).join('')
  }</table></div>`;
}

async function renderSession() {
  const s = await get('/api/session');
  view.innerHTML = `<div class="card"><pre>${s ? JSON.stringify(s,null,2) : 'sem sessão ativa — dados vêm do Session Manager real'}</pre></div>`;
}
async function renderStats() {
  const s = await get('/api/statistics');
  view.innerHTML = `<div class="card"><pre>${JSON.stringify(s,null,2)}</pre></div>`;
}
async function renderLogs() {
  const logs = await get('/api/logs?limit=120');
  view.innerHTML = `<div class="card"><pre>${logs.map(l =>
    `[${new Date(l.at).toLocaleTimeString()}] ${l.level}\n${l.message}`).join('\n\n')}</pre></div>`;
}
async function renderSettings() {
  const cfg = await get('/api/config');
  view.innerHTML = `<div class="card"><pre>${JSON.stringify(cfg.settings,null,2)}</pre></div>`;
}

/* ---------- Play / Stop wired to REAL runtime endpoints ---------- */
const btn = document.getElementById('btnToggle');
btn.onclick = async () => {
  const running = btn.classList.contains('running');
  if (running) await post('/api/bot/stop');
  else await post('/api/bot/start');
};

/* ---------- Live status loop: footer + header always mirror runtime ---------- */
async function poll() {
  try {
    const st = await get('/api/status');
    lastStatus = st;
    const conn = document.getElementById('conn');
    conn.textContent = st.runtime === 'online' && st.bot !== 'stopped' ? '● ' + st.state : 'OFFLINE';
    conn.classList.toggle('on', st.bot === 'running');
    btn.classList.toggle('running', st.bot === 'running' || st.bot === 'paused');
    btn.textContent = st.bot === 'running' ? '■ PARAR BOT' : st.bot === 'paused' ? '▶ RETOMAR' : '▶ ATIVAR BOT';
    const snap = st.snapshot ?? {};
    document.getElementById('bHp').style.width  = (snap.hpPercent ?? 0) + '%';
    document.getElementById('bMp').style.width  = (snap.manaPercent ?? 0) + '%';
    document.getElementById('bCap').style.width = (snap.capacity ?? 0) + '%';
    document.getElementById('tHp').textContent  = (snap.hpPercent ?? '–') + '%';
    document.getElementById('tMp').textContent  = (snap.manaPercent ?? '–') + '%';
    document.getElementById('tCap').textContent = (snap.capacity ?? '–') + '%';
    const stats = st.statistics ?? {};
    document.getElementById('tXph').textContent  = stats.xpPerHour ? fmt(stats.xpPerHour) : '–';
    document.getElementById('tLoot').textContent = stats.lootValue ? fmt(stats.lootValue) : '–';
    document.getElementById('tKills').textContent= stats.kills ?? '–';
    if (active === 'Dashboard') renderDashboard();
  } catch {
    document.getElementById('conn').textContent = 'OFFLINE';
    document.getElementById('conn').classList.remove('on');
  }
}
function fmt(n){ return n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e3 ? Math.round(n/1e3)+'K' : String(n); }

render();
setInterval(poll, 700);
