/**
 * T BOT — Desktop app (Electron shell + Runtime API client UI)
 * apps/desktop/main.js creates:
 *   1. the main BrowserWindow (dashboard, spec §23)
 *   2. a frameless always-on-top overlay window (spec §25)
 * The renderer talks to the SAME local Runtime API as everything else —
 * the UI is a pure projection of runtime state (§41). No mock endpoints.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TBOT_PORT ?? 8791);
const API = `http://127.0.0.1:${PORT}`;

let runtimeProc = null;
let win = null;
let overlay = null;

function startRuntime() {
  // the runtime is a separate real process — desktop never simulates it
  runtimeProc = spawn(process.execPath.replace('electron', 'node') || 'node',
    [path.join(__dirname, '../../runtime/api/server.js')],
    { env: { ...process.env, TBOT_PORT: String(PORT) }, stdio: 'inherit' });
  runtimeProc.on('exit', (code) => console.log(`[desktop] runtime exited code=${code}`));
}

function createWindows() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 980, minHeight: 640,
    backgroundColor: '#101014', title: 'T BOT',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  overlay = new BrowserWindow({
    width: 320, height: 190, x: 40, y: 40,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
}

ipcMain.handle('api:get', async (_e, p) => (await fetch(API + p)).json());
ipcMain.handle('api:post', async (_e, p, body) => (await fetch(API + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json());
ipcMain.handle('api:put', async (_e, p, body) => (await fetch(API + p, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json());
ipcMain.handle('api:delete', async (_e, p) => (await fetch(API + p, { method: 'DELETE' })).json());
ipcMain.handle('api:ws-url', () => `ws://127.0.0.1:${PORT}/ws/runtime`);

app.whenReady().then(() => { startRuntime(); createWindows(); });
app.on('window-all-closed', () => { runtimeProc?.kill(); app.quit(); });
