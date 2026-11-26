'use strict';

/**
 * apps/desktop/ui/app.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0) — UI do shell desktop (:8791)
 *
 * Comportamento do palco central (#centerClientViewport):
 *  - No MEIO da tela há a Logo interativa #centerLogoLauncher com o botão
 *    #btnLaunchClientLogo. Clicar na Logo (com o cliente FECHADO ou ABERTO)
 *    dispara POST /api/client/launch → abre o RubinOT Client real se fechado,
 *    ou foca a janela existente se já aberto.
 *  - Após o launch, o cliente real é exibido no centro via <img id="liveCharFrame"
 *    src="/api/client/frame"> (PNG real do Win32 quando disponível; SVG
 *    determinístico como fallback).
 *  - Clicar sobre a imagem do frame envia POST /api/client/click com as
 *    coordenadas mapeadas para o espaço 800x620 do cliente — os cliques,
 *    movimentos e teclas são registrados em tempo real no módulo de
 *    aprendizado (GET /api/learning).
 *  - ?charFull=1 ativa body.char-fullscreen: grid de 1 coluna (CSS em
 *    index.html) sem faixa preta no meio da tela.
 */

(function () {
  const API = ''; // mesma origem (:8791)

  const els = {
    viewport: document.getElementById('centerClientViewport'),
    frame: document.getElementById('liveCharFrame'),
    logo: document.getElementById('centerLogoLauncher'),
    btnLogo: document.getElementById('btnLaunchClientLogo'),
    toast: document.getElementById('launchToast'),
    btnToggleCharFull: document.getElementById('btnToggleCharFull'),
    railLaunch: document.getElementById('railLaunchClient'),
    railRefresh: document.getElementById('railRefreshFrame'),
    btnAgentStart: document.getElementById('btnAgentStart'),
    btnAgentPause: document.getElementById('btnAgentPause'),
    spDetected: document.getElementById('spDetected'),
    spPid: document.getElementById('spPid'),
    spTitle: document.getElementById('spTitle'),
    spClicks: document.getElementById('spClicks'),
    spMoves: document.getElementById('spMoves'),
    spKeys: document.getElementById('spKeys'),
    spLaunches: document.getElementById('spLaunches'),
    spLog: document.getElementById('spLog'),
    sbDot: document.getElementById('sbDot'),
    sbStatus: document.getElementById('sbStatus'),
    sbFrame: document.getElementById('sbFrame'),
  };

  const state = {
    clientOpen: false, // estado REAL do cliente retornado pela API (nunca cache falso)
    launching: false,
    frameSeq: 0,
    logs: [],
  };

  // ------------------------------------------------------------ helpers ---

  function toast(msg, ms = 2600) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  function logLine(msg) {
    const time = new Date().toLocaleTimeString('pt-BR');
    state.logs.push(`[${time}] ${msg}`);
    if (state.logs.length > 60) state.logs.splice(0, state.logs.length - 60);
    if (els.spLog) els.spLog.textContent = state.logs.slice(-14).join('\n');
  }

  async function apiPost(pathname, body) {
    const res = await fetch(API + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    });
    return res.json();
  }

  async function apiGet(pathname) {
    const res = await fetch(API + pathname, { cache: 'no-store' });
    return res.json();
  }

  // ------------------------------------------------- char-fullscreen -----
  // ?charFull=1 → body.char-fullscreen (CSS corrige o grid: 1fr + 1/-1,
  // eliminando a faixa preta no meio quando nav está display:none)

  function applyCharFullscreenFromUrl() {
    const params = new URLSearchParams(location.search);
    if (params.get('charFull') === '1') {
      document.body.classList.add('char-fullscreen');
    }
  }

  function toggleCharFull() {
    const on = document.body.classList.toggle('char-fullscreen');
    const url = new URL(location.href);
    if (on) url.searchParams.set('charFull', '1');
    else url.searchParams.delete('charFull');
    history.replaceState(null, '', url.toString());
    logLine(`char-fullscreen ${on ? 'ATIVADO (grid 1fr, sem faixa preta)' : 'desativado'}`);
  }

  // ----------------------------------------------------- live frame ------

  function refreshLiveFrame(burst) {
    if (!els.frame) return;
    state.frameSeq += 1;
    // Cache-buster garante frame fresco (Cache-Control: no-store no servidor)
    els.frame.src = `${API}/api/client/frame?_=${Date.now()}-${state.frameSeq}`;
    els.frame.classList.add('visible');
    if (burst) {
      // Rajada curta de re-sincronização após abrir/focar o cliente
      let n = 0;
      const iv = setInterval(() => {
        state.frameSeq += 1;
        els.frame.src = `${API}/api/client/frame?_=${Date.now()}-${state.frameSeq}`;
        if (++n >= 3) clearInterval(iv);
      }, 700);
    }
  }

  els.frame &&
    els.frame.addEventListener('load', () => {
      els.sbFrame && (els.sbFrame.textContent = `frame ao vivo #${state.frameSeq} · cliente no centro`);
    });

  // Clique na imagem do frame → POST /api/client/click com coords mapeadas
  if (els.frame) {
    els.frame.addEventListener('click', (ev) => {
      const rect = els.frame.getBoundingClientRect();
      const relX = (ev.clientX - rect.left) / Math.max(1, rect.width);
      const relY = (ev.clientY - rect.top) / Math.max(1, rect.height);
      const x = Math.round(relX * 800); // espaço lógico do cliente (SVG 800x620)
      const y = Math.round(relY * 620);
      const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
      apiPost('/api/client/click', { x, y, button, source: 'live-frame-click' })
        .then((r) => {
          if (r && r.ok) {
            logLine(`clique registrado (${x},${y}) ${button} → total ${r.clickCount}`);
            refreshLearning();
            // mostra imediatamente o clique no frame (trail do SVG)
            setTimeout(() => refreshLiveFrame(false), 120);
          }
        })
        .catch((e) => logLine(`erro click: ${e.message}`));
    });
    els.frame.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  // ------------------------------------------------------ LOGO CENTRAL ---
  // Clica e ABRE (se fechado) ou FOCA (se aberto) o RubinOT Client real.

  async function launchOrFocusClient(sourceLabel) {
    if (state.launching) return;
    state.launching = true;
    els.btnLogo && (els.btnLogo.disabled = true);
    try {
      logLine(`POST /api/client/launch (${sourceLabel})…`);
      const result = await apiPost('/api/client/launch', { source: sourceLabel });
      if (result && result.ok) {
        state.clientOpen = true;
        if (result.action === 'focused') {
          toast('RubinOT Client já estava aberto — janela FOCADA ✔');
          logLine('cliente aberto → janela focada (SetForegroundWindow)');
        } else if (result.preview) {
          toast('Cliente real indisponível neste ambiente — sessão preview aberta no centro ▶');
          logLine('launch preview (sem exe RubinOT neste host) → palco central ativado');
        } else {
          toast('RubinOT Client ABERTO com sucesso ✔');
          logLine(`cliente fechado → iniciado (${result.exePath || 'exe'})`);
        }
        // Exibe o cliente real no meio da tela e recolhe a logo
        refreshLiveFrame(true);
        hideLogoAfterLaunch();
      } else {
        toast(`Falha ao abrir o cliente: ${(result && result.message) || 'erro'}`);
        logLine(`launch FALHOU: ${(result && result.message) || 'erro'}`);
        // mesmo assim mostra o palco para não deixar tela preta
        refreshLiveFrame(false);
      }
      refreshLearning();
    } catch (err) {
      toast('Runtime offline — inicie `npm start` (:8791)');
      logLine(`launch erro: ${err.message}`);
      refreshLiveFrame(false);
    } finally {
      state.launching = false;
      els.btnLogo && (els.btnLogo.disabled = false);
    }
  }

  function hideLogoAfterLaunch() {
    if (!els.logo) return;
    // A logo recua para um selo discreto no topo; clicar no selo traz a logo de volta
    setTimeout(() => {
      els.logo.classList.add('hidden');
      logLine('logo central recolhida — cliente real visível no meio da tela');
    }, 550);
  }

  function showLogoAgain() {
    if (els.logo) els.logo.classList.remove('hidden');
  }

  if (els.logo) {
    els.logo.addEventListener('click', (ev) => {
      // Cliques no card da logo abrem/focam o cliente (não vazam para o frame)
      ev.stopPropagation();
      launchOrFocusClient('center-logo');
    });
    els.logo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        launchOrFocusClient('center-logo-keyboard');
      }
    });
  }
  if (els.btnLogo) {
    els.btnLogo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      launchOrFocusClient('btnLaunchClientLogo');
    });
  }

  // Duplo clique no palco vazio traz a logo de volta (re-abrir/focar também funciona)
  if (els.viewport) {
    els.viewport.addEventListener('dblclick', (ev) => {
      if (ev.target === els.viewport) showLogoAgain();
    });
    // Movimento do mouse registrado em tempo real (throttle 120ms)
    let lastMove = 0;
    els.viewport.addEventListener('mousemove', (ev) => {
      const now = Date.now();
      if (now - lastMove < 120) return;
      lastMove = now;
      const rect = els.viewport.getBoundingClientRect();
      const x = Math.round(((ev.clientX - rect.left) / Math.max(1, rect.width)) * 800);
      const y = Math.round(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 620);
      apiPost('/api/client/move', { x, y }).catch(() => {});
    });
  }

  // Teclas registradas em tempo real para o módulo de aprendizado
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    apiPost('/api/client/key', { key: ev.key }).catch(() => {});
    if (ev.key === 'Escape') showLogoAgain();
  });

  // ------------------------------------------------------- polling UI ----

  async function refreshStatus() {
    try {
      const st = await apiGet('/api/status');
      const c = st.client || {};
      state.clientOpen = !!(c.detected && c.running);
      if (els.spDetected) els.spDetected.textContent = c.detected ? 'SIM ✔' : 'NÃO ✘';
      if (els.spPid) els.spPid.textContent = c.pid != null ? String(c.pid) : '—';
      if (els.spTitle) els.spTitle.textContent = c.windowTitle || '—';
      if (els.sbDot) els.sbDot.classList.toggle('on', !!c.detected || st.status === 'running');
      if (els.sbStatus) els.sbStatus.textContent = `runtime ${st.status} · cliente ${state.clientOpen ? 'aberto' : 'fechado'}`;
      const ctr = st.counters || {};
      if (els.spClicks) els.spClicks.textContent = String(ctr.clicks || 0);
      if (els.spMoves) els.spMoves.textContent = String(ctr.moves || 0);
      if (els.spKeys) els.spKeys.textContent = String(ctr.keys || 0);
      if (els.spLaunches) els.spLaunches.textContent = String(ctr.launches || 0);
    } catch (_e) {
      if (els.sbStatus) els.sbStatus.textContent = 'runtime offline (npm start → :8791)';
    }
  }

  async function refreshLearning() {
    try {
      const l = await apiGet('/api/learning');
      if (!l || !l.ok) return;
      const s = l.summary || {};
      if (els.spClicks) els.spClicks.textContent = String(s.clicks || 0);
      if (els.spMoves) els.spMoves.textContent = String(s.moves || 0);
      if (els.spKeys) els.spKeys.textContent = String(s.keys || 0);
      if (els.spLaunches) els.spLaunches.textContent = String(s.launches || 0);
    } catch (_e) {
      /* offline */
    }
  }

  // -------------------------------------------------------- wiring -------

  els.btnToggleCharFull && els.btnToggleCharFull.addEventListener('click', toggleCharFull);
  els.railLaunch &&
    els.railLaunch.addEventListener('click', (ev) => {
      ev.preventDefault();
      showLogoAgain();
      launchOrFocusClient('rail-link');
    });
  els.railRefresh &&
    els.railRefresh.addEventListener('click', (ev) => {
      ev.preventDefault();
      refreshLiveFrame(false);
      logLine('frame atualizado manualmente (/api/client/frame)');
    });
  els.btnAgentStart &&
    els.btnAgentStart.addEventListener('click', async () => {
      await apiPost('/api/agent/start', {}).catch(() => {});
      toast('Agente autônomo LIGADO ▶');
      logLine('agente iniciado');
      refreshStatus();
    });
  els.btnAgentPause &&
    els.btnAgentPause.addEventListener('click', async () => {
      await apiPost('/api/agent/pause', {}).catch(() => {});
      toast('Agente pausado ⏸');
      logLine('agente pausado');
      refreshStatus();
    });

  // --------------------------------------------------------- boot --------

  applyCharFullscreenFromUrl();
  logLine('UI inicializada — logo central pronta para abrir/focar o RubinOT Client');
  refreshStatus();
  setInterval(refreshStatus, 4000);
  // Frame ao vivo periódico (2.5s) apenas quando o cliente foi aberto/focado
  setInterval(() => {
    if (state.clientOpen) refreshLiveFrame(false);
  }, 2500);
})();
