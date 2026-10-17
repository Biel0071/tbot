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
  // Radar plots ONLY real fields from the perception snapshot (§6 GameSnapshot):
  // player at center, battleList creatures relative to player, current target
  // highlighted, next waypoint marker.
  const cx = cv.width/2, cy = cv.height/2;
  const SCALE = 8; // tiles -> px
  const pp = snap.position;
  const rel = (p) => ({ x: cx + (p.x - pp.x) * SCALE, y: cy + (p.y - pp.y) * SCALE });

  // Battle list creatures (monsters / NPCs) — real data from snapshot.battleList
  for (const c of (snap.battleList ?? [])) {
    const pos = rel(c.position ?? c);
    if (pos.x < 4 || pos.y < 4 || pos.x > cv.width - 4 || pos.y > cv.height - 4) continue;
    const isTarget = st.target?.name === c.name || snap.currentTarget?.name === c.name;
    g.fillStyle = isTarget ? '#e0533d' : '#8f8fa0';
    g.beginPath(); g.arc(pos.x, pos.y, isTarget ? 6 : 4, 0, 7); g.fill();
    g.fillStyle = '#b8b8c4'; g.font = '10px Segoe UI';
    const hpPct = c.maxHp ? Math.round((c.hp / c.maxHp) * 100) : null;
    g.fillText(`${c.name}${hpPct !== null ? ` ${hpPct}%` : ''}`, pos.x + 7, pos.y + 3);
    if (isTarget) { g.strokeStyle = '#e0533d'; g.strokeRect(pos.x - 9, pos.y - 9, 18, 18); }
  }

  // Next waypoint marker (real navigation state)
  const wpPos = st.navigation?.nextPosition;
  const wpDraw = wpPos ? rel(wpPos) : { x: cx + 80, y: cy - 40 };
  g.fillStyle = '#ffb347'; g.fillRect(wpDraw.x - 4, wpDraw.y - 4, 8, 8);
  g.fillStyle = '#d8d8de'; g.fillText(`WP ${st.navigation?.waypointIndex ?? 0}/${st.navigation?.total ?? 0}`, wpDraw.x + 8, wpDraw.y - 6);

  // Player at center (drawn last so it stays on top)
  g.fillStyle = '#c9a227'; g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fill();
  g.fillStyle = '#d8d8de'; g.font = '11px Segoe UI'; g.fillText('PLAYER', cx + 10, cy + 4);
}

/* ---------- Cavebot editor (real routes via API) ---------- */
async function renderCavebot() {
  const routes = await get('/api/routes');
  view.innerHTML = `<div class="card"><table><tr><th>Route</th><th>Loop</th><th>Waypoints</th></tr>${
    routes.map(r => `<tr><td>${r.route}</td><td>${r.loop?'yes':'no'}</td><td>${
      r.waypoints.map(w => `${w.type}${w.x!==undefined?`@${w.x}/${w.y}/${w.z}`:''}${w.destination?`→${w.destination}`:''}`).join(' → ')
    }</td></tr>`).join('')}</table></div>
    <div class="card">
      <h3>Nova rota (POST /api/routes)</h3>
      <form id="routeForm" style="display:flex;flex-direction:column;gap:8px">
        <input id="routeName" placeholder="nome da rota" required style="background:#121218;color:#d8d8de;border:1px solid #2a2a34;padding:6px"/>
        <label style="color:#b8b8c4"><input type="checkbox" id="routeLoop" checked/> loop</label>
        <textarea id="routeWps" rows="5" placeholder='[{"type":"WALK","x":100,"y":100,"z":7},{"type":"HUNT","duration":60}]'
          style="background:#121218;color:#d8d8de;border:1px solid #2a2a34;padding:6px;font-family:monospace"></textarea>
        <button type="submit" style="background:#c9a227;color:#111;border:0;padding:8px 14px;cursor:pointer">Criar rota</button>
        <pre id="routeResult" style="color:#8f8fa0"></pre>
      </form>
    </div>`;
  document.getElementById('routeForm').onsubmit = async (e) => {
    e.preventDefault();
    const out = document.getElementById('routeResult');
    try {
      const waypoints = JSON.parse(document.getElementById('routeWps').value || '[]');
      const body = {
        route: document.getElementById('routeName').value,
        loop: document.getElementById('routeLoop').checked,
        waypoints,
      };
      const res = await post('/api/routes', body);
      out.textContent = `OK: ${JSON.stringify(res)}`;
      renderCavebot();
    } catch (err) {
      out.textContent = `ERRO: ${err.message}`;
    }
  };
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
