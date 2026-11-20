'use strict';
// VELS Syndicate — Electron main process (Windows + Linux).
const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, Tray, Menu, Notification, safeStorage, session, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { VelsNode } = require('./core/node');
const Plans = require('./core/plans');

const APP_NAME = 'VELS Syndicate';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
app.setName(APP_NAME);
if (IS_WIN) app.setAppUserModelId('com.vels.syndicate');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, node = null, quitting = false;

const winBuild = IS_WIN ? parseInt(os.release().split('.')[2] || '0', 10) : 0;
const BLUR_MODE = process.platform === 'darwin' ? 'vibrancy' : (winBuild >= 22000 ? 'acrylic' : 'css');

function isDark() { return nativeTheme.shouldUseDarkColors; }
function overlayColors() { return { color: '#00000000', symbolColor: isDark() ? '#f5f5f7' : '#1d1d1f', height: 48 }; }
function iconPath() { return path.join(__dirname, '..', 'build', 'icon.png'); }

// ---------- pairing keys at rest: OS keychain (Windows DPAPI / Linux keyring) ----------
function makeSecretStore() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { kind: 'none' };
    let kind = 'os';
    if (IS_LINUX) {
      const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
      if (backend === 'basic_text' || backend === 'unknown') kind = 'weak';
    }
    return {
      kind,
      encrypt: s => safeStorage.encryptString(s).toString('base64'),
      decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')),
    };
  } catch { return { kind: 'none' }; }
}

function createWindow() {
  const opts = {
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: APP_NAME, icon: iconPath(), show: false,
    titleBarStyle: 'hidden', titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false, devTools: !app.isPackaged,
    },
  };
  if (BLUR_MODE === 'acrylic') { opts.backgroundMaterial = 'acrylic'; opts.backgroundColor = '#00000000'; }
  else if (BLUR_MODE === 'vibrancy') { opts.vibrancy = 'under-window'; opts.backgroundColor = '#00000000'; }
  else opts.backgroundColor = isDark() ? '#16161a' : '#eef0f5';

  win = new BrowserWindow(opts);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('hide', () => { if (node) node.lockAdmin(); });
  win.on('minimize', () => { if (node) node.lockAdmin(); });
  win.on('close', e => { if (!quitting && node && node.settings.keepInTray && tray) { e.preventDefault(); win.hide(); } });
}

// The window only ever shows our own local page: no navigation, popups, webviews or device permissions.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', e => e.preventDefault());
  contents.on('will-attach-webview', e => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send('vels', channel, payload); }

function notify(title, body) {
  if (!Notification.isSupported()) return;
  if (win && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => showWindow());
  n.show();
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createTray() {
  try {
    tray = new Tray(iconPath());
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open VELS Syndicate', click: showWindow },
      { type: 'separator' },
      { label: 'Set this PC to Idle', click: () => node.setStatus(null, 'Idle') },
      { label: 'Set this PC to Busy', click: () => node.setStatus(null, 'Busy') },
      { type: 'separator' },
      { label: 'Quit', click: () => { if (node.monitor.enabled) { showWindow(); send('ask-quit', {}); } else { quitting = true; app.quit(); } } },
    ]));
    tray.on('click', showWindow);
  } catch { tray = null; /* some Linux desktops have no tray */ }
}

function updateTray() {
  if (!tray) return;
  const m = node.monitorInfo();
  tray.setToolTip(m.enabled ? `${APP_NAME} — activity on this PC is shared with ${m.parentName || 'a parent PC'}` : APP_NAME);
}

function applyTheme() {
  const t = node.settings.theme;
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system';
}

// ---------- start with the computer ----------
function linuxAutostartFile() { return path.join(os.homedir(), '.config', 'autostart', 'vels-syndicate.desktop'); }
function applyLoginItem() {
  const on = !!node.settings.startWithWindows;
  if (IS_LINUX) {
    const file = linuxAutostartFile();
    try {
      if (!on) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${exe.replace(/"/g, '')}" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`, { mode: 0o644 });
    } catch {}
    return;
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try { app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] }); } catch {}
}

// ---------- firewall (asks for admin rights) ----------
function setupFirewall() {
  const tcp = node.tcpPort, udp = node.udpPort;
  return new Promise(resolve => {
    if (IS_WIN) {
      const cmds = [
        `netsh advfirewall firewall delete rule name="VELS Syndicate TCP"`,
        `netsh advfirewall firewall delete rule name="VELS Syndicate UDP"`,
        `netsh advfirewall firewall add rule name="VELS Syndicate TCP" dir=in action=allow protocol=TCP localport=${tcp} profile=private,domain`,
        `netsh advfirewall firewall add rule name="VELS Syndicate UDP" dir=in action=allow protocol=UDP localport=${udp} profile=private,domain`,
      ].join(' & ');
      const ps = `Start-Process -FilePath cmd.exe -ArgumentList '/c ${cmds.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`;
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, err => {
        resolve(err ? { ok: false, error: 'Windows did not allow the change (the admin prompt was declined).' } : { ok: true });
      });
      return;
    }
    if (IS_LINUX) {
      // Only open the ports to private (home/office) address ranges.
      const nets = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
      const rules = nets.flatMap(n => [`ufw allow proto tcp from ${n} to any port ${tcp}`, `ufw allow proto udp from ${n} to any port ${udp}`]).join(' && ');
      execFile('sh', ['-c', 'command -v ufw'], err => {
        if (err) return resolve({ ok: false, error: 'No ufw firewall found — most Linux desktops then allow local connections already.' });
        execFile('pkexec', ['sh', '-c', rules], e2 => resolve(e2 ? { ok: false, error: 'The admin prompt was declined or pkexec is missing.' } : { ok: true }));
      });
      return;
    }
    resolve({ ok: false, error: 'Not needed on this system' });
  });
}

// ---------- IPC: every call from the window is type-checked ----------
const isId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v);
const optId = v => v == null || isId(v);
function wrap(fn) {
  return async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  };
}
function need(cond, msg = 'Invalid request') { if (!cond) throw new Error(msg); }

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, wrap(fn));
  h('env', () => ({ blur: BLUR_MODE, platform: process.platform, version: app.getVersion(), dark: isDark(), portable: !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE), tray: !!tray }));
  h('state', () => node.getState());
  h('pair', target => { need(target && typeof target === 'object'); return node.pair({ id: target.id, host: target.host, port: target.port }); });
  h('pairPin', (sid, pin) => { need(isId(sid) && typeof pin === 'string' && pin.length <= 12); return node.pairPin(sid, pin); });
  h('pairCancel', sid => { need(isId(sid)); return node.pairCancel(sid); });
  h('unpair', (id, pin) => { need(isId(id) && (pin == null || typeof pin === 'string')); return node.unpair(id, pin); });
  h('setPerm', (id, kind, value) => { need(isId(id) && ['tasks', 'files', 'status'].includes(kind) && typeof value === 'string'); return node.setPerm(id, kind, value); });
  h('runTask', spec => { need(spec && typeof spec === 'object' && optId(spec.target)); return node.runTask({ target: spec.target, cmd: spec.cmd, shell: spec.shell, title: spec.title }); });
  h('cancelTask', id => { need(isId(id)); return node.cancelTask(id); });
  h('approveTask', (id, d) => { need(isId(id)); return node.approveTask(id, d); });
  h('taskOutput', id => { need(isId(id)); return node.getTaskOutput(id); });
  h('clearTasks', () => node.clearFinishedTasks());
  h('setStatus', (target, status, role) => { need(optId(target)); return node.setStatus(target, status, role); });
  h('sendFiles', (target, paths) => { need(isId(target) && Array.isArray(paths) && paths.length <= 1000 && paths.every(p => typeof p === 'string')); return node.sendFiles(target, paths); });
  h('pickAndSend', async target => {
    need(isId(target));
    const r = await dialog.showOpenDialog(win, { title: 'Choose files to send', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return null;
    return node.sendFiles(target, r.filePaths);
  });
  h('pickFolderAndSend', async target => {
    need(isId(target));
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to send', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return node.sendFiles(target, r.filePaths);
  });
  h('answerFiles', (batchId, accept) => { need(isId(batchId) && typeof accept === 'boolean'); return node.answerFiles(batchId, accept); });
  h('cancelTransfer', id => { need(isId(id)); return node.cancelTransfer(id); });
  h('clearTransfers', () => node.clearFinishedTransfers());
  h('openReceived', async () => { fs.mkdirSync(node.settings.receiveDir, { recursive: true }); return shell.openPath(node.settings.receiveDir); });
  // open or show a finished transfer (only files this app sent or received, looked up by id)
  h('openTransfer', async (id, how) => {
    need(isId(id) && (how === 'open' || how === 'show'));
    const p = node.transferPath(id);
    if (!p) throw new Error('That file was moved or deleted');
    if (how === 'show') { shell.showItemInFolder(p); return; }
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  h('pickReceiveDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should received files go?', properties: ['openDirectory', 'createDirectory'], defaultPath: node.settings.receiveDir });
    if (r.canceled || !r.filePaths.length) return null;
    node.updateSettings({ receiveDir: r.filePaths[0] });
    return r.filePaths[0];
  });
  h('settings', patch => {
    need(patch && typeof patch === 'object');
    node.updateSettings(patch);
    if ('theme' in patch) applyTheme();
    if ('startWithWindows' in patch) applyLoginItem();
    return node.settings;
  });
  h('unblock', key => { need(typeof key === 'string' && /^(ip|id):[\w.:-]{1,64}$/.test(key)); return node.unblock(key); });
  h('clearLog', () => node.clearLog());
  h('firewall', () => setupFirewall());
  h('activateLicense', key => { need(typeof key === 'string' && key.length <= 120); return node.activateLicense(key); });
  h('removeLicense', () => node.removeLicense());
  // opens ONLY the store's own checkout page from src/config/store.js in the normal web browser
  h('openCheckout', tier => {
    need(Plans.PAID.includes(tier));
    const url = node.license.info().checkout[tier];
    if (!url) throw new Error('No store link is set up in this build yet.');
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('Store link must use https');
    return shell.openExternal(u.toString());
  });
  h('quit', async pin => {
    if (node.monitor.enabled) await node.verifyMainPasscode(pin);
    quitting = true; app.quit();
  });
  h('monitor', async opts => {
    need(opts && typeof opts === 'object');
    await node.configureMonitor({ enabled: opts.enabled, urls: opts.urls, keepDays: opts.keepDays, pin: opts.pin });
    applyLoginItem(); updateTray();
  });
  // main PC passcode: on the main PC this unlocks admin for 10 minutes; elsewhere the main PC checks it
  h('checkPin', pin => { need(typeof pin === 'string'); return node.isMain ? node.unlockAdmin(pin) : node.verifyMainPasscode(pin); });
  h('lockAdmin', () => node.lockAdmin());
  h('chooseMain', (peerId, who, pin) => { need(isId(peerId) && ['self', 'peer'].includes(who) && typeof pin === 'string'); return node.chooseMain(peerId, who, pin); });
  h('becomeMain', pin => { need(typeof pin === 'string'); return node.becomeMain(pin); });
  h('changePasscode', (oldPin, newPin) => { need(typeof oldPin === 'string' && typeof newPin === 'string'); return node.changePasscode(oldPin, newPin); });
  h('releaseMain', pin => { need(typeof pin === 'string'); return node.releaseMain(pin); });
  h('history', (id, daysAgo) => { need(isId(id) && Number.isInteger(daysAgo)); return node.requestHistory(id, daysAgo); });
  h('describeSites', hosts => { need(Array.isArray(hosts) && hosts.length <= 200 && hosts.every(x => typeof x === 'string' && x.length <= 253)); return node.describeSites(hosts); });
  h('deleteKidHistory', id => { need(isId(id)); return node.deleteKidHistory(id).then(() => true); });
  h('openHistoryFolder', async pin => {
    need(pin == null || (typeof pin === 'string' && pin.length <= 6));
    const dir = await node.openHistoryFolderCheck(pin);
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });
  // copy plain text (history lines) to the clipboard
  h('copyText', async text => { need(typeof text === 'string' && text.length <= 200000); await clipboard.writeText(text); return true; });
  // open a website from a kid's history in the default browser (http/https only)
  h('openUrl', raw => {
    need(typeof raw === 'string' && raw.length <= 2048);
    const u = new URL(raw);
    need(u.protocol === 'https:' || u.protocol === 'http:', 'Only web addresses can be opened');
    return shell.openExternal(u.toString());
  });
}

app.whenReady().then(async () => {
  // deny camera/mic/location/notifications-from-page etc. — the app never needs them
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  node = new VelsNode({ dataDir: path.join(app.getPath('userData'), 'node'), secretStore: makeSecretStore() });
  applyTheme();
  registerIpc();

  node.on('state', s => send('state', s));
  node.on('toast', t => send('toast', t));
  node.on('task-out', d => send('task-out', d));
  node.on('pair-request', r => { send('pair-request', r); if (!r.wrong) notify('Access request', `${r.peerName} wants to connect. Open VELS Syndicate to see the PIN.`); });
  node.on('pair-pin-needed', p => send('pair-pin-needed', p));
  node.on('choose-main', p => send('choose-main', p));
  node.on('pair-done', p => send('pair-done', p));
  node.on('task-approval', a => { send('task-approval', a); notify('Task request', `${a.peerName} wants to run: ${a.title || a.cmd.slice(0, 80)}`); });
  node.on('request-gone', g => send('request-gone', g));
  node.on('file-offer', o => { send('file-offer', o); notify('Incoming files', `${o.peerName} wants to send ${o.count} file${o.count === 1 ? '' : 's'}`); });
  node.on('file-received', f => send('toast', { kind: 'ok', text: `Received ${f.name}` }));
  node.on('task-finished', f => notify('Task finished', `${f.title} — ${f.state}`));
  node.on('security-alert', e => notify('Security', e.text));

  nativeTheme.on('updated', () => {
    send('theme', { dark: isDark() });
    if (win && !win.isDestroyed()) { try { win.setTitleBarOverlay(overlayColors()); } catch {} if (BLUR_MODE === 'css') win.setBackgroundColor(isDark() ? '#16161a' : '#eef0f5'); }
  });

  try { await node.start(); }
  catch (e) {
    dialog.showErrorBox(APP_NAME, `Could not open network port ${node.tcpPort}. Is VELS Syndicate already running?\n\n${e.message}`);
    quitting = true; app.quit(); return;
  }
  createTray();
  createWindow();
  applyLoginItem();
  updateTray();
  node.on('monitor-changed', () => updateTray());
  if (node.monitor.enabled) {
    // always tell whoever uses this PC that activity is shared
    setTimeout(() => {
      if (!Notification.isSupported()) return;
      new Notification({ title: APP_NAME, body: `Activity on this PC (apps, games and websites) is shared with ${node.monitorInfo().parentName || 'a parent PC'}.`, icon: iconPath() }).show();
    }, 4000);
  }
});

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; if (node) node.stop(); });
app.on('window-all-closed', () => { if (!node || !node.settings.keepInTray || !tray) app.quit(); });
