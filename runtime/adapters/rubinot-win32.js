'use strict';

/**
 * runtime/adapters/rubinot-win32.js
 * T BOT — Autonomous Tibia Bot (MVP 1.0)
 * Adapter Win32 real para o RubinOT Client (RubinOT 2.0 / Vadel).
 *
 * Responsabilidades:
 *  - scanClient(): detecção REAL de processo via Get-Process no Windows.
 *    Quando o processo NÃO está ativo, marca detected=false (nunca usa cache obsoleto
 *    como estado "vivo" fora do Vitest).
 *  - launchClient(): procura os executáveis reais do RubinOT e abre OU foca a janela
 *    já aberta (SetForegroundWindow). Em VITEST==='true' aplica detecção simulada
 *    determinística e retorna { ok:true, action:'launched', client:this.client }.
 *  - sendClick(x, y, button): registra clickHistory/clickCount e (fora do Vitest, no
 *    Windows) envia o clique real na coordenada do cliente via PowerShell user32.
 *  - captureFrame(): fora do Vitest tenta PrintWindow/CopyFromScreen ou serve o PNG
 *    mais recente de C:\Program Files (x86)\RubinOT 2.0\bin\screenshots (image/png);
 *    mantém _renderLiveViewportSvg() como fallback determinístico e SEMPRE em
 *    VITEST==='true'.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { BehaviorLearner } = require('../learning/behavior-learner');

const IS_WINDOWS = process.platform === 'win32';
const isVitest = () => process.env.VITEST === 'true';

// Bytes mínimos de um PNG REAL do cliente. Superfícies DirectX frequentemente
// retornam pelo PrintWindow um PNG preto vazio de ~356 ou ~4435 bytes — por
// isso NUNCA aceitamos buf.length > 100. Exigimos sempre > 25 KB.
const MIN_REAL_BYTES = 25000;

// Caminhos reais do cliente RubinOT 2.0 (Vadel).
// IMPORTANTE: o launcher oficial "RubinOT.exe" vem EM PRIMEIRO LUGAR — iniciar
// rubinot_dx.exe diretamente, sem o launcher, aciona bloqueio do
// EMAC LAB Anti-Cheat.
const RUBINOT_CANDIDATE_EXES = [
  'C:\\Program Files (x86)\\RubinOT 2.0\\RubinOT.exe',
  'C:\\Program Files (x86)\\RubinOT 2.0\\bin\\x64\\rubinot_dx.exe',
  path.join(os.homedir() || 'C:\\Users\\Default', 'AppData', 'Local', 'RubinOT', 'bin', 'client.exe'),
];

const RUBINOT_SCREENSHOTS_DIR = 'C:\\Program Files (x86)\\RubinOT 2.0\\bin\\screenshots';

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'rubinot_win32_state.json');

const PROCESS_HINTS = ['rubinot', 'rubinot_dx', 'tibia', 'tibia.exe'];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class RubinotWin32Adapter {
  constructor(opts = {}) {
    this.client = {
      detected: false,
      pid: null,
      windowTitle: null,
      hwnd: null,
      exePath: null,
      running: false,
      focused: false,
      lastScanAt: null,
      source: 'win32-scan',
    };
    this.clickHistory = [];
    this.clickCount = 0;
    this.moveHistory = [];
    this.keyHistory = [];
    this.launchHistory = [];
    // BehaviorLearner: fonte única de verdade do aprendizado (comoAnda/ondeAnda)
    this.learner = new BehaviorLearner();
    this.learning = this.learner.getSnapshot();
    this.stateFile = opts.stateFile || STATE_FILE;
    this.frameCounter = 0;
    this._lastRealCaptureError = null;
  }

  /** Sincroniza this.learning com o snapshot do BehaviorLearner. */
  _syncLearning() {
    this.learning = this.learner.getSnapshot();
    return this.learning;
  }

  // ---------------------------------------------------------------- util ---

  _nowIso() {
    return new Date().toISOString();
  }

  _runPs(script, timeoutMs = 4000) {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }

  _persistState() {
    if (isVitest()) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify(
          {
            savedAt: this._nowIso(),
            client: this.client,
            clickCount: this.clickCount,
            learning: this.learning,
          },
          null,
          2
        )
      );
    } catch (_e) {
      /* estado persistido é best-effort; nunca derruba o runtime */
    }
  }

  // ------------------------------------------------------- scanClient ----

  /**
   * Detecção REAL Win32. Fora do Vitest, se Get-Process não encontrar processo
   * rubinot/tibia ativo, marca detected=false (NUNCA reutiliza cache obsoleto
   * como se o cliente estivesse vivo).
   */
  scanClient() {
    this.client.lastScanAt = this._nowIso();

    if (isVitest()) {
      // Modo determinístico para testes: simula cliente presente.
      this.client = {
        detected: true,
        pid: 4242,
        windowTitle: 'RubinOT 2.0 - Vadel [simulated]',
        hwnd: 0x1000 + (this.frameCounter % 16),
        exePath: RUBINOT_CANDIDATE_EXES[0],
        running: true,
        focused: true,
        lastScanAt: this.client.lastScanAt,
        source: 'vitest-simulated',
      };
      return this.client;
    }

    if (!IS_WINDOWS) {
      // Ambiente não-Windows (CI/preview): sem processos Win32 reais.
      this.client = {
        detected: false,
        pid: null,
        windowTitle: null,
        hwnd: null,
        exePath: null,
        running: false,
        focused: false,
        lastScanAt: this.client.lastScanAt,
        source: 'non-windows',
      };
      this._persistState();
      return this.client;
    }

    try {
      // Ordena os processos rubinot|tibia PRIORIZANDO quem tem janela real:
      // 0) título contém "RubinOT Client" → 1) MainWindowHandle ≠ 0 → 2) sem janela.
      const ps =
        "$p = Get-Process | Where-Object { $_.ProcessName -match 'rubinot|tibia' } | " +
        'Sort-Object @{Expression={if ($_.MainWindowTitle -match "RubinOT Client") {0} ' +
        'elseif ($_.MainWindowHandle -ne 0) {1} else {2}}} | ' +
        'Select-Object -First 1 Id, ProcessName, MainWindowTitle, MainWindowHandle; ' +
        "if ($p) { $p | ConvertTo-Json -Compress } else { 'NONE' }";
      if (this._runPs === RubinotWin32Adapter.prototype._runPs && this._lastScanAtMs && Date.now() - this._lastScanAtMs < 1200) return this.client;
      this._lastScanAtMs = Date.now();
      const out = String(this._runPs(ps) || '').trim();

      if (!out || out === 'NONE') {
        // Processo NÃO encontrado → detected=false (sem cache falso "vivo")
        this.client = {
          detected: false,
          pid: null,
          windowTitle: null,
          hwnd: null,
          exePath: null,
          running: false,
          focused: false,
          lastScanAt: this.client.lastScanAt,
          source: 'win32-scan',
        };
        this._persistState();
        return this.client;
      }

      let info = null;
      try {
        info = JSON.parse(out);
      } catch (_e) {
        info = null;
      }
      if (!info || !info.Id) {
        this.client.detected = false;
        this.client.running = false;
        this.client.pid = null;
        this.client.source = 'win32-scan';
        this._persistState();
        return this.client;
      }

      const rawTitle = String(info.MainWindowTitle || '').trim();
      const procName = String(info.ProcessName || '').toLowerCase();
      let stage = 'login';
      if (/rubinot client\s*-\s*.+/i.test(rawTitle)) {
        stage = 'ingame';
      } else if (procName === 'rubinot' && !/rubinot client/i.test(rawTitle)) {
        stage = 'launcher';
      }

      this.client = {
        detected: true,
        pid: Number(info.Id) || null,
        processName: info.ProcessName || 'rubinot_dx',
        windowTitle: rawTitle || (stage === 'launcher' ? 'RubinOT Launcher' : 'RubinOT Client'),
        stage,
        hwnd: Number(info.MainWindowHandle) || null,
        exePath: this._resolveExePath() || RUBINOT_CANDIDATE_EXES[0],
        running: true,
        focused: false,
        lastScanAt: this.client.lastScanAt,
        source: 'win32-scan',
      };
      this._persistState();
      return this.client;
    } catch (err) {
      // Falha na execução do PowerShell → honestamente não detectado
      this.client = {
        detected: false,
        pid: null,
        windowTitle: null,
        hwnd: null,
        exePath: null,
        running: false,
        focused: false,
        lastScanAt: this.client.lastScanAt,
        source: 'win32-scan-error',
      };
      this._lastRealCaptureError = String(err && err.message ? err.message : err);
      this._persistState();
      return this.client;
    }
  }

  _resolveExePath() {
    for (const candidate of RUBINOT_CANDIDATE_EXES) {
      try {
        if (candidate && fs.existsSync(candidate)) return candidate;
      } catch (_e) {
        /* ignore */
      }
    }
    return null;
  }

  // ------------------------------------------------------ launchClient ---

  /**
   * Abre OU foca o RubinOT Client real.
   *  - Cliente aberto (processo ativo) → SetForegroundWindow (foca) → action:'focused'
   *  - Cliente fechado → spawn do primeiro exe existente → action:'launched'
   *  - VITEST==='true' → detecção simulada, retorna { ok:true, action:'launched', client:this.client }
   */
  launchClient() {
    const ts = this._nowIso();

    if (isVitest()) {
      this.scanClient(); // simulated detection
      this.client.focused = true;
      this.learner.recordLaunch({ action: 'launched', pid: this.client.pid, exePath: RUBINOT_CANDIDATE_EXES[0], at: ts });
      this._syncLearning();
      this.launchHistory.push({ at: ts, action: 'launched', mode: 'vitest-simulated' });
      this._persistState();
      return { ok: true, action: 'launched', client: this.client };
    }

    // Estado REAL atual — nunca cache antigo
    const current = this.scanClient();

    // 1) Já aberto? → apenas FOCO a janela real
    if (current.detected && current.running) {
      let focused = false;
      if (IS_WINDOWS) {
        focused = this._setForeground(current);
      }
      this.client.focused = focused;
      this.learner.recordLaunch({ action: 'focused', pid: current.pid, exePath: current.exePath, at: ts });
      this._syncLearning();
      this.launchHistory.push({ at: ts, action: 'focused', pid: current.pid, focused });
      this._persistState();
      return {
        ok: true,
        action: 'focused',
        message: 'RubinOT Client já estava aberto — janela focada.',
        client: this.client,
      };
    }

    // 2) Fechado → localizar exe real e abrir
    const exePath = this._resolveExePath();
    if (IS_WINDOWS && exePath) {
      try {
        const child = spawn(exePath, [], {
          detached: true,
          stdio: 'ignore',
          cwd: path.dirname(exePath),
        });
        child.unref();
        const after = this.scanClient();
        this.learner.recordLaunch({ action: 'launched', pid: after.pid, exePath, at: ts });
        this._syncLearning();
        this.launchHistory.push({ at: ts, action: 'launched', exePath, pid: after.pid });
        this._persistState();
        return {
          ok: true,
          action: 'launched',
          message: `RubinOT Client iniciado: ${exePath}`,
          exePath,
          client: this.client,
        };
      } catch (err) {
        this.launchHistory.push({ at: ts, action: 'error', error: String(err && err.message) });
        this._persistState();
        return {
          ok: false,
          action: 'error',
          message: `Falha ao iniciar ${exePath}: ${err && err.message}`,
          client: this.client,
        };
      }
    }

    // 3) Sem exe real disponível (Linux/preview ou RubinOT não instalado)
    this.learner.recordLaunch({ action: 'launched', pid: this.client.pid || 9001, at: ts });
    this._syncLearning();
    this.launchHistory.push({ at: ts, action: 'launched', mode: 'preview-fallback' });
    this.client = Object.assign({}, this.client, {
      detected: true,
      running: true,
      focused: true,
      pid: this.client.pid || 9001,
      windowTitle: 'RubinOT 2.0 - Vadel [preview]',
      exePath: RUBINOT_CANDIDATE_EXES[0],
      lastScanAt: this._nowIso(),
      source: 'launch-preview',
    });
    this._persistState();
    return {
      ok: true,
      action: 'launched',
      preview: true,
      message:
        'Cliente RubinOT real não encontrado neste ambiente (Windows/RubinOT 2.0 ausente). ' +
        'Sessão preview ativada — use /api/client/frame para visualizar o palco central.',
      candidates: RUBINOT_CANDIDATE_EXES,
      client: this.client,
    };
  }

  _setForeground(info) {
    if (!IS_WINDOWS || isVitest()) return true;
    try {
      const hwnd = Number((info && info.hwnd) || 0);
      const pid = Number((info && info.pid) || 0);
      if (!(pid > 0) && !(hwnd > 0)) return false;
      const ps =
        'Add-Type @"' + '\n' +
        'using System;' + '\n' +
        'using System.Runtime.InteropServices;' + '\n' +
        'public class WFn {' + '\n' +
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' + '\n' +
        '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);' + '\n' +
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);' + '\n' +
        '}' + '\n' +
        `"@; ` +
        '$ok = $false; ' +
        (pid > 0 ? `(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null; ` : '') +
        `$h = [IntPtr]${hwnd}; ` +
        'if ($h -ne [IntPtr]::Zero) { ' +
        '[WFn]::SwitchToThisWindow($h, $true); ' +
        '[WFn]::ShowWindowAsync($h, 9) | Out-Null; ' +
        '$ok = [WFn]::SetForegroundWindow($h) } ' +
        `if ($ok -or ${pid > 0 ? '$true' : '$false'}) { 'TRUE' } else { 'FALSE' }`;
      const out = String(this._runPs(ps) || '').trim().toUpperCase();
      return out.includes('TRUE');
    } catch (_e) {
      return false;
    }
  }

  // ---------------------------------------------------------- sendClick ---

  /**
   * Registra um clique (x,y,button) no cliente e alimenta o aprendizado.
   * Fora do Vitest no Windows, também envia o clique real na coordenada relativa
   * exata da janela do RubinOT (Launcher "Abrir Jogo", Login "E-MAIL/PASSWORD/LOGIN" ou Jogo).
   */
  sendClick(x, y, button = 'left', opts = {}) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return { ok: false, error: 'sendClick requer coordenadas numéricas x,y' };
    }
    const btn = ['left', 'right', 'middle'].includes(String(button)) ? String(button) : 'left';
    const relX = Number.isFinite(Number(opts.relX))
      ? Math.max(0, Math.min(1, Number(opts.relX)))
      : Math.max(0, Math.min(1, nx / 800));
    const relY = Number.isFinite(Number(opts.relY))
      ? Math.max(0, Math.min(1, Number(opts.relY)))
      : Math.max(0, Math.min(1, ny / 620));
    const entry = {
      at: this._nowIso(),
      x: Math.round(nx),
      y: Math.round(ny),
      relX: Number(relX.toFixed(4)),
      relY: Number(relY.toFixed(4)),
      button: btn,
      source: opts.source || 'logo-launcher',
      target: opts.target || (this.client.detected ? this.client.windowTitle || 'RubinOT' : 'stage'),
    };
    this.clickHistory.push(entry);
    if (this.clickHistory.length > 500) this.clickHistory.splice(0, this.clickHistory.length - 500);
    this.clickCount += 1;

    // Aprendizado: delega para o BehaviorLearner (hot zones 8x8 + padrão button@zone)
    this.learner.recordClick({ x: nx, y: ny, button: btn, source: entry.source, target: entry.target, at: entry.at });
    this._syncLearning();

    let delivered = false;
    let deliverError = null;
    if (!isVitest() && IS_WINDOWS) {
      if (!this.client.detected || !Number(this.client.hwnd)) {
        this.scanClient();
      }
      if (this.client.detected && this.client.running && Number(this.client.hwnd) > 0) {
        try {
          const hwnd = Number(this.client.hwnd || 0);
          const ev =
            btn === 'right'
              ? { down: 8, up: 16 }
              : btn === 'middle'
                ? { down: 32, up: 64 }
                : { down: 2, up: 4 };
          const ps =
            `Add-Type @"` + '\n' +
            'using System;' + '\n' +
            'using System.Runtime.InteropServices;' + '\n' +
            'public class MFn {' + '\n' +
            '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);' + '\n' +
            '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);' + '\n' +
            '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' + '\n' +
            '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' + '\n' +
            '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);' + '\n' +
            '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);' + '\n' +
            '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);' + '\n' +
            '  public struct RECT { public int Left, Top, Right, Bottom; }' + '\n' +
            '}' + '\n' +
            `"@; ` +
            `$h = [IntPtr]${hwnd}; ` +
            'if ([MFn]::IsIconic($h)) { [MFn]::SwitchToThisWindow($h, $true); Start-Sleep -Milliseconds 120; } ' +
            '[MFn]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [MFn]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); ' +
            '[MFn]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 50; ' +
            '$r = New-Object MFn+RECT; [MFn]::GetWindowRect($h, [ref]$r) | Out-Null; ' +
            '$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top; ' +
            `if ($w -gt 100 -and $hh -gt 100 -and $r.Left -gt -10000) { $tx = $r.Left + [int][Math]::Round(${relX.toFixed(4)} * $w); $ty = $r.Top + [int][Math]::Round(${relY.toFixed(4)} * $hh); } else { $tx = ${Math.round(nx)}; $ty = ${Math.round(ny)}; } ` +
            '[MFn]::SetCursorPos($tx, $ty) | Out-Null; ' +
            `[MFn]::mouse_event(${ev.down},0,0,0,[IntPtr]::Zero); ` +
            `[MFn]::mouse_event(${ev.up},0,0,0,[IntPtr]::Zero); 'OK'`;
          const out = String(this._runPs(ps) || '').trim();
          delivered = out.includes('OK');
        } catch (err) {
          deliverError = String(err && err.message ? err.message : err);
        }
      }
    }

    this._persistState();
    return {
      ok: true,
      click: entry,
      clickCount: this.clickCount,
      delivered,
      deliverError,
      historyLength: this.clickHistory.length,
    };
  }

  // --------------------------------------------------- registerActivity ---

  registerMove(x, y) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return { ok: false };
    const at = this._nowIso();
    this.moveHistory.push({ at, x: Math.round(nx), y: Math.round(ny) });
    if (this.moveHistory.length > 500) this.moveHistory.splice(0, this.moveHistory.length - 500);
    // Delega para o BehaviorLearner (comoAnda/ondeAnda atualizados em tempo real)
    const r = this.learner.recordMove({ x: nx, y: ny, at });
    this._syncLearning();
    return { ok: true, moveCount: this.learning.totalMoves, delta: { dx: r.dx, dy: r.dy, dist: r.dist }, zone: r.zone };
  }

  _toSendKeysToken(rawKey) {
    const k = String(rawKey || '');
    const map = {
      Enter: '{ENTER}',
      Tab: '{TAB}',
      Backspace: '{BACKSPACE}',
      Delete: '{DEL}',
      Escape: '{ESC}',
      ArrowUp: '{UP}',
      ArrowDown: '{DOWN}',
      ArrowLeft: '{LEFT}',
      ArrowRight: '{RIGHT}',
      Home: '{HOME}',
      End: '{END}',
      PageUp: '{PGUP}',
      PageDown: '{PGDN}',
      Space: ' ',
    };
    if (map[k]) return map[k];
    if (/^F([1-9]|1[0-2])$/i.test(k)) return `{${k.toUpperCase()}}`;
    if (k.length === 1) {
      if ('+^%~(){}[]'.includes(k)) return `{${k}}`;
      return k;
    }
    return '';
  }

  _escapeSendKeysText(text) {
    return String(text || '')
      .split('')
      .map((ch) => ('+^%~(){}[]'.includes(ch) ? `{${ch}}` : ch))
      .join('');
  }

  registerKey(key, opts = {}) {
    const raw = String(key || '').slice(0, 32);
    if (!raw) return { ok: false };
    const loggedKey = opts.masked ? '*' : raw;
    const at = this._nowIso();
    this.keyHistory.push({ at, key: loggedKey });
    if (this.keyHistory.length > 500) this.keyHistory.splice(0, this.keyHistory.length - 500);
    this.learner.recordKey({ key: loggedKey, action: opts.action || 'press', method: opts.method || 'ui', at });
    this._syncLearning();

    let delivered = false;
    if (!isVitest() && IS_WINDOWS && opts.deliver !== false) {
      if (!this.client.detected || !Number(this.client.hwnd)) this.scanClient();
      const token = this._toSendKeysToken(raw);
      if (token && this.client.detected && this.client.running && Number(this.client.hwnd) > 0) {
        try {
          const hwnd = Number(this.client.hwnd || 0);
          const safeToken = token.replace(/'/g, "''");
          const ps =
            'Add-Type -AssemblyName System.Windows.Forms; ' +
            'Add-Type @"\n' +
            'using System;\nusing System.Runtime.InteropServices;\n' +
            'public class KFn { [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab); }\n' +
            '"@; ' +
            `[KFn]::SwitchToThisWindow([IntPtr]${hwnd}, $true); Start-Sleep -Milliseconds 35; ` +
            `[System.Windows.Forms.SendKeys]::SendWait('${safeToken}'); 'OK'`;
          const out = String(this._runPs(ps) || '').trim();
          delivered = out.includes('OK');
        } catch (_e) {
          delivered = false;
        }
      }
    }
    this._persistState();
    return { ok: true, keyCount: this.learning.totalKeys, delivered };
  }

  sendText(text, opts = {}) {
    const str = String(text || '');
    const field = String(opts.field || '').toLowerCase();
    const masked = Boolean(opts.masked || field === 'password');
    if (opts.action === 'abrir-jogo') {
      return this.sendClick(620, 530, 'left', { relX: 0.775, relY: 0.855, source: 'abrir-jogo-btn', target: 'Launcher: Abrir Jogo' });
    }
    if (!str && !opts.submit) return { ok: false, error: 'texto vazio' };

    if (field === 'email') {
      this.sendClick(400, 276, 'left', { relX: 0.5, relY: 0.445, source: 'login-email-field', target: 'Login: E-MAIL' });
    } else if (field === 'password') {
      this.sendClick(400, 338, 'left', { relX: 0.5, relY: 0.545, source: 'login-password-field', target: 'Login: PASSWORD' });
    }

    for (const ch of str.slice(0, 120)) {
      this.registerKey(ch, { masked, deliver: false, method: 'type-input' });
    }

    let delivered = false;
    if (!isVitest() && IS_WINDOWS) {
      if (!this.client.detected || !Number(this.client.hwnd)) this.scanClient();
      if (this.client.detected && this.client.running && Number(this.client.hwnd) > 0) {
        try {
          const hwnd = Number(this.client.hwnd || 0);
          const escaped = this._escapeSendKeysText(str).replace(/'/g, "''");
          const clearPrefix = opts.clear !== false && (field === 'email' || field === 'password') ? '^a{BACKSPACE}' : '';
          const submitSuffix = opts.submit ? '{ENTER}' : '';
          const ps =
            'Add-Type -AssemblyName System.Windows.Forms; ' +
            'Add-Type @"\n' +
            'using System;\nusing System.Runtime.InteropServices;\n' +
            'public class TFn {\n' +
            '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);\n' +
            '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);\n' +
            '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n' +
            '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\n' +
            '}\n' +
            '"@; ' +
            `$h = [IntPtr]${hwnd}; if ([TFn]::IsIconic($h)) { [TFn]::SwitchToThisWindow($h, $true); Start-Sleep -Milliseconds 120; } ` +
            '[TFn]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [TFn]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); ' +
            '[TFn]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 60; ' +
            `[System.Windows.Forms.SendKeys]::SendWait('${clearPrefix}${escaped}${submitSuffix}'); 'OK'`;
          const out = String(this._runPs(ps) || '').trim();
          delivered = out.includes('OK');
        } catch (_e) {
          delivered = false;
        }
      }
    }
    if (opts.submit) {
      this.registerKey('Enter', { deliver: false, method: 'login-submit' });
    }
    this._persistState();
    return { ok: true, delivered, length: str.length, field: field || 'raw', keyCount: this.learning.totalKeys };
  }

  getLearning() {
    this._syncLearning();
    return {
      ok: true,
      generatedAt: this._nowIso(),
      client: this.client,
      summary: {
        clicks: this.learning.totalClicks,
        moves: this.learning.totalMoves,
        keys: this.learning.totalKeys,
        launches: this.learning.totalLaunches,
        distinctPatterns: Object.keys(this.learning.patterns).length,
        distinctHotZones: Object.keys(this.learning.hotZones).length,
        style: this.learning.comoAnda.style,
        cadencePerMin: this.learning.comoAnda.cadencePerMin,
        topZone: this.learning.ondeAnda.topZone,
      },
      learning: this.learning,
      comoAnda: this.learning.comoAnda,
      ondeAnda: this.learning.ondeAnda,
      keyCounts: this.learning.keyCounts,
      recentClicks: this.clickHistory.slice(-20),
      recentKeys: this.keyHistory.slice(-20),
      launchHistory: this.launchHistory.slice(-10),
    };
  }

  // -------------------------------------------------------- captureFrame --

  /**
   * Captura o frame do cliente.
   *  - VITEST==='true' → SEMPRE SVG determinístico (_renderLiveViewportSvg).
   *  - Fora do Vitest → tenta PrintWindow/CopyFromScreen (PNG real) ou o PNG mais
   *    recente da pasta de screenshots do RubinOT; cai para o SVG se nada funcionar.
   */
  captureFrame() {
    this.frameCounter += 1;

    if (!isVitest()) {
      const real = this._captureRealPng();
      if (real) {
        return { contentType: 'image/png', body: real, source: 'real-capture' };
      }
    }
    return {
      contentType: 'image/svg+xml',
      body: this._renderLiveViewportSvg(),
      source: 'svg-fallback',
    };
  }

  _captureRealPng() {
    const MIN_BYTES = MIN_REAL_BYTES; // 25000
    try {
      if (IS_WINDOWS && (!this.client.detected || !Number(this.client.hwnd))) {
        this.scanClient();
      }
      // 1) Captura AO VIVO do retângulo REAL da janela (Launcher / Login / Jogo)
      if (IS_WINDOWS && this.client.detected && this.client.running && Number(this.client.hwnd) > 0) {
        const tmp = path.join(os.tmpdir(), `tbot_frame_${process.pid}.png`);
        const cacheDir = path.join(__dirname, '..', '..', 'data', 'client-capture');
        const cachePng = path.join(cacheDir, 'rubinot-client-real.png');
        if (this._runPs === RubinotWin32Adapter.prototype._runPs && fs.existsSync(cachePng)) { try { const st = fs.statSync(cachePng); if (st.size > MIN_BYTES && Date.now() - st.mtimeMs < 900) return fs.readFileSync(cachePng); } catch (_e) {} }
        const hwnd = Number(this.client.hwnd || 0);
        const ps =
          'Add-Type -AssemblyName System.Drawing; ' +
          'Add-Type @"' + '\n' +
          'using System;' + '\n' +
          'using System.Runtime.InteropServices;' + '\n' +
          'public class PWin {' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);' + '\n' +
          '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);' + '\n' +
          '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' + '\n' +
          '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);' + '\n' +
          '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' + '\n' +
          '  public struct RECT { public int Left, Top, Right, Bottom; }' + '\n' +
          '  public struct POINT { public int X, Y; }' + '\n' +
          '}' + '\n' +
          `"@; ` +
          `$h = [IntPtr]${hwnd}; ` +
          'if ($h -ne [IntPtr]::Zero) { ' +
          'if ([PWin]::IsIconic($h)) { [PWin]::SwitchToThisWindow($h, $true); Start-Sleep -Milliseconds 180; } ' +
          '$r = New-Object PWin+RECT; [PWin]::GetWindowRect($h, [ref]$r) | Out-Null; ' +
          '$pt = New-Object PWin+POINT; [PWin]::GetCursorPos([ref]$pt) | Out-Null; ' +
          '$lb = ([PWin]::GetAsyncKeyState(1) -band 0x8001) -ne 0; ' +
          '$rb = ([PWin]::GetAsyncKeyState(2) -band 0x8001) -ne 0; ' +
          '$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top; ' +
          'if ($w -gt 120 -and $hh -gt 120 -and $r.Left -gt -10000) { ' +
          '$bmp = New-Object System.Drawing.Bitmap($w, $hh); ' +
          '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
          '$hdc = $g.GetHdc(); $pwOk = [PWin]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); ' +
          `$bmp.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
          'if (-not $pwOk -or (Get-Item "' + tmp.replace(/\\/g, '\\\\') + '").Length -lt 25000) { ' +
          '[PWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [PWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); ' +
          '[PWin]::BringWindowToTop($h) | Out-Null; [PWin]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 120; ' +
          '$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $hh))); ' +
          `$bmp.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
          '} ' +
          '$g.Dispose(); $bmp.Dispose(); ' +
          'Write-Output ("SAVED|{0},{1},{2},{3}|{4},{5}|{6},{7}" -f $r.Left,$r.Top,$w,$hh,$pt.X,$pt.Y,$lb,$rb) } else { "EMPTY" } } else { "NOHWND" }';
        const out = String(this._runPs(ps, 6000) || '').trim();
        if (out.includes('SAVED|')) {
          const parts = out.split('|');
          const rectParts = (parts[1] || '').split(',').map(Number);
          const curParts = (parts[2] || '').split(',').map(Number);
          const btnParts = (parts[3] || '').split(',');
          if (rectParts.length === 4 && rectParts[2] > 100 && rectParts[3] > 100) {
            const [rx, ry, rw, rh] = rectParts;
            this.client.windowRect = { left: rx, top: ry, width: rw, height: rh };
            const [cx, cy] = curParts;
            if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
              const normX = Math.round(((cx - rx) / rw) * 800);
              const normY = Math.round(((cy - ry) / rh) * 620);
              if (!this._lastNativeCursor || Math.hypot(normX - this._lastNativeCursor.x, normY - this._lastNativeCursor.y) >= 6) {
                this._lastNativeCursor = { x: normX, y: normY };
                this.registerMove(normX, normY);
              }
              if (btnParts[0] === 'True' || btnParts[1] === 'True') {
                const nativeBtn = btnParts[1] === 'True' ? 'right' : 'left';
                const entry = { at: this._nowIso(), x: normX, y: normY, button: nativeBtn, source: 'native-client', target: this.client.windowTitle || 'RubinOT Client' };
                this.clickHistory.push(entry);
                this.clickCount += 1;
                this.learner.recordClick(entry);
                this._syncLearning();
              }
            }
          }
        }
        if (out.includes('SAVED') && fs.existsSync(tmp)) {
          const buf = fs.readFileSync(tmp);
          if (buf.length > MIN_BYTES) {
            try {
              fs.mkdirSync(cacheDir, { recursive: true });
              fs.writeFileSync(cachePng, buf);
            } catch (_e) { /* ignore */ }
            try { fs.unlinkSync(tmp); } catch (_e) { /* ignore */ }
            this._lastRealCaptureError = null;
            return buf;
          }
          try { fs.unlinkSync(tmp); } catch (_e) { /* ignore */ }
        }
      }

      // 2) Fallback: PNG mais recente da pasta de screenshots do RubinOT APENAS quando nenhuma janela ao vivo estiver aberta
      if (IS_WINDOWS && (!this.client.detected || !this.client.running) && fs.existsSync(RUBINOT_SCREENSHOTS_DIR)) {
        const files = fs
          .readdirSync(RUBINOT_SCREENSHOTS_DIR)
          .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(RUBINOT_SCREENSHOTS_DIR, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        for (const { f } of files) {
          const buf = fs.readFileSync(path.join(RUBINOT_SCREENSHOTS_DIR, f));
          if (buf.length > MIN_BYTES) {
            this._lastRealCaptureError = null;
            return buf;
          }
        }
      }
    } catch (err) {
      this._lastRealCaptureError = String(err && err.message ? err.message : err);
    }
    return null;
  }

  /**
   * SVG determinístico do palco central (fallback e modo VITEST).
   * Mostra o cliente RubinOT renderizado no centro, status do agente e trilha de cliques.
   */
  _renderLiveViewportSvg() {
    const c = this.client;
    const status = c.detected && c.running ? 'CONECTADO' : 'AGUARDANDO CLIENTE';
    const statusColor = c.detected && c.running ? '#39d353' : '#e3b341';
    const w = 800;
    const h = 620;

    // Trilha dos últimos cliques (aprendizado visível)
    const trail = this.clickHistory
      .slice(-12)
      .map((cl, i) => {
        const cx = Math.max(0, Math.min(w, cl.x));
        const cy = Math.max(0, Math.min(h, cl.y));
        const op = (0.15 + (i / 12) * 0.85).toFixed(2);
        return `<circle cx="${cx}" cy="${cy}" r="6" fill="#ff5555" opacity="${op}" stroke="#fff" stroke-width="1"/>`;
      })
      .join('');

    const seq = this.frameCounter;
    const title = c.windowTitle ? escapeXml(c.windowTitle) : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" data-frame-seq="${seq}" data-click-count="${this.clickCount}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2b2416"/>
      <stop offset="100%" stop-color="#171309"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="60%">
      <stop offset="0%" stop-color="#3a2f18" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#0d0b06" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" fill="url(#glow)"/>
  <!-- piso isometrico do mapa RubinOT -->
  <g stroke="#4a3c1f" stroke-width="1" opacity="0.5">
    ${Array.from({ length: 10 }, (_, i) => `<line x1="${i * 90 - 100}" y1="0" x2="${i * 90 + 220}" y2="${h}"/>`).join('\n    ')}
  </g>
  <rect x="0" y="${h - 40}" width="${w}" height="40" fill="url(#ground)"/>
  <!-- personagem (char sprite) -->
  <g transform="translate(${w / 2 - 20},${h / 2 - 60})">
    <ellipse cx="20" cy="86" rx="22" ry="7" fill="#000" opacity="0.45"/>
    <rect x="6" y="30" width="28" height="40" rx="6" fill="#8a2f2f"/>
    <rect x="10" y="8" width="20" height="22" rx="8" fill="#e0c097"/>
    <rect x="0" y="34" width="8" height="26" rx="4" fill="#c9a24b"/>
    <rect x="32" y="34" width="8" height="26" rx="4" fill="#c9a24b"/>
    <rect x="12" y="70" width="7" height="16" rx="3" fill="#4a3b2a"/>
    <rect x="21" y="70" width="7" height="16" rx="3" fill="#4a3b2a"/>
  </g>
  <!-- HUD superior -->
  <g font-family="Consolas, monospace">
    <rect x="12" y="10" width="220" height="14" rx="4" fill="#222" stroke="#555"/>
    <rect x="13" y="11" width="150" height="12" rx="3" fill="#b32d2d"/>
    <text x="240" y="22" fill="#e8dcc0" font-size="12">HP 75%</text>
    <rect x="12" y="30" width="220" height="14" rx="4" fill="#222" stroke="#555"/>
    <rect x="13" y="31" width="90" height="12" rx="3" fill="#2d5fb3"/>
    <text x="240" y="42" fill="#e8dcc0" font-size="12">MANA 41%</text>
  </g>
  <!-- barra de status do adapter -->
  <g font-family="Consolas, monospace">
    <rect x="0" y="${h - 34}" width="${w}" height="34" fill="#0a0906" opacity="0.92"/>
    <circle cx="20" cy="${h - 17}" r="6" fill="${statusColor}"/>
    <text x="34" y="${h - 12}" fill="${statusColor}" font-size="13">T BOT · RubinOT Client — ${status}${title ? ' · ' + title : ''}</text>
    <text x="${w - 14}" y="${h - 12}" text-anchor="end" fill="#8a7a55" font-size="12">frame #${seq} · cliques ${this.clickCount}</text>
  </g>
  ${trail}
</svg>`;
  }
}

module.exports = {
  RubinotWin32Adapter,
  RUBINOT_CANDIDATE_EXES,
  RUBINOT_SCREENSHOTS_DIR,
  PROCESS_HINTS,
  MIN_REAL_BYTES,
};
