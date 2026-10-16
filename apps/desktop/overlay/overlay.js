/**
 * T BOT Overlay renderer (spec §25). Subscribes to ws://…/ws/runtime and only
 * mirrors real runtime state. If the socket dies it shows OFFLINE — it never
 * keeps a stale "RUNNING" on screen (§41).
 */

const API = window.tbot ?? null;
const $ = (id) => document.getElementById(id);

function fmt(n){ return n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e3 ? Math.round(n/1e3)+'K' : String(n ?? '–'); }

function applyStatus(st) {
  const running = st.bot === 'running';
  $('bot').textContent = running ? '● RUNNING' : st.bot === 'paused' ? '● PAUSED' : '● OFFLINE';
  $('bot').className = running ? 'st' : 'danger';
  $('state').textContent = st.state ?? '–';
  $('target').textContent = st.snapshot?.target ?? '–';
  $('hpmp').textContent = st.snapshot ? `${st.snapshot.hpPercent}% / ${st.snapshot.manaPercent}%` : '–';
  $('xph').textContent = fmt(st.statistics?.xpPerHour);
  $('loot').textContent = fmt(st.statistics?.lootValue);
  $('wp').textContent = st.navigation?.nextWaypoint ?? '–';
}

async function connect() {
  let url;
  try { url = API ? await API.wsUrl() : 'ws://127.0.0.1:8791/ws/runtime'; }
  catch { url = 'ws://127.0.0.1:8791/ws/runtime'; }
  let ws;
  try { ws = new WebSocket(url); } catch { return retry(); }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'STATUS') applyStatus(msg);
    } catch {}
  };
  ws.onclose = () => { $('bot').textContent = '● OFFLINE'; $('bot').className = 'danger'; retry(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function retry(){ setTimeout(connect, 2000); }
connect();
