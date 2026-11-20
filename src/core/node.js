'use strict';
// VELS Syndicate network node: discovery, pairing, encrypted links, tasks, files, stats, security log.
// Has no Electron dependency so it can be tested with plain Node (Windows or Linux).
const EventEmitter = require('events');
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const C = require('./crypto');
const Stats = require('./stats');
const V = require('./validate');
const { ActivityMonitor, pageUrl, siteFromUrl } = require('./activity');
const { SiteInfo } = require('./sitedesc');
const Plans = require('./plans');
const { License } = require('./license');

const PROTO = 2;
const MAX_LINE = 1536 * 1024;      // encrypted frames (file chunks are ~350 KB)
const MAX_PLAIN_LINE = 16 * 1024;  // before a connection is authenticated
const CHUNK = 192 * 1024;
const STATUSES = V.STATUSES;
const PIN_BITS = 20;               // 6-digit PIN < 2^20
const IS_WIN = process.platform === 'win32';
const ACTIVITY_KINDS = ['game', 'browser', 'app', 'away', 'locked'];
const TASK_STATES = ['sent', 'pending', 'queued', 'running', 'done', 'failed', 'cancelled', 'rejected', 'lost'];

// ---------- line-framed connection ----------
// After the handshake every line is AES-256-GCM encrypted and carries a sequence number,
// so a frame that is altered, replayed, dropped or reordered closes the connection.
class Conn extends EventEmitter {
  constructor(socket, initiator) {
    super();
    this.socket = socket;
    this.initiator = initiator;
    this.buf = '';
    this.sendKey = null;
    this.recvKey = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.peerId = null;
    this.closed = false;
    this.remoteIp = (socket.remoteAddress || '').replace(/^::ffff:/i, '');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.setEncoding('utf8');
    socket.on('data', d => this._data(d));
    socket.on('error', () => {});
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }
  _violation(kind) { this.emit('violation', kind); this.destroy(); }
  _data(d) {
    if (this.closed) return;
    this.buf += d;
    if (this.buf.length > (this.recvKey ? MAX_LINE : MAX_PLAIN_LINE)) return this._violation('oversized message');
    let i;
    while (!this.closed && (i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      if (this.recvKey) {
        let inner;
        try {
          const outer = JSON.parse(line);
          if (!outer || typeof outer.c !== 'string') throw new Error('bad frame');
          inner = C.open(this.recvKey, outer.c);
        } catch { return this._violation('tampered or unreadable data'); }
        if (!inner || inner.q !== this.recvSeq) return this._violation('replayed or out-of-order data');
        this.recvSeq++;
        msg = inner.d;
      } else {
        try { msg = JSON.parse(line); } catch { return this._violation('malformed handshake'); }
      }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') this.emit('msg', msg);
    }
  }
  sendPlain(obj) { if (!this.closed) return this.socket.write(JSON.stringify(obj) + '\n'); return false; }
  send(obj) {
    if (this.closed || !this.sendKey) return false;
    return this.socket.write(JSON.stringify({ c: C.seal(this.sendKey, { q: this.sendSeq++, d: obj }) }) + '\n');
  }
  async sendAsync(obj) {
    if (this.closed) throw new Error('disconnected');
    if (!this.send(obj)) {
      await new Promise((res, rej) => {
        const done = () => { this.socket.off('drain', done); this.off('close', fail); res(); };
        const fail = () => { this.socket.off('drain', done); rej(new Error('disconnected')); };
        this.socket.once('drain', done);
        this.once('close', fail);
      });
    }
  }
  destroy() { if (!this.closed) { this.closed = true; try { this.socket.destroy(); } catch {} } }
}

// ---------- files on disk (owner-only permissions on Linux) ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
// Files that must survive updates and restarts (this PC's ID, pairings, settings).
// A file that is briefly locked (antivirus, Windows still starting) is retried, then the backup is used.
// Returns { data, state }: state is 'ok', 'backup', 'missing' or 'unreadable' (exists but could not be read).
function readKeep(file, isValid = d => d && typeof d === 'object') {
  const tryRead = f => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return isValid(d) ? d : undefined; } catch { return undefined; } };
  const exists = fs.existsSync(file), bak = file + '.bak', hasBak = fs.existsSync(bak);
  if (!exists && !hasBak) return { data: null, state: 'missing' };
  if (exists) for (let i = 0; i < 4; i++) { const d = tryRead(file); if (d !== undefined) return { data: d, state: 'ok' }; pause(150); }
  if (hasBak) { const d = tryRead(bak); if (d !== undefined) return { data: d, state: 'backup' }; }
  return { data: null, state: exists ? 'unreadable' : 'missing' };
}
// Saves the file and keeps a backup copy of what was just saved.
function writeKeep(file, data) {
  writeJSON(file, data);
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
}
// An unreadable file is never overwritten: it is moved aside so it can still be recovered by hand.
function setAside(file) {
  try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch {}
}
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 10000; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q; }
  return `${base}-${Date.now()}${ext}`;
}
let bashPath;
function hasBash() {
  if (bashPath !== undefined) return bashPath;
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore', timeout: 3000 }); bashPath = 'bash'; } catch { bashPath = null; }
  return bashPath;
}

const DEFAULT_PRESETS = IS_WIN ? [
  { name: 'System info', shell: 'powershell', cmd: 'Get-ComputerInfo | Select-Object CsName, OsName, OsVersion, CsTotalPhysicalMemory' },
  { name: 'Network config', shell: 'cmd', cmd: 'ipconfig' },
  { name: 'Top processes', shell: 'powershell', cmd: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, WS' },
  { name: 'System info', shell: 'bash', cmd: 'uname -a; head -3 /etc/os-release; free -h; df -h /' },
  { name: 'Network config', shell: 'bash', cmd: 'ip -brief address' },
] : [
  { name: 'System info', shell: 'bash', cmd: 'uname -a; head -3 /etc/os-release; free -h; df -h /' },
  { name: 'Network config', shell: 'bash', cmd: 'ip -brief address' },
  { name: 'Top processes', shell: 'bash', cmd: 'ps aux --sort=-%cpu | head -15' },
  { name: 'System info', shell: 'powershell', cmd: 'Get-ComputerInfo | Select-Object CsName, OsName, OsVersion, CsTotalPhysicalMemory' },
  { name: 'Network config', shell: 'cmd', cmd: 'ipconfig' },
];

class VelsNode extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dataDir = opts.dataDir;
    // 0 = let the system pick a free port (used by the tests); the real port is read back in start()
    this.tcpPort = opts.tcpPort === 0 ? 0 : (opts.tcpPort || 47821);
    this.udpPort = opts.udpPort || 47820;
    this.discovery = opts.discovery !== false;
    this.writeHighWaterMark = opts.writeHighWaterMark || 1024 * 1024; // tests use a tiny value to simulate a slow disk
    // secretStore: how pairing keys are protected on disk. Electron passes the OS keychain
    // (Windows DPAPI / Linux keyring). Without one, keys are stored unprotected and the UI says so.
    this.secretStore = opts.secretStore || { kind: 'none' };
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try { if (!IS_WIN) fs.chmodSync(this.dataDir, 0o700); } catch {}

    this.identityFile = path.join(this.dataDir, 'identity.json');
    this.peersFile = path.join(this.dataDir, 'peers.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.logFile = path.join(this.dataDir, 'security-log.jsonl');

    // this PC's ID must never change on its own, or every paired PC would see a stranger
    this._startNotes = [];
    const idr = readKeep(this.identityFile, d => d && V.isId(d.id));
    let ident = idr.data;
    if (idr.state === 'backup') { writeKeep(this.identityFile, ident); this._startNotes.push(['warn', 'storage', 'This PC\'s ID file could not be read, so the backup copy was used. Pairings are kept.']); }
    if (!ident) {
      if (idr.state === 'unreadable') { setAside(this.identityFile); this._startNotes.push(['alert', 'storage', 'This PC\'s ID file was damaged and had no backup, so a new ID was made. The old file was kept next to it.']); }
      ident = { id: C.randomId(), created: Date.now() };
      writeKeep(this.identityFile, ident);
    } else if (!fs.existsSync(this.identityFile + '.bak')) { try { fs.copyFileSync(this.identityFile, this.identityFile + '.bak'); } catch {} }
    this.id = ident.id;

    const sr = readKeep(this.settingsFile);
    if (sr.state === 'unreadable') { setAside(this.settingsFile); this._startNotes.push(['alert', 'storage', 'The settings file was damaged and had no backup. It was kept next to the new one; settings went back to the defaults.']); }
    if (sr.state === 'backup') this._startNotes.push(['warn', 'storage', 'The settings file could not be read, so the backup copy was used.']);
    const stored = sr.data || {};
    this.settings = Object.assign({
      name: V.cleanText(os.hostname(), 40, 'This PC'),
      theme: 'system', accent: 'blue',
      taskPolicy: 'ask',          // 'ask' | 'deny'
      filePolicy: 'ask',          // 'ask' | 'auto'
      receiveDir: path.join(os.homedir(), 'Downloads', 'VELS Syndicate'),
      maxParallel: 2, keepInTray: true, startWithWindows: false,
      allowPairing: true, lanOnly: true, describeSites: true,
      presets: DEFAULT_PRESETS,
    }, V.cleanSettingsPatch(stored));
    this.manualStatus = 'Idle';
    this.role = V.cleanText(stored.role, 40);
    // parental monitoring (this PC shares its activity with one parent PC)
    const mon = stored.monitor && typeof stored.monitor === 'object' ? stored.monitor : {};
    this.monitor = {
      enabled: mon.enabled === true && V.isId(mon.parentId),
      parentId: V.isId(mon.parentId) ? mon.parentId : '',
      urls: mon.urls !== false,
      keepDays: Number.isInteger(mon.keepDays) ? Math.min(365, Math.max(1, mon.keepDays)) : 30,
    };
    const mn = stored.main && typeof stored.main === 'object' ? stored.main : {};
    const okV = v => v && V.isB64(v.salt, 64) && V.isB64(v.hash, 64) ? { salt: v.salt, hash: v.hash, digits: v.digits === 4 ? 4 : 6 } : null;
    this.main = { isMain: mn.isMain === true && !!okV(mn.lock), mainId: V.isId(mn.mainId) ? mn.mainId : '', lock: okV(mn.lock), fallback: okV(mn.fallback) };
    if (this.main.isMain) this.main.mainId = this.id;
    if (this.monitor.enabled && (this.main.isMain || this.monitor.parentId !== this.main.mainId)) this.monitor.enabled = false;
    this.adminUntil = 0;
    this.pinFails = new Map();
    this.pendingPin = new Map();
    this.pendingHistory = new Map();
    this.selfActivity = null;
    this.activity = new ActivityMonitor({ dir: path.join(this.dataDir, 'activity'), includeUrls: this.monitor.urls, keepDays: this.monitor.keepDays, source: opts.activitySource || null });
    this.activity.on('change', a => this._onOwnActivity(a));
    // plans: this PC's own license, or the main PC's plan, whichever is better
    this.license = new License({ file: path.join(this.dataDir, 'license.json'), secretStore: this.secretStore, store: opts.store, fetchImpl: opts.fetchImpl });
    this.planOverrides = opts.planLimits || {};
    // short "what is this website" lines for the Family history (main PC only)
    this.siteInfo = new SiteInfo({ file: path.join(this.dataDir, 'site-info.json'), fetchImpl: opts.siteFetch, lookup: opts.siteLookup });
    this.mainPlan = Plans.norm(mn.plan);

    this.secLog = [];
    this._loadLog();
    this.peers = {};
    this._loadPeers();

    this.nearby = {};
    this.conns = {};
    this.connecting = {};
    this.retryAt = {};
    this.remote = {};
    this.tasks = new Map();
    this.queue = [];
    this.running = new Map();
    this.transfers = new Map();
    this.pairSessions = new Map();
    this.pendingBatches = new Map();
    this.transfersFile = path.join(this.dataDir, 'transfers.json');
    this._loadTransfers();
    this.blocks = new Map();       // 'ip:x' | 'id:x' -> {until, reason, label}
    this.authFails = new Map();    // ip -> {count, first}
    this.pairRecent = [];
    this.preAuth = new Map();
    this.stats = Stats.snapshot();
    this._dirty = true;
  }

  // ---------- secrets at rest ----------
  get keyProtection() { return this.secretStore.kind || 'none'; }
  _loadPeers() {
    const pr = readKeep(this.peersFile);
    if (pr.state === 'unreadable') { setAside(this.peersFile); this._startNotes.push(['alert', 'storage', 'The list of paired PCs was damaged and had no backup. It was kept next to the new one; request access again to reconnect.']); }
    if (pr.state === 'backup') this._startNotes.push(['warn', 'storage', 'The list of paired PCs could not be read, so the backup copy was used.']);
    const raw = pr.data || {};
    // pairings whose key can't be unlocked right now are kept exactly as saved, never deleted,
    // and tried again shortly and at the next start (e.g. Windows still starting up)
    this._lockedPeers = {};
    let migrate = false;
    for (const [id, p] of Object.entries(raw)) {
      if (!V.isId(id) || !p || typeof p !== 'object') continue;
      let key = null;
      if (typeof p.keyEnc === 'string') {
        if (this.secretStore.decrypt) { try { key = this.secretStore.decrypt(p.keyEnc); } catch { key = null; } }
        if (!key || !V.isB64(key, 64)) { this._lockedPeers[id] = p; continue; }
      } else if (typeof p.key === 'string') {
        key = p.key;
        if (this.secretStore.encrypt) migrate = true; // upgrade plain keys to protected storage
      }
      if (!key || !V.isB64(key, 64)) continue;
      const perms = V.cleanPerms(p.perms || (p.trusted ? { tasks: 'allow', files: 'allow', status: 'allow' } : null));
      if (p.trusted && !p.perms) migrate = true;
      this.peers[id] = { child: p.child === true, name: V.cleanText(p.name, 64, 'PC'), key, perms, lastHost: V.isStr(p.lastHost, 64) ? p.lastHost : '', lastPort: V.num(p.lastPort, 1, 65535, 47821), pairedAt: V.num(p.pairedAt, 0, 1e15) };
    }
    if (migrate) this._savePeers();
  }
  // tries again to unlock pairings that couldn't be unlocked at start
  _retryLockedPeers() {
    const ids = Object.keys(this._lockedPeers || {});
    if (!ids.length || !this.secretStore.decrypt) return;
    let got = 0;
    for (const id of ids) {
      if (this.peers[id]) { delete this._lockedPeers[id]; continue; }
      const p = this._lockedPeers[id];
      let key = null;
      try { key = this.secretStore.decrypt(p.keyEnc); } catch {}
      if (!key || !V.isB64(key, 64)) continue;
      delete this._lockedPeers[id];
      this.peers[id] = { child: p.child === true, name: V.cleanText(p.name, 64, 'PC'), key, perms: V.cleanPerms(p.perms), lastHost: V.isStr(p.lastHost, 64) ? p.lastHost : '', lastPort: V.num(p.lastPort, 1, 65535, 47821), pairedAt: V.num(p.pairedAt, 0, 1e15) };
      got++;
    }
    if (got) { this.audit('info', 'key', `Unlocked ${got} saved pairing${got > 1 ? 's' : ''} on the second try.`); this._savePeers(); this._tickConnect(); }
  }
  _savePeers() {
    const out = {};
    for (const [id, p] of Object.entries(this.peers)) {
      const rec = { child: !!p.child, name: p.name, perms: p.perms, lastHost: p.lastHost, lastPort: p.lastPort, pairedAt: p.pairedAt };
      if (this.secretStore.encrypt) rec.keyEnc = this.secretStore.encrypt(p.key);
      else rec.key = p.key;
      out[id] = rec;
    }
    // keep pairings that couldn't be unlocked yet exactly as they were (unless re-paired or removed since)
    for (const [id, p] of Object.entries(this._lockedPeers || {})) if (!out[id]) out[id] = p;
    writeKeep(this.peersFile, out);
    this._changed();
  }

  // ---------- security log ----------
  _loadLog() {
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-300);
      this.secLog = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { this.secLog = []; }
  }
  audit(level, kind, text) {
    const e = { ts: Date.now(), level, kind, text: String(text).slice(0, 400) };
    this.secLog.push(e);
    if (this.secLog.length > 300) this.secLog.splice(0, this.secLog.length - 300);
    try {
      try { if (fs.statSync(this.logFile).size > 1024 * 1024) fs.renameSync(this.logFile, this.logFile + '.old'); } catch {}
      fs.appendFileSync(this.logFile, JSON.stringify(e) + '\n', { mode: 0o600 });
    } catch {}
    this._changed();
    if (level === 'alert') this.emit('security-alert', e);
  }
  clearLog() { this.secLog = []; try { fs.writeFileSync(this.logFile, '', { mode: 0o600 }); } catch {} this.audit('info', 'log', 'Security log cleared'); }

  // ---------- blocking ----------
  _blocked(...keys) {
    const now = Date.now();
    for (const k of keys) { const b = this.blocks.get(k); if (b && b.until > now) return true; if (b) this.blocks.delete(k); }
    return false;
  }
  _block(ms, reason, label, ...keys) {
    const until = Date.now() + ms;
    for (const k of keys) if (k) this.blocks.set(k, { until, reason, label });
    this._changed();
  }
  unblock(key) {
    this._requireAdmin(); this.blocks.delete(key); this.audit('info', 'block', `Unblocked ${key.replace(/^(ip|id):/, '')}`); }
  _authFailed(ip, why) {
    const now = Date.now();
    const f = this.authFails.get(ip) || { count: 0, first: now };
    if (now - f.first > 10 * 60000) { f.count = 0; f.first = now; }
    f.count++;
    this.authFails.set(ip, f);
    this.audit('warn', 'auth', `Rejected a connection from ${ip}: ${why}`);
    if (f.count >= 5) {
      this._block(15 * 60000, 'Repeated failed sign-ins', ip, 'ip:' + ip);
      this.audit('alert', 'block', `Blocked ${ip} for 15 minutes after repeated failed sign-ins`);
      this.authFails.delete(ip);
    }
  }

  // ---------- lifecycle ----------
  async start() {
    this.stopped = false;
    await new Promise((res, rej) => {
      this.server = net.createServer(s => this._incoming(s));
      this.server.maxConnections = 64;
      this.server.on('error', rej);
      this.server.listen(this.tcpPort, '0.0.0.0', () => { this.server.off('error', rej); this.tcpPort = this.server.address().port; res(); });
    });
    if (this.discovery) this._startDiscovery();
    this.timers = [
      setInterval(() => this._tickStats(), 2000),
      setInterval(() => this._tickConnect(), 3000),
      setInterval(() => this._tickPing(), 5000),
      setInterval(() => this._flushState(), 400),
    ];
    this._tickStats();
    setTimeout(() => this._tickConnect(), 500);
    if (this.monitor.enabled) this.activity.start();
    this.timers.push(setInterval(() => this._checkLicense(), 3600000));
    setTimeout(() => this._checkLicense(), 15000);
    this.audit('info', 'start', `VELS Syndicate started (key storage: ${this.keyProtection === 'os' ? 'protected' : this.keyProtection === 'weak' ? 'weakly protected' : 'not protected'})`);
    for (const [lvl, kind, text] of this._startNotes.splice(0)) this.audit(lvl, kind, text);
    const locked = Object.keys(this._lockedPeers || {}).length;
    if (locked) {
      this.audit('warn', 'key', `${locked} saved pairing${locked > 1 ? 's' : ''} couldn't be unlocked yet. They are kept and will be tried again.`);
      this._retryTimer = setTimeout(() => this._retryLockedPeers(), 20000);
    }
  }

  stop() {
    this.stopped = true; // a connection still being set up must not finish after this
    clearTimeout(this._retryTimer);
    (this.timers || []).forEach(clearInterval);
    try { this.udp && this.udp.close(); } catch {}
    try { this.server && this.server.close(); } catch {}
    for (const c of Object.values(this.conns)) c.destroy();
    for (const child of this.running.values()) this._kill(child);
    this.activity.stop();
  }

  _changed() { this._dirty = true; }
  _flushState() {
    if (!this._dirty) return;
    this._dirty = false;
    const finished = [...this.transfers.values()].filter(t => ['done', 'failed', 'declined', 'cancelled'].includes(t.state)).length;
    if (finished !== this._finishedCount) {
      this._finishedCount = finished;
      // keep memory bounded on PCs that send lots of files: drop the oldest finished entries
      if (this.transfers.size > 600) {
        const old = [...this.transfers.values()].filter(t => ['done', 'failed', 'declined', 'cancelled'].includes(t.state)).sort((a, b) => a.createdAt - b.createdAt);
        for (const t of old.slice(0, this.transfers.size - 500)) this.transfers.delete(t.id);
      }
      this._saveTransfers();
    }
    this.emit('state', this.getState());
  }
  _toast(kind, text) { this.emit('toast', { kind, text }); }
  _saveSettings() { writeKeep(this.settingsFile, Object.assign({}, this.settings, { role: this.role, monitor: this.monitor, main: Object.assign({}, this.main, { plan: this.mainPlan }) })); this._changed(); }

  // ---------- discovery ----------
  _startDiscovery() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    udp.on('error', e => { this._toast('warn', 'Discovery unavailable: ' + e.message); });
    udp.on('message', (buf, rinfo) => {
      if (buf.length > 1024) return;
      if (this.settings.lanOnly && !V.isLocalAddress(rinfo.address)) return;
      let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!m || m.t !== 'vels-hello' || !V.isId(m.id) || m.id === this.id) return;
      const port = Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : 47821;
      const prev = this.nearby[m.id];
      this.nearby[m.id] = { id: m.id, name: V.cleanText(m.name, 64, 'Unknown PC'), host: rinfo.address, port, lastSeen: Date.now() };
      if (!prev || prev.name !== this.nearby[m.id].name) this._changed();
      if (m.q) this._beacon(rinfo.address, false);
    });
    udp.bind(this.udpPort, () => {
      try { udp.setBroadcast(true); } catch {}
      this._beaconAll(true);
      this.timers.push(setInterval(() => this._beaconAll(false), 4000));
      this.timers.push(setInterval(() => this._expireNearby(), 5000));
    });
  }
  _beaconMsg(q) { return Buffer.from(JSON.stringify({ t: 'vels-hello', v: PROTO, id: this.id, name: this.settings.name, port: this.tcpPort, q: q ? 1 : 0 })); }
  _beacon(addr, q) { try { this.udp.send(this._beaconMsg(q), this.udpPort, addr); } catch {} }
  _beaconAll(q) {
    const targets = new Set(['255.255.255.255']);
    for (const i of Stats.localIPs()) {
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      targets.add(a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
    }
    for (const t of targets) this._beacon(t, q);
  }
  _expireNearby() {
    const now = Date.now();
    for (const [id, n] of Object.entries(this.nearby)) if (now - n.lastSeen > 15000) { delete this.nearby[id]; this._changed(); }
  }

  // ---------- connections ----------
  _tickConnect() {
    if (this.stopped) return;
    const now = Date.now();
    for (const [id, p] of Object.entries(this.peers)) {
      if (this.conns[id] || this.connecting[id] || (this.retryAt[id] || 0) > now) continue;
      const n = this.nearby[id];
      const host = n ? n.host : p.lastHost, port = n ? n.port : p.lastPort;
      if (!host) continue;
      this._connectAuth(id, host, port || 47821);
    }
  }

  _dial(host, port) {
    return new Promise((res, rej) => {
      const s = net.connect({ host, port });
      const to = setTimeout(() => { s.destroy(); rej(new Error('Timed out reaching ' + host)); }, 5000);
      s.once('connect', () => { clearTimeout(to); res(s); });
      s.once('error', e => { clearTimeout(to); rej(e); });
    });
  }

  async _connectAuth(peerId, host, port) {
    this.connecting[peerId] = true; this._changed();
    let conn;
    try {
      const sock = await this._dial(host, port);
      conn = new Conn(sock, true);
      const kp = C.genKeyPair(), nA = C.nonce();
      const peer = this.peers[peerId];
      const key = Buffer.from(peer.key, 'base64');
      let ready = false;
      const early = []; // messages that arrive together with 'welcome'
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('handshake timeout')), 8000);
        conn.on('close', () => { clearTimeout(to); rej(new Error('closed')); });
        conn.on('msg', m => {
          if (ready) { early.push(m); return; }
          if (m.t === 'auth-unknown') {
            clearTimeout(to);
            delete this.peers[peerId]; this._savePeers();
            this.audit('warn', 'pair', `${peer.name} no longer recognizes this PC — removed it from the paired list`);
            this._toast('warn', `${peer.name} no longer recognizes this PC. Request access again to reconnect.`);
            return rej(new Error('unknown'));
          }
          if (m.t === 'auth-chal' && !conn.sendKey) {
            if (m.id !== peerId || typeof m.epk !== 'string' || !V.isB64(m.nonce, 64)) return rej(new Error('wrong peer'));
            const exp = C.hmac(key, 'S', this.id, peerId, kp.pub, m.epk, nA, m.nonce);
            if (!C.safeEqual(exp, m.mac)) {
              this.audit('alert', 'auth', `A computer at ${host} pretended to be ${peer.name} (it failed the key check)`);
              return rej(new Error('bad server proof'));
            }
            conn.sendPlain({ t: 'auth-resp', mac: C.hmac(key, 'C', this.id, peerId, kp.pub, m.epk, nA, m.nonce) });
            const k = C.hkdf(C.dh(kp.privateKey, m.epk), key, `vels-sess|${nA}|${m.nonce}`, 64);
            conn.sendKey = k.subarray(0, 32); conn.recvKey = k.subarray(32, 64);
            return;
          }
          if (m.t === 'welcome' && conn.recvKey) { ready = true; clearTimeout(to); res(); }
        });
        conn.sendPlain({ t: 'hello', v: PROTO, mode: 'auth', id: this.id, name: this.settings.name, port: this.tcpPort, epk: kp.pub, nonce: nA });
      });
      conn.removeAllListeners('msg'); conn.removeAllListeners('close');
      this._adopt(conn, peerId);
      for (const m of early) { if (this.conns[peerId] !== conn) break; try { this._onMessage(peerId, conn, m); } catch {} }
    } catch (e) {
      if (conn) conn.destroy();
      this.retryAt[peerId] = Date.now() + 8000;
    } finally {
      delete this.connecting[peerId]; this._changed();
    }
  }

  _incoming(sock) {
    if (this.stopped) return sock.destroy();
    const ip = (sock.remoteAddress || '').replace(/^::ffff:/i, '');
    sock.on('error', () => {});
    if (this.settings.lanOnly && !V.isLocalAddress(ip)) {
      this.audit('alert', 'net', `Refused a connection from ${ip} (outside your local network)`);
      return sock.destroy();
    }
    if (this._blocked('ip:' + ip)) {
      sock.end(JSON.stringify({ t: 'pair-denied', reason: 'This PC is temporarily blocked. Try again later.' }) + '\n');
      setTimeout(() => sock.destroy(), 500);
      return;
    }
    const total = [...this.preAuth.values()].reduce((a, b) => a + b, 0);
    if ((this.preAuth.get(ip) || 0) >= 4 || total >= 24) return sock.destroy();
    this.preAuth.set(ip, (this.preAuth.get(ip) || 0) + 1);
    let counted = true;
    const uncount = () => { if (!counted) return; counted = false; const n = (this.preAuth.get(ip) || 1) - 1; if (n > 0) this.preAuth.set(ip, n); else this.preAuth.delete(ip); };
    sock.once('close', uncount);
    const conn = new Conn(sock, false);
    conn.once('ready', uncount);
    conn.on('violation', kind => this.audit('warn', 'net', `Dropped a connection from ${ip} before sign-in: ${kind}`));
    const to = setTimeout(() => conn.destroy(), 10000);
    conn.once('close', () => clearTimeout(to));
    conn.once('msg', m => {
      if (m.t !== 'hello' || !V.isId(m.id) || m.id === this.id) return conn.destroy();
      if (m.mode === 'auth') { clearTimeout(to); return this._serverAuth(conn, m); }
      if (m.mode === 'pair') return this._serverPair(conn, m, () => clearTimeout(to));
      conn.destroy();
    });
  }

  _serverAuth(conn, hello) {
    const ip = conn.remoteIp;
    const peer = this.peers[hello.id];
    if (!peer) {
      this.audit('info', 'auth', `A computer at ${ip} tried to reconnect but isn't paired with this PC`);
      conn.sendPlain({ t: 'auth-unknown' }); setTimeout(() => conn.destroy(), 200); return;
    }
    if (typeof hello.epk !== 'string' || hello.epk.length > 200 || !V.isB64(hello.nonce, 64)) return conn.destroy();
    const key = Buffer.from(peer.key, 'base64');
    const kp = C.genKeyPair(), nB = C.nonce();
    const to = setTimeout(() => conn.destroy(), 8000);
    conn.sendPlain({ t: 'auth-chal', id: this.id, epk: kp.pub, nonce: nB, mac: C.hmac(key, 'S', hello.id, this.id, hello.epk, kp.pub, hello.nonce, nB) });
    conn.once('msg', m => {
      clearTimeout(to);
      if (m.t !== 'auth-resp') return conn.destroy();
      const exp = C.hmac(key, 'C', hello.id, this.id, hello.epk, kp.pub, hello.nonce, nB);
      if (!C.safeEqual(exp, m.mac)) { this._authFailed(ip, `claimed to be ${peer.name} but failed the key check`); return conn.destroy(); }
      let k;
      try { k = C.hkdf(C.dh(kp.privateKey, hello.epk), key, `vels-sess|${hello.nonce}|${nB}`, 64); } catch { return conn.destroy(); }
      conn.recvKey = k.subarray(0, 32); conn.sendKey = k.subarray(32, 64);
      conn.send({ t: 'welcome' });
      conn.emit('ready');
      peer.name = V.cleanText(hello.name, 64, peer.name);
      peer.lastHost = ip;
      peer.lastPort = Number.isInteger(hello.port) && hello.port > 0 && hello.port < 65536 ? hello.port : 47821;
      this._savePeers();
      this._adopt(conn, hello.id);
    });
  }

  _adopt(conn, peerId) {
    if (this.stopped) { conn.destroy(); return; }
    const existing = this.conns[peerId];
    if (existing && !existing.closed) {
      // keep the link opened by the PC with the smaller id; drop the other
      const keepNew = conn.initiator === (this.id < peerId);
      if (!keepNew) { conn.destroy(); return; }
      existing.removeAllListeners('close'); existing.destroy();
    }
    conn.peerId = peerId;
    this.conns[peerId] = conn;
    this.remote[peerId] = this.remote[peerId] || {};
    this.remote[peerId].connectedAt = Date.now();
    conn.removeAllListeners('violation');
    conn.on('violation', kind => this.audit('alert', 'net', `Connection with ${this.peers[peerId] ? this.peers[peerId].name : 'a PC'} closed: ${kind}`));
    conn.on('msg', m => { try { this._onMessage(peerId, conn, m); } catch (e) { this.audit('warn', 'net', `Ignored a bad message from ${this.peers[peerId] ? this.peers[peerId].name : 'a PC'}`); } });
    conn.on('close', () => {
      if (this.conns[peerId] === conn) {
        delete this.conns[peerId];
        this._onPeerGone(peerId);
        this._changed();
      }
    });
    this._sendStatsTo(conn);
    conn.send(this._mainInfoMsg());
    if (this.monitor.enabled && peerId === this.monitor.parentId) this._monitorHello(conn);
    this._changed();
    this.emit('peer-connected', peerId);
  }

  _onPeerGone(peerId) {
    const rr = this.remote[peerId];
    if (rr) { rr.monitored = false; rr.activity = null; }
    for (const t of this.tasks.values()) {
      if (t.peerId === peerId && t.direction === 'out' && ['sent', 'queued', 'pending', 'running'].includes(t.state)) { t.state = 'lost'; t.endedAt = Date.now(); }
      // a task still waiting for "Allow?" can't be allowed once its PC is gone (the PC may have been removed)
      if (t.peerId === peerId && t.direction === 'in' && t.state === 'pending') {
        t.state = 'rejected'; t.endedAt = Date.now(); t.error = 'The other PC disconnected before it was allowed';
        this.emit('request-gone', { key: 'task:' + t.id });
      }
    }
    // file offers still waiting for Accept/Decline from (or to) that PC are over
    for (const [batchId, b] of this.pendingBatches) {
      if (b.peerId !== peerId) continue;
      this.pendingBatches.delete(batchId);
      if (b.direction === 'in') this.emit('request-gone', { key: 'files:' + batchId });
    }
    for (const tr of this.transfers.values()) {
      if (tr.peerId === peerId && ['offered', 'sending', 'receiving', 'queued', 'verifying'].includes(tr.state)) {
        tr.state = 'failed'; tr.error = 'Disconnected';
        if (tr.ws) { tr.ws.destroy(); try { fs.unlinkSync(tr.partPath); } catch {} }
      }
    }
  }

  // ---------- pairing: requester types the PIN shown on the receiving PC ----------
  // The PIN is checked one bit at a time with commitments (like Bluetooth "passkey entry"),
  // so someone in the middle of the network gets one blind guess per bit (1 in a million overall)
  // and can't test PINs offline. Each wrong try makes the receiver show a NEW PIN.
  async pair(target) {
    let host, port;
    if (target && V.isId(target.id) && this.nearby[target.id]) ({ host, port } = this.nearby[target.id]);
    else if (target && V.isStr(target.host, 255) && /^[\w.\-:]+$/.test(target.host)) { host = target.host; port = Number.isInteger(+target.port) && +target.port > 0 && +target.port < 65536 ? +target.port : 47821; }
    if (!host) throw new Error('Device not found on the network');
    if (target && V.isId(target.id) && !this.canLink(target.id)) throw new Error(this._linkLimitText());
    const sock = await this._dial(host, port);
    const conn = new Conn(sock, true);
    const kp = C.genKeyPair();
    const sid = C.randomId();
    const sess = { sid, conn, role: 'initiator', host, port, kp, epkA: kp.pub };
    this.pairSessions.set(sid, sess);
    conn.on('close', () => this._pairEnd(sid, false, 'Connection closed'));
    sess.timer = setTimeout(() => this._pairEnd(sid, false, 'Timed out'), 180000);
    conn.on('msg', m => { try { this._initPairMsg(sess, m); } catch { this._pairEnd(sid, false, 'Security check failed'); } });
    conn.sendPlain({ t: 'hello', v: PROTO, mode: 'pair', id: this.id, name: this.settings.name, port: this.tcpPort, epk: kp.pub });
    return sid;
  }

  _initPairMsg(sess, m) {
    const fail = r => this._pairEnd(sess.sid, false, r);
    switch (m.t) {
      case 'pair-busy': return fail('That PC is busy with another request. Try again in a moment.');
      case 'pair-denied': return fail(V.cleanText(m.reason, 120, 'Access was denied on the other PC'));
      case 'pair-cancel': return fail('Cancelled on the other PC');
      case 'pair-key':
        if (sess.epkB || !V.isId(m.id) || m.id === this.id || typeof m.epk !== 'string' || m.epk.length > 200) return;
        sess.peerId = m.id; sess.peerName = V.cleanText(m.name, 64, 'PC');
        if (!this.canLink(m.id)) { sess.conn.sendPlain({ t: 'pair-cancel' }); return fail(this._linkLimitText()); }
        sess.peerPort = Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : sess.port;
        sess.epkB = m.epk;
        sess.shared = C.dh(sess.kp.privateKey, m.epk);
        this.emit('pair-pin-needed', { sid: sess.sid, peerName: sess.peerName, triesLeft: V.num(m.tries, 0, 3, 3) });
        return;
      case 'pair-wrong':
        sess.run = null;
        this.emit('pair-pin-needed', { sid: sess.sid, peerName: sess.peerName, triesLeft: V.num(m.left, 0, 3, 0), error: `Wrong PIN. ${sess.peerName} is now showing a new PIN.` });
        return;
      case 'pk-c': {
        const r = sess.run;
        if (!r || m.i !== r.i || r.cb || !V.isB64(m.c, 64)) return;
        r.cb = m.c;
        sess.conn.sendPlain({ t: 'pk-n', i: r.i, n: r.na });
        return;
      }
      case 'pk-n': {
        const r = sess.run;
        if (!r || m.i !== r.i || !r.cb || !V.isB64(m.n, 64)) return;
        const exp = C.hmac(Buffer.from(m.n, 'base64'), 'pk', sess.epkB, sess.epkA, r.i, (sess.pin >> r.i) & 1);
        if (!C.safeEqual(exp, r.cb)) return fail('Security check failed — someone may be interfering with the network');
        r.log.push(r.na, m.n);
        r.i++;
        if (r.i < PIN_BITS) return this._initRound(sess);
        sess.th = C.sha256('vels-pair-pin', this.id, sess.peerId, sess.epkA, sess.epkB, ...r.log);
        sess.ck = C.hkdf(sess.shared, sess.th, 'vels-confirm');
        sess.conn.sendPlain({ t: 'pair-fin', mac: C.hmac(sess.ck, 'initiator') });
        return;
      }
      case 'pair-fin':
        if (!sess.ck) return;
        if (!C.safeEqual(C.hmac(sess.ck, 'responder'), m.mac)) return fail('Security check failed');
        return this._pairSuccess(sess);
    }
  }

  pairPin(sid, pin) {
    const sess = this.pairSessions.get(sid);
    if (!sess || sess.role !== 'initiator' || !sess.epkB) throw new Error('This request has ended');
    if (sess.run) return;
    const p = String(pin || '').replace(/\D/g, '');
    if (p.length !== 6) throw new Error('The PIN has 6 digits');
    sess.pin = parseInt(p, 10);
    sess.run = { i: 0, log: [] };
    this._initRound(sess);
  }

  _initRound(sess) {
    const r = sess.run;
    r.na = C.nonce(16); r.cb = null;
    const c = C.hmac(Buffer.from(r.na, 'base64'), 'pk', sess.epkA, sess.epkB, r.i, (sess.pin >> r.i) & 1);
    sess.conn.sendPlain({ t: 'pk-c', i: r.i, c });
  }

  _serverPair(conn, hello, clearIdle) {
    const ip = conn.remoteIp;
    const name = V.cleanText(hello.name, 64, 'PC');
    const deny = reason => { conn.sendPlain({ t: 'pair-denied', reason }); setTimeout(() => conn.destroy(), 200); };
    if (this._blocked('ip:' + ip, 'id:' + hello.id)) return deny('Too many attempts. Try again in a few minutes.');
    const now = Date.now();
    this.pairRecent = this.pairRecent.filter(t => now - t < 60000);
    if (this.pairRecent.length >= 6) { this.audit('warn', 'pair', `Ignored an access request from ${ip}: too many requests in the last minute`); return deny('Too many requests right now. Try again in a minute.'); }
    this.pairRecent.push(now);
    if (this.settings.allowPairing === false) { this.audit('info', 'pair', `Refused an access request from ${name} (${ip}) — new requests are turned off`); return deny(`${this.settings.name} isn't accepting new connection requests right now.`); }
    if ([...this.pairSessions.values()].some(s => s.role === 'responder')) { conn.sendPlain({ t: 'pair-busy' }); setTimeout(() => conn.destroy(), 200); return; }
    if (!this.canLink(hello.id)) {
      const lim = this.limits();
      this.audit('warn', 'plan', `Refused an access request from ${name} (${ip}): the ${lim.name} plan links up to ${lim.pcs} PCs`);
      this._toast('warn', `${name} asked to connect, but the ${lim.name} plan links up to ${lim.pcs} PCs. Upgrade or unpair a PC to add it.`);
      return deny(`${this.settings.name} is on the ${lim.name} plan and already linked to ${lim.pcs} PCs.`);
    }
    if (typeof hello.epk !== 'string' || hello.epk.length > 200) return conn.destroy();
    const kp = C.genKeyPair();
    let shared;
    try { shared = C.dh(kp.privateKey, hello.epk); } catch { return conn.destroy(); }
    const sid = C.randomId();
    const sess = {
      sid, conn, role: 'responder', ip, peerId: hello.id, peerName: name,
      peerPort: Number.isInteger(hello.port) && hello.port > 0 && hello.port < 65536 ? hello.port : 47821,
      epkA: hello.epk, epkB: kp.pub, shared, pin: crypto.randomInt(0, 1000000), tries: 3, ri: 0, log: [], host: ip,
    };
    this.pairSessions.set(sid, sess);
    clearIdle();
    this.audit('info', 'pair', `${name} (${ip}) requested access`);
    sess.timer = setTimeout(() => this._pairEnd(sid, false, 'Timed out'), 180000);
    conn.on('close', () => this._pairEnd(sid, false, 'Connection closed'));
    conn.on('msg', m => { try { this._respPairMsg(sess, m); } catch { this._pairEnd(sid, false, 'Security check failed'); } });
    conn.sendPlain({ t: 'pair-key', id: this.id, name: this.settings.name, port: this.tcpPort, epk: kp.pub, tries: sess.tries });
    this._emitPairRequest(sess);
  }

  _emitPairRequest(sess, wrong) {
    this.emit('pair-request', { sid: sess.sid, peerName: sess.peerName, host: sess.ip, pin: String(sess.pin).padStart(6, '0'), triesLeft: sess.tries, wrong: !!wrong });
  }

  _respPairMsg(sess, m) {
    switch (m.t) {
      case 'pair-cancel': return this._pairEnd(sess.sid, false, 'Cancelled on the other PC');
      case 'pk-c':
        if (m.i !== sess.ri || sess.ca || !V.isB64(m.c, 64) || sess.ri >= PIN_BITS) return;
        sess.ca = m.c;
        sess.nb = C.nonce(16);
        sess.conn.sendPlain({ t: 'pk-c', i: sess.ri, c: C.hmac(Buffer.from(sess.nb, 'base64'), 'pk', sess.epkB, sess.epkA, sess.ri, (sess.pin >> sess.ri) & 1) });
        return;
      case 'pk-n': {
        if (m.i !== sess.ri || !sess.ca || !V.isB64(m.n, 64)) return;
        const exp = C.hmac(Buffer.from(m.n, 'base64'), 'pk', sess.epkA, sess.epkB, sess.ri, (sess.pin >> sess.ri) & 1);
        if (!C.safeEqual(exp, sess.ca)) {
          sess.tries--;
          this.audit('warn', 'pair', `Wrong PIN entered by ${sess.peerName} (${sess.ip})`);
          if (sess.tries <= 0) {
            this._block(5 * 60000, '3 wrong PINs', `${sess.peerName} (${sess.ip})`, 'ip:' + sess.ip, 'id:' + sess.peerId);
            this.audit('alert', 'block', `Blocked ${sess.peerName} (${sess.ip}) for 5 minutes after 3 wrong PINs`);
            sess.conn.sendPlain({ t: 'pair-denied', reason: 'Too many wrong PINs. Try again in 5 minutes.' });
            return this._pairEnd(sess.sid, false, `Blocked ${sess.peerName} for 5 minutes after 3 wrong PINs`);
          }
          // never reuse a PIN that was partly revealed by a failed try
          sess.pin = crypto.randomInt(0, 1000000);
          sess.ri = 0; sess.ca = null; sess.log = [];
          sess.conn.sendPlain({ t: 'pair-wrong', left: sess.tries });
          this._emitPairRequest(sess, true);
          return;
        }
        sess.log.push(m.n, sess.nb);
        sess.conn.sendPlain({ t: 'pk-n', i: sess.ri, n: sess.nb });
        sess.ri++; sess.ca = null;
        return;
      }
      case 'pair-fin': {
        if (sess.ri !== PIN_BITS) return;
        sess.th = C.sha256('vels-pair-pin', sess.peerId, this.id, sess.epkA, sess.epkB, ...sess.log);
        sess.ck = C.hkdf(sess.shared, sess.th, 'vels-confirm');
        if (!C.safeEqual(C.hmac(sess.ck, 'initiator'), m.mac)) return this._pairEnd(sess.sid, false, 'Security check failed');
        sess.conn.sendPlain({ t: 'pair-fin', mac: C.hmac(sess.ck, 'responder') });
        return this._pairSuccess(sess);
      }
    }
  }

  pairCancel(sid) {
    const sess = this.pairSessions.get(sid);
    if (!sess) return;
    if (sess.role === 'responder') {
      this._block(2 * 60000, 'Request denied', `${sess.peerName} (${sess.ip})`, 'ip:' + sess.ip, 'id:' + sess.peerId);
      this.audit('info', 'pair', `Denied the access request from ${sess.peerName} (${sess.ip})`);
      sess.conn.sendPlain({ t: 'pair-denied', reason: `${this.settings.name} denied the request.` });
      return this._pairEnd(sid, false, 'Denied');
    }
    sess.conn.sendPlain({ t: 'pair-cancel' });
    this._pairEnd(sid, false, 'Cancelled');
  }

  _pairSuccess(sess) {
    if (sess.done) return;
    const longKey = C.hkdf(sess.shared, sess.th, 'vels-long').toString('base64');
    this.peers[sess.peerId] = { name: sess.peerName, key: longKey, perms: V.cleanPerms(null), lastHost: sess.host, lastPort: sess.peerPort, pairedAt: Date.now() };
    this._savePeers();
    this.audit('info', 'pair', sess.role === 'responder' ? `Gave access to ${sess.peerName} (${sess.ip})` : `Connected to ${sess.peerName} (${sess.host})`);
    if (sess.role === 'initiator' && !this.mainId) this.pendingChooseMain = sess.peerId;
    this._pairEnd(sess.sid, true);
    delete this.retryAt[sess.peerId];
    setTimeout(() => this._tickConnect(), sess.role === 'initiator' ? 300 : 1500);
  }

  _pairEnd(sid, ok, reason) {
    const sess = this.pairSessions.get(sid);
    if (!sess || sess.done) return;
    sess.done = true;
    clearTimeout(sess.timer);
    this.pairSessions.delete(sid);
    setTimeout(() => sess.conn.destroy(), ok ? 300 : 150);
    this.emit('pair-done', { sid, ok, reason: reason || '', peerName: sess.peerName || '', role: sess.role });
    if (ok) this._toast('ok', `Connected with ${sess.peerName}`);
  }

  // ---------- access control ----------
  async unpair(peerId, pin) {
    const p = this.peers[peerId];
    if (!p) return;
    this._requireAdmin();
    if (peerId === this.main.mainId && !this.isMain) {
      await this.verifyMainPasscode(pin);
      this._disableMonitor(`Activity sharing turned off because ${p.name} was removed`);
      this.main.mainId = ''; this.main.fallback = null; this._saveSettings();
    }
    const c = this.conns[peerId];
    if (c) { c.send({ t: 'unpaired' }); setTimeout(() => c.destroy(), 150); }
    delete this.peers[peerId];
    delete this.remote[peerId];
    this._savePeers();
    this.audit('info', 'pair', `Removed access for ${p.name}`);
  }
  setPerm(peerId, kind, value) {
    this._requireAdmin();
    const p = this.peers[peerId];
    if (!p) throw new Error('Unknown computer');
    const next = V.cleanPerms(Object.assign({}, p.perms, { [kind]: value }));
    if (next[kind] !== value) throw new Error('Invalid permission');
    p.perms = next;
    this._savePeers();
    this.audit('info', 'perm', `${p.name}: ${kind === 'tasks' ? 'run tasks' : kind === 'files' ? 'send files' : 'change status'} set to "${value}"`);
  }

  // ---------- stats / status ----------
  effectiveStatus() { return this.running.size > 0 ? 'Working' : this.manualStatus; }
  _activeTaskTitle() {
    for (const id of this.running.keys()) { const t = this.tasks.get(id); if (t) return t.title || t.cmd.slice(0, 60); }
    return '';
  }
  _statusMsg() {
    return { t: 'stats', stats: this.stats, status: this.effectiveStatus(), role: this.role, name: this.settings.name, activeTask: this._activeTaskTitle(), queued: this.queue.length, plan: this.tier() };
  }
  _sendStatsTo(conn) { conn.send(this._statusMsg()); }
  _tickStats() {
    this.stats = Stats.snapshot();
    const msg = this._statusMsg();
    for (const c of Object.values(this.conns)) c.send(msg);
    this._changed();
  }
  _tickPing() { for (const c of Object.values(this.conns)) c.send({ t: 'ping', ts: Date.now() }); }

  setStatus(target, status, role) {
    if (status != null && !STATUSES.includes(status)) throw new Error('Unknown status');
    if (role != null && typeof role !== 'string') throw new Error('Invalid role');
    if (!target || target === this.id) {
      if (status) this.manualStatus = status;
      if (role != null) { this.role = V.cleanText(role, 40); this._saveSettings(); }
      this._tickStats();
      return;
    }
    const c = this.conns[target];
    if (!c) throw new Error('That PC is offline');
    c.send({ t: 'set-status', status: status || null, role: role == null ? null : V.cleanText(role, 40) });
  }

  // ---------- messages from paired PCs (all validated) ----------
  _onMessage(peerId, conn, m) {
    const peer = this.peers[peerId];
    if (!peer) return conn.destroy();
    const r = this.remote[peerId] || (this.remote[peerId] = {});
    switch (m.t) {
      case 'stats':
        r.stats = V.cleanStats(m.stats);
        r.status = STATUSES.includes(m.status) ? m.status : 'Idle';
        r.role = V.cleanText(m.role, 40);
        r.activeTask = V.cleanText(m.activeTask, 80);
        r.queued = V.num(m.queued, 0, 1e6);
        r.plan = Plans.norm(m.plan);
        if (peerId === this.main.mainId && !this.isMain && r.plan !== this.mainPlan) { this.mainPlan = r.plan; this._saveSettings(); setImmediate(() => this._tickStats()); }
        { const nm = V.cleanText(m.name, 64, peer.name); if (nm !== peer.name) { peer.name = nm; this._savePeers(); } }
        this._changed(); break;
      case 'ping': if (typeof m.ts === 'number') conn.send({ t: 'pong', ts: m.ts }); break;
      case 'pong': if (typeof m.ts === 'number') { r.latency = Math.max(0, Math.min(99999, Date.now() - m.ts)); this._changed(); } break;
      case 'unpaired':
        if (this.monitor.enabled && peerId === this.monitor.parentId) this._disableMonitor(`Activity sharing ended: ${peer.name} removed this PC`);
        if (peerId === this.main.mainId && !this.isMain) { this.main.mainId = ''; this.main.fallback = null; this._saveSettings(); }
        this.audit('info', 'pair', `${peer.name} removed this PC from its paired list`);
        delete this.peers[peerId]; delete this.remote[peerId]; this._savePeers();
        conn.destroy();
        break;
      case 'set-status': {
        if (peer.perms.status !== 'allow') { this.audit('warn', 'perm', `${peer.name} tried to change this PC's status (not allowed)`); break; }
        if (STATUSES.includes(m.status)) this.manualStatus = m.status;
        if (typeof m.role === 'string') { this.role = V.cleanText(m.role, 40); this._saveSettings(); }
        this._toast('info', `${peer.name} set this PC to ${this.effectiveStatus()}${this.role ? ' · ' + this.role : ''}`);
        this._tickStats(); break;
      }
      // ----- main PC -----
      case 'main-info':
        r.mainInfo = { isMain: m.isMain === true, hasMain: m.hasMain === true, plan: Plans.norm(m.plan), kids: V.num(m.kids, 0, 1e6), kidLimit: V.num(m.kidLimit, 0, 1e6) };
        if (m.isMain === true) this._adoptMain(peerId);
        if (this.pendingChooseMain === peerId) {
          this.pendingChooseMain = null;
          if (!this.mainId && !r.mainInfo.hasMain && !r.mainInfo.isMain) this.emit('choose-main', { peerId, peerName: peer.name });
        }
        this._changed(); break;
      case 'main-claim':
        if (!this._adoptMain(peerId)) this.audit('warn', 'main', `${peer.name} claimed to be the main PC, but this PC already has one`);
        break;
      case 'main-release':
        if (peerId === this.main.mainId && !this.isMain) {
          this._disableMonitor(`${peer.name} is no longer the main PC`);
          this.main.mainId = ''; this.main.fallback = null; this._saveSettings();
          this.audit('info', 'main', `${peer.name} is no longer the main PC`);
        }
        break;
      case 'main-set': {
        // the PC that just connected to us chose THIS PC as the main one (only allowed right after first connecting)
        if (typeof m.reqId !== 'string' || !V.isId(m.reqId)) break;
        const fresh = Date.now() - (peer.pairedAt || 0) < 15 * 60000 && Object.keys(this.peers).length === 1 && !this.mainId;
        let error = '';
        if (!fresh) error = 'That PC cannot be made the main PC from here — set it on that PC in Settings';
        else { try { this._validPasscode(m.pin); this.main = { isMain: true, mainId: this.id, lock: this._makeVerifier(m.pin), fallback: null }; this._saveSettings(); this.audit('info', 'main', `This PC was made the main PC by ${peer.name} during setup`); this._toast('info', `This PC is now the main (parent) PC. Its passcode was set on ${peer.name}.`); } catch (e) { error = e.message; } }
        conn.send({ t: 'main-set-res', reqId: m.reqId, ok: !error, error });
        if (!error) for (const c of Object.values(this.conns)) c.send({ t: 'main-claim' });
        break;
      }
      case 'pin-check': {
        if (typeof m.reqId !== 'string' || !V.isId(m.reqId)) break;
        let ok = false, error = '';
        if (!this.isMain) error = 'This PC is not the main PC';
        else { try { ok = this._verifyAsMain(m.pin, peerId); } catch (e) { error = e.message; } }
        conn.send({ t: 'pin-res', reqId: m.reqId, ok, error });
        if (ok && r.monitored) this._pushVerifier(conn);
        if (!ok && /Too many/.test(error)) this.audit('alert', 'main', `Too many wrong passcodes were entered on ${peer.name}`);
        break;
      }
      case 'pin-res': case 'main-set-res': {
        const pend = typeof m.reqId === 'string' && this.pendingPin.get(m.reqId);
        if (!pend || pend.peerId !== peerId) break;
        this.pendingPin.delete(m.reqId); clearTimeout(pend.timer);
        if (m.ok === true) pend.resolve(true); else pend.reject(new Error(V.cleanText(m.error, 140, 'Wrong passcode')));
        break;
      }
      case 'main-verifier':
        if (peerId !== this.main.mainId || this.isMain) break;
        this.main.fallback = m.v && V.isB64(m.v.salt, 64) && V.isB64(m.v.hash, 64) ? { salt: m.v.salt, hash: m.v.hash, digits: 6 } : null;
        this._saveSettings(); break;
      // ----- parental monitoring: child side -----
      case 'activity-req': {
        if (typeof m.reqId !== 'string' || !V.isId(m.reqId)) break;
        if (!this.monitor.enabled || peerId !== this.monitor.parentId) {
          this.audit('warn', 'monitor', `${peer.name} asked for this PC's activity history (not allowed)`);
          conn.send({ t: 'activity-res', reqId: m.reqId, error: 'This PC does not share its activity with you' });
          break;
        }
        const h = this.activity.history(V.num(m.daysAgo, 0, 400));
        conn.send({ t: 'activity-res', reqId: m.reqId, day: h.day, entries: h.entries, storage: this.activity.storage() });
        break;
      }
      case 'activity-wipe': {
        // the main PC (unlocked with its passcode) asked to delete the history saved on this PC
        if (typeof m.reqId !== 'string' || !V.isId(m.reqId)) break;
        if (!this.monitor.enabled || peerId !== this.monitor.parentId) {
          this.audit('warn', 'monitor', `${peer.name} tried to delete this PC's activity history (not allowed)`);
          conn.send({ t: 'activity-res', reqId: m.reqId, error: 'This PC does not share its activity with you' });
          break;
        }
        this.activity.wipe(); this._hsCache = null;
        this.audit('info', 'monitor', `${peer.name} (the main PC) deleted the activity history saved on this PC`);
        this._toast('info', `${peer.name} deleted the activity history saved on this PC.`);
        conn.send({ t: 'activity-res', reqId: m.reqId, day: '', entries: [], storage: this.activity.storage() });
        this._changed();
        break;
      }
      // ----- parental monitoring: parent side -----
      case 'monitor-hello':
        if (this.isMain && !peer.child && this.kidCount() >= this.limits().kids) {
          const lim = this.limits();
          conn.send({ t: 'monitor-refused', reason: `${this.settings.name} is on the ${lim.name} plan, which allows ${lim.kids} kid PCs. Upgrade the main PC to add more.` });
          this.audit('warn', 'plan', `${peer.name} wanted to share its activity, but the ${lim.name} plan limit of ${lim.kids} kid PCs is reached`);
          this._toast('warn', `Kid PC limit reached (${lim.kids} on ${lim.name}). Upgrade to add ${peer.name}.`);
          break;
        }
        if (this.isMain && !r.monitored) this._pushVerifier(conn);
        r.monitored = true; r.monitorUrls = m.urls === true; r.monitorKeepDays = V.num(m.keepDays, 1, 365, 30);
        if (!peer.child) { peer.child = true; this._savePeers(); this.audit('info', 'monitor', `${peer.name} now shares its activity with this PC`); this._broadcastMainInfo(); }
        this._changed(); break;
      case 'monitor-off':
        r.monitored = false; r.activity = null;
        if (peer.child) { peer.child = false; this._savePeers(); this._broadcastMainInfo(); }
        this.audit('warn', 'monitor', `${peer.name} stopped sharing its activity${m.reason ? ': ' + V.cleanText(m.reason, 120) : ''}`);
        this._changed(); break;
      case 'monitor-refused':
        if (peerId === this.monitor.parentId && this.monitor.enabled) {
          const why = V.cleanText(m.reason, 200, 'The main PC has no room for more kid PCs');
          this._disableMonitor('Activity sharing was not accepted: ' + why);
          this._toast('warn', why);
        }
        break;
      case 'activity':
        if (!peer.child && !r.monitored) break;
        r.monitored = true;
        r.activity = this._cleanActivity(m.a);
        this._changed(); break;
      case 'activity-res': {
        const pend = typeof m.reqId === 'string' && this.pendingHistory.get(m.reqId);
        if (!pend || pend.peerId !== peerId) break;
        this.pendingHistory.delete(m.reqId); clearTimeout(pend.timer);
        if (m.error) { pend.reject(new Error(V.cleanText(m.error, 120))); break; }
        const entries = Array.isArray(m.entries) ? m.entries.slice(0, 5000).map(e => this._cleanEntry(e)).filter(Boolean) : [];
        const st = m.storage && typeof m.storage === 'object' ? m.storage : {};
        pend.resolve({ day: V.cleanText(m.day, 12), entries, storage: { bytes: V.num(st.bytes, 0, 1e13), days: V.num(st.days, 0, 1e5), oldest: /^\d{4}-\d{2}-\d{2}$/.test(st.oldest) ? st.oldest : '', keepDays: V.num(st.keepDays, 0, 400) } });
        break;
      }
      case 'task-run': this._incomingTask(peerId, m); break;
      case 'task-cancel': {
        if (!V.isId(m.taskId)) break;
        const t = this.tasks.get(m.taskId);
        if (t && t.direction === 'in' && t.peerId === peerId) this.cancelTask(t.id);
        break;
      }
      case 'task-state': {
        if (!V.isId(m.taskId) || !TASK_STATES.includes(m.state)) break;
        const t = this.tasks.get(m.taskId);
        if (t && t.direction === 'out' && t.peerId === peerId) {
          t.state = m.state;
          if (typeof m.code === 'number' || m.code === null) t.code = m.code;
          if (m.state === 'running') t.startedAt = Date.now();
          if (['done', 'failed', 'cancelled', 'rejected'].includes(m.state)) t.endedAt = Date.now();
          if (m.error) t.error = V.cleanText(m.error, 200);
          this._changed();
        }
        break;
      }
      case 'task-out': {
        if (!V.isId(m.taskId) || !V.isStr(m.data, 300000)) break;
        const t = this.tasks.get(m.taskId);
        if (t && t.direction === 'out' && t.peerId === peerId) this._appendOut(t, m.data);
        break;
      }
      case 'file-offer': this._incomingOffer(peerId, m); break;
      case 'file-answer': this._offerAnswered(peerId, m); break;
      case 'file-chunk': this._recvChunk(peerId, conn, m); break;
      case 'file-end': this._recvEnd(peerId, m); break;
      case 'file-cancel': this._recvCancel(peerId, m); break;
      case 'file-done': {
        if (!V.isId(m.fileId)) break;
        const tr = this.transfers.get(m.fileId);
        if (tr && tr.direction === 'out' && tr.peerId === peerId) { tr.state = m.ok === true ? 'done' : 'failed'; tr.error = m.ok === true ? '' : V.cleanText(m.error, 200, 'Failed'); this._changed(); }
        break;
      }
    }
  }

  // ---------- tasks ----------
  _platformOf(peerId) {
    if (!peerId || peerId === this.id) return process.platform;
    const r = this.remote[peerId];
    return r && r.stats ? r.stats.platform : null;
  }

  runTask({ target, cmd, shell, title } = {}) {
    if (!V.isStr(cmd, 20000) || !cmd.trim()) throw new Error('Type a command first');
    cmd = cmd.trim();
    const local = !target || target === this.id;
    if (!local && !V.isId(target)) throw new Error('Unknown computer');
    const plat = this._platformOf(local ? null : target);
    const allowed = V.shellsFor(plat || 'win32');
    if (!allowed.includes(shell)) shell = allowed[0];
    const id = C.randomId();
    const t = { id, direction: local ? 'local' : 'out', peerId: local ? this.id : target, cmd, shell, title: V.cleanText(title, 80), state: 'queued', output: '', createdAt: Date.now() };
    if (local) { this.tasks.set(id, t); this.queue.push(id); this._pump(); }
    else {
      const c = this.conns[target];
      if (!c) throw new Error('That PC is offline');
      this.tasks.set(id, t);
      t.state = 'sent';
      c.send({ t: 'task-run', taskId: id, cmd, shell, title: t.title });
    }
    this._changed();
    return id;
  }

  _incomingTask(peerId, m) {
    const peer = this.peers[peerId];
    const c = this.conns[peerId];
    if (!V.isId(m.taskId) || this.tasks.has(m.taskId)) return;
    const reject = error => {
      c && c.send({ t: 'task-state', taskId: m.taskId, state: 'rejected', error });
    };
    if (!V.isStr(m.cmd, 20000) || !m.cmd.trim()) return reject('Invalid command');
    const shells = V.shellsFor(process.platform);
    if (!shells.includes(m.shell)) return reject(`This PC runs ${IS_WIN ? 'Windows' : 'Linux'} — use ${shells.map(s => s === 'cmd' ? 'Command Prompt' : s === 'powershell' ? 'PowerShell' : s === 'bash' ? 'Bash' : s).join(' or ')}`);
    const t = { id: m.taskId, direction: 'in', peerId, cmd: m.cmd, shell: m.shell, title: V.cleanText(m.title, 80), state: 'pending', output: '', createdAt: Date.now() };
    this.tasks.set(t.id, t);
    const short = t.cmd.length > 160 ? t.cmd.slice(0, 160) + '…' : t.cmd;
    if (this.settings.taskPolicy === 'deny' || peer.perms.tasks === 'never') {
      t.state = 'rejected'; t.endedAt = Date.now(); t.error = 'This PC does not accept tasks from you';
      this.audit('warn', 'task', `Blocked a task from ${peer.name}: ${short}`);
      reject(t.error);
    } else if (peer.perms.tasks === 'allow') {
      this.audit('info', 'task', `Ran a task from ${peer.name} (allowed without asking): ${short}`);
      this._acceptTask(t);
    } else {
      c && c.send({ t: 'task-state', taskId: t.id, state: 'pending' });
      this.emit('task-approval', { taskId: t.id, peerName: peer.name, cmd: t.cmd, shell: t.shell, title: t.title });
    }
    this._changed();
  }

  approveTask(taskId, decision) {
    if (!V.isId(taskId) || !['allow', 'deny', 'always'].includes(decision)) return;
    const t = this.tasks.get(taskId);
    if (!t || t.direction !== 'in' || t.state !== 'pending') return;
    const c = this.conns[t.peerId];
    const peer = this.peers[t.peerId];
    // never run a command from a PC that is no longer paired or connected
    if (decision !== 'deny' && (!peer || !c)) {
      t.state = 'rejected'; t.endedAt = Date.now(); t.error = 'The other PC disconnected before it was allowed';
      this._toast('warn', 'That task wasn\'t run: the other PC is no longer connected.');
      this._changed(); return;
    }
    const short = t.cmd.length > 160 ? t.cmd.slice(0, 160) + '…' : t.cmd;
    if (decision === 'deny') {
      t.state = 'rejected'; t.endedAt = Date.now();
      this.audit('info', 'task', `Declined a task from ${peer ? peer.name : 'a PC'}: ${short}`);
      c && c.send({ t: 'task-state', taskId, state: 'rejected', error: 'Declined on the other PC' });
      this._changed(); return;
    }
    if (decision === 'always' && peer) this.setPerm(t.peerId, 'tasks', 'allow');
    this.audit('info', 'task', `Allowed a task from ${peer ? peer.name : 'a PC'}: ${short}`);
    this._acceptTask(t);
  }

  _acceptTask(t) {
    t.state = 'queued';
    this.queue.push(t.id);
    const c = this.conns[t.peerId];
    c && c.send({ t: 'task-state', taskId: t.id, state: 'queued' });
    this._pump();
  }

  _pump() {
    const max = Math.max(1, Math.min(8, +this.settings.maxParallel || 2));
    while (this.running.size < max && this.queue.length) {
      const id = this.queue.shift();
      const t = this.tasks.get(id);
      if (!t || t.state !== 'queued') continue;
      this._exec(t);
    }
    this._changed();
  }

  _spawn(t) {
    const opts = { windowsHide: true, cwd: os.homedir(), env: process.env };
    if (IS_WIN) {
      if (t.shell === 'cmd') return spawn('cmd.exe', ['/d', '/s', '/c', t.cmd], Object.assign({ windowsVerbatimArguments: true }, opts));
      if (t.shell === 'powershell') return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; ' + t.cmd], opts);
    } else {
      const o = Object.assign({ detached: true }, opts);
      if (t.shell === 'bash' && hasBash()) return spawn('bash', ['-lc', t.cmd], o);
      if (t.shell === 'bash' || t.shell === 'sh') return spawn('/bin/sh', ['-c', t.cmd], o);
    }
    throw new Error('That shell is not available on this PC');
  }

  _exec(t) {
    let child;
    try { child = this._spawn(t); } catch (e) { return this._taskFinish(t, 'failed', null, e.message); }
    this.running.set(t.id, child);
    t.state = 'running'; t.startedAt = Date.now();
    this._notifyOrigin(t, { state: 'running' });
    const onData = d => this._appendOut(t, d.toString('utf8'), true);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { this._appendOut(t, `\n[error] ${e.message}\n`, true); });
    child.on('close', code => {
      this.running.delete(t.id);
      this._taskFinish(t, t.cancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed'), code);
      this._pump();
      this._tickStats();
    });
    this._tickStats();
  }

  _taskFinish(t, state, code, error) {
    t.state = state; t.code = code; t.endedAt = Date.now(); if (error) t.error = error;
    this._notifyOrigin(t, { state, code, error });
    this._changed();
    this.emit('task-finished', { taskId: t.id, state, title: t.title || t.cmd.slice(0, 60) });
  }

  _notifyOrigin(t, extra) {
    if (t.direction !== 'in') return;
    const c = this.conns[t.peerId];
    c && c.send(Object.assign({ t: 'task-state', taskId: t.id }, extra));
  }

  _appendOut(t, data, forward) {
    t.output += data;
    if (t.output.length > 300000) t.output = '…(earlier output trimmed)…\n' + t.output.slice(-250000);
    this.emit('task-out', { taskId: t.id, data });
    if (forward && t.direction === 'in') {
      const c = this.conns[t.peerId];
      for (let i = 0; c && i < data.length; i += 200000) c.send({ t: 'task-out', taskId: t.id, data: data.slice(i, i + 200000) });
    }
  }

  _kill(child) {
    try {
      if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else process.kill(-child.pid, 'SIGTERM');
    } catch { try { child.kill(); } catch {} }
  }

  cancelTask(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.direction === 'out') { const c = this.conns[t.peerId]; c && c.send({ t: 'task-cancel', taskId }); return; }
    if (t.state === 'queued' || t.state === 'pending') {
      this.queue = this.queue.filter(x => x !== taskId);
      return this._taskFinish(t, 'cancelled', null);
    }
    const child = this.running.get(taskId);
    if (child) { t.cancelled = true; this._kill(child); }
  }

  getTaskOutput(taskId) { const t = this.tasks.get(taskId); return t ? t.output : ''; }
  clearFinishedTasks() {
    for (const [id, t] of this.tasks) if (['done', 'failed', 'cancelled', 'rejected', 'lost'].includes(t.state)) this.tasks.delete(id);
    this._changed();
  }

  // ---------- files ----------
  async sendFiles(target, paths) {
    if (!V.isId(target)) throw new Error('Unknown computer');
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Nothing to send');
    const c = this.conns[target];
    if (!c) throw new Error('That PC is offline');
    const files = [];
    const walk = async (abs, rel, depth) => {
      if (depth > 32 || files.length > 5000) return;
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) return; // never follow links out of the chosen folder
      if (st.isDirectory()) { for (const e of await fsp.readdir(abs)) await walk(path.join(abs, e), path.join(rel, e), depth + 1); }
      else if (st.isFile()) files.push({ abs, rel, size: st.size });
    };
    for (const p of paths) await walk(p, path.basename(p), 0);
    if (!files.length) throw new Error('Nothing to send');
    if (files.length > 5000) throw new Error('Too many files in one go (max 5000)');
    const lim = this._fileLimitWith(target);
    const big = files.find(f => f.size > lim.bytes);
    if (big) throw new Error(`"${path.basename(big.abs)}" is ${(big.size / 1024 ** 3).toFixed(1)} GB. The ${lim.name} plan sends files up to ${(lim.bytes / 1024 ** 3).toFixed(0)} GB each${this._upsell(lim.tier, 'maxFileBytes')}.`);
    const batchId = C.randomId();
    const list = files.map(f => {
      const fileId = C.randomId();
      const name = f.rel.split(path.sep).join('/');
      this.transfers.set(fileId, { id: fileId, batchId, direction: 'out', peerId: target, peerName: this.peers[target] ? this.peers[target].name : '', name, abs: f.abs, size: f.size, bytes: 0, state: 'offered', createdAt: Date.now() });
      return { fileId, name, size: f.size };
    });
    this.pendingBatches.set(batchId, { direction: 'out', peerId: target, fileIds: list.map(f => f.fileId) });
    c.send({ t: 'file-offer', batchId, files: list });
    this._changed();
    return batchId;
  }

  _incomingOffer(peerId, m) {
    if (!V.isId(m.batchId) || !Array.isArray(m.files) || !m.files.length || m.files.length > 5000 || this.pendingBatches.has(m.batchId)) return;
    const peer = this.peers[peerId];
    const ids = [];
    for (const f of m.files) {
      if (!f || !V.isId(f.fileId) || this.transfers.has(f.fileId) || !V.isStr(f.name, 2048) || !Number.isSafeInteger(f.size) || f.size < 0) continue;
      this.transfers.set(f.fileId, { id: f.fileId, batchId: m.batchId, direction: 'in', peerId, peerName: peer.name, name: V.safeRel(f.name).split(path.sep).join('/'), size: f.size, bytes: 0, state: 'offered', createdAt: Date.now() });
      ids.push(f.fileId);
    }
    if (!ids.length) return;
    this.pendingBatches.set(m.batchId, { direction: 'in', peerId, fileIds: ids });
    const total = ids.reduce((a, id) => a + this.transfers.get(id).size, 0);
    this._changed();
    const lim = this._fileLimitWith(peerId);
    if (ids.some(id => this.transfers.get(id).size > lim.bytes)) {
      this.audit('info', 'plan', `Declined files from ${peer.name}: larger than the ${lim.name} plan limit`);
      const up = Plans.next(lim.tier);
      return this.answerFiles(m.batchId, false, `Files over ${(lim.bytes / 1024 ** 3).toFixed(0)} GB need ${up ? Plans.plan(up).name : 'a bigger plan'}`);
    }
    if (peer.perms.files === 'never') {
      this.audit('warn', 'file', `Blocked ${ids.length} file(s) from ${peer.name}`);
      return this.answerFiles(m.batchId, false, 'This PC does not accept files from you');
    }
    if (peer.perms.files === 'allow' || this.settings.filePolicy === 'auto') {
      this.audit('info', 'file', `Accepted ${ids.length} file(s) from ${peer.name} without asking (${total} bytes)`);
      return this.answerFiles(m.batchId, true);
    }
    this.emit('file-offer', { batchId: m.batchId, peerName: peer.name, count: ids.length, total, names: ids.slice(0, 6).map(id => this.transfers.get(id).name) });
  }

  _freeSpace(dir) {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  }

  answerFiles(batchId, accept, reason) {
    const b = this.pendingBatches.get(batchId);
    if (!b || b.direction !== 'in') return;
    const c = this.conns[b.peerId];
    if (accept && (!c || !this.peers[b.peerId])) { this.pendingBatches.delete(batchId); this._toast('warn', 'Those files can\'t be received: the other PC is no longer connected.'); return; }
    if (accept) {
      try { fs.mkdirSync(this.settings.receiveDir, { recursive: true }); } catch {}
      const total = b.fileIds.reduce((a, id) => a + (this.transfers.get(id) || { size: 0 }).size, 0);
      if (total + 200 * 1024 * 1024 > this._freeSpace(this.settings.receiveDir)) {
        accept = false; reason = 'Not enough free disk space on the other PC';
        this._toast('warn', 'Declined incoming files: not enough free disk space');
      }
    }
    this.pendingBatches.delete(batchId);
    for (const id of b.fileIds) {
      const tr = this.transfers.get(id);
      if (!tr || tr.state !== 'offered') continue;
      tr.state = accept ? 'queued' : 'declined';
      if (accept) tr.root = this.settings.receiveDir; else if (reason) tr.error = reason;
    }
    c && c.send({ t: 'file-answer', batchId, accept: !!accept, reason: reason || '' });
    this._changed();
  }

  async _offerAnswered(peerId, m) {
    if (!V.isId(m.batchId)) return;
    const b = this.pendingBatches.get(m.batchId);
    if (!b || b.direction !== 'out' || b.peerId !== peerId) return;
    this.pendingBatches.delete(m.batchId);
    if (m.accept !== true) {
      for (const id of b.fileIds) { const tr = this.transfers.get(id); if (tr) { tr.state = 'declined'; tr.error = V.cleanText(m.reason, 120); } }
      this._changed(); return;
    }
    for (const id of b.fileIds) { const tr = this.transfers.get(id); if (tr && tr.state === 'offered') tr.state = 'queued'; }
    this._changed();
    for (const id of b.fileIds) {
      const tr = this.transfers.get(id);
      if (!tr || tr.state !== 'queued') continue;
      const c = this.conns[peerId];
      if (!c) { tr.state = 'failed'; tr.error = 'Disconnected'; continue; }
      try { await this._sendOne(c, tr); } catch (e) { if (tr.state !== 'cancelled') { tr.state = 'failed'; tr.error = e.message; } }
      this._changed();
    }
  }

  async _sendOne(c, tr) {
    tr.state = 'sending'; tr.startedAt = Date.now();
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(tr.abs, { highWaterMark: CHUNK });
    let seq = 0, sent = 0;
    try {
      for await (const chunk of rs) {
        if (tr.state === 'cancelled') { rs.destroy(); return; }
        sent += chunk.length;
        if (sent > tr.size) throw new Error('File changed while sending');
        hash.update(chunk);
        await c.sendAsync({ t: 'file-chunk', fileId: tr.id, seq: seq++, data: chunk.toString('base64') });
        tr.bytes = sent;
        this._changed();
      }
    } finally { rs.destroy(); }
    if (sent !== tr.size) throw new Error('File changed while sending');
    await c.sendAsync({ t: 'file-end', fileId: tr.id, sha256: hash.digest('hex') });
    tr.state = 'verifying';
    setTimeout(() => { if (tr.state === 'verifying') { tr.state = 'failed'; tr.error = 'The other PC did not confirm the file'; this._changed(); } }, 120000).unref();
  }

  _recvChunk(peerId, conn, m) {
    if (!V.isId(m.fileId) || !Number.isInteger(m.seq) || !V.isB64(m.data, 400000)) return;
    const tr = this.transfers.get(m.fileId);
    if (!tr || tr.direction !== 'in' || tr.peerId !== peerId) return;
    if (!['queued', 'receiving'].includes(tr.state)) return;
    const fail = err => { tr.state = 'failed'; tr.error = err; if (tr.ws) { tr.ws.destroy(); try { fs.unlinkSync(tr.partPath); } catch {} } this._changed(); };
    if (!tr.ws) {
      const rootAbs = path.resolve(tr.root || this.settings.receiveDir);
      const finalPath = path.resolve(rootAbs, V.safeRel(tr.name));
      if (!finalPath.startsWith(rootAbs + path.sep)) return fail('Bad file name');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      tr.finalPath = finalPath;
      tr.partPath = uniquePath(finalPath + '.velspart');
      tr.ws = fs.createWriteStream(tr.partPath, { flags: 'wx', highWaterMark: this.writeHighWaterMark });
      tr.ws.on('error', e => fail(e.message));
      tr.hash = crypto.createHash('sha256');
      tr.state = 'receiving'; tr.startedAt = Date.now(); tr.seq = 0;
    }
    if (m.seq !== tr.seq) return fail('Out of order data');
    tr.seq++;
    const buf = Buffer.from(m.data, 'base64');
    tr.hash.update(buf);
    tr.bytes += buf.length;
    if (tr.bytes > tr.size) return fail('More data than announced');
    if (!tr.ws.write(buf)) {
      // The disk is slower than the network: stop reading until it catches up. Node never sends
      // 'drain' once the file is being closed, so also resume on finish/close/error.
      conn.socket.pause();
      const ws = tr.ws;
      const resume = () => { ws.off('drain', resume); ws.off('finish', resume); ws.off('close', resume); ws.off('error', resume); if (!conn.closed) conn.socket.resume(); };
      ws.on('drain', resume); ws.on('finish', resume); ws.on('close', resume); ws.on('error', resume);
    }
    this._changed();
  }

  _markDownloaded(file) {
    // Windows "Mark of the Web": Windows warns before opening a received program or script.
    if (!IS_WIN) return;
    try { fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); } catch {}
  }

  _recvEnd(peerId, m) {
    if (!V.isId(m.fileId) || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return;
    const tr = this.transfers.get(m.fileId);
    if (!tr || tr.direction !== 'in' || tr.peerId !== peerId) return;
    const c = this.conns[peerId];
    const peer = this.peers[peerId];
    const finish = (ok, error) => {
      tr.state = ok ? 'done' : 'failed'; tr.error = error || ''; tr.endedAt = Date.now();
      c && c.send({ t: 'file-done', fileId: tr.id, ok, error: error || '' });
      this._changed();
      if (ok) { this._markDownloaded(tr.finalPath); this.emit('file-received', { name: tr.name, path: tr.finalPath }); this.audit('info', 'file', `Received "${tr.name}" from ${peer ? peer.name : 'a PC'}`); }
    };
    if (tr.state === 'failed') return finish(false, tr.error);
    if (!['queued', 'receiving'].includes(tr.state)) return;
    if (!tr.ws) {
      if (tr.size !== 0 || tr.state !== 'queued') return finish(false, 'No data received');
      const rootAbs = path.resolve(tr.root || this.settings.receiveDir);
      const finalPath = uniquePath(path.resolve(rootAbs, V.safeRel(tr.name)));
      if (!finalPath.startsWith(rootAbs + path.sep)) return finish(false, 'Bad file name');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, '', { flag: 'wx' });
      tr.finalPath = finalPath;
      return finish(true);
    }
    tr.state = 'verifying';
    let settled = false;
    const settle = (ok, error) => { if (settled) return; settled = true; finish(ok, error); };
    tr.ws.once('error', e => { try { fs.unlinkSync(tr.partPath); } catch {} settle(false, e.message); });
    tr.ws.end(() => {
      const digest = tr.hash.digest('hex');
      if (digest !== m.sha256 || tr.bytes !== tr.size) { try { fs.unlinkSync(tr.partPath); } catch {} return settle(false, 'Checksum mismatch'); }
      const dest = uniquePath(tr.finalPath);
      // Windows antivirus can briefly lock a brand-new file: retry the rename a few times
      const tryRename = n => {
        try { fs.renameSync(tr.partPath, dest); tr.finalPath = dest; settle(true); }
        catch (e) { if (n > 0 && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) setTimeout(() => tryRename(n - 1), 250); else settle(false, e.message); }
      };
      tryRename(8);
    });
  }

  _recvCancel(peerId, m) {
    if (!V.isId(m.fileId)) return;
    const tr = this.transfers.get(m.fileId);
    if (!tr || tr.peerId !== peerId || ['done', 'failed', 'declined', 'cancelled'].includes(tr.state)) return;
    tr.state = 'cancelled';
    if (tr.ws) { tr.ws.destroy(); try { fs.unlinkSync(tr.partPath); } catch {} }
    this._changed();
  }

  cancelTransfer(fileId) {
    const tr = this.transfers.get(fileId);
    if (!tr || ['done', 'failed', 'declined', 'cancelled'].includes(tr.state)) return;
    tr.state = 'cancelled';
    const c = this.conns[tr.peerId];
    c && c.send({ t: 'file-cancel', fileId });
    if (tr.ws) { tr.ws.destroy(); try { fs.unlinkSync(tr.partPath); } catch {} }
    this._changed();
  }

  clearFinishedTransfers() {
    for (const [id, tr] of this.transfers) if (['done', 'failed', 'declined', 'cancelled'].includes(tr.state)) this.transfers.delete(id);
    this._finishedCount = 0; this._saveTransfers();
    this._changed();
  }

  transferPath(id) {
    const t = this.transfers.get(id);
    if (!t || t.state !== 'done') return null;
    const p = t.direction === 'out' ? t.abs : t.finalPath;
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  }
  isReceivedFile(p) {
    for (const tr of this.transfers.values()) if (tr.direction === 'in' && tr.state === 'done' && tr.finalPath === p) return true;
    return false;
  }

  // ---------- main (parent) PC + passcode ----------
  // One PC in the home is the "main" PC. Its 4- or 6-digit passcode protects: the main PC's
  // security/parental settings and Family page, and the parental settings on kid PCs.
  // The passcode is checked BY THE MAIN PC (kid PCs ask it over the encrypted link), so it can't be
  // cracked from files on a kid's PC. With a 6-digit passcode, kid PCs also keep a slow-to-crack
  // backup check for when the main PC is off.
  _hashPin(pin, salt) { return crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('base64'); }
  _validPasscode(pin) {
    if (typeof pin !== 'string' || !/^(\d{4}|\d{6})$/.test(pin)) throw new Error('The passcode must be 4 or 6 digits');
    if (/^(\d)\1+$/.test(pin) || ['1234', '4321', '123456', '654321', '012345', '123123', '1212', '6969', '2580'].includes(pin)) throw new Error('That passcode is too easy to guess');
  }
  _makeVerifier(pin) { const salt = crypto.randomBytes(16).toString('base64'); return { salt, hash: this._hashPin(pin, salt), digits: pin.length }; }
  _matches(verifier, pin) { return !!verifier && typeof pin === 'string' && /^\d{4,6}$/.test(pin) && C.safeEqual(this._hashPin(pin, verifier.salt), verifier.hash); }
  _failBump(key, label) {
    const now = Date.now();
    const f = this.pinFails.get(key) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 5) { f.count = 0; f.until = now + 5 * 60000; this.audit('alert', 'main', `Passcode locked for 5 minutes after 5 wrong tries (${label})`); }
    this.pinFails.set(key, f);
    return f.until > now;
  }
  _failCheck(key) {
    const f = this.pinFails.get(key);
    if (f && f.until > Date.now()) throw new Error(`Too many wrong passcodes. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.`);
  }
  get isMain() { return this.main.isMain; }
  get mainId() { return this.main.isMain ? this.id : this.main.mainId; }

  // --- on the main PC ---
  _verifyAsMain(pin, who) {
    const key = 'main:' + who;
    this._failCheck(key);
    if (!this._matches(this.main.lock, pin)) {
      this.audit('warn', 'main', `Wrong main passcode entered ${who === 'local' ? 'on this PC' : 'on ' + (this.peers[who] ? this.peers[who].name : 'a PC')}`);
      const locked = this._failBump(key, who === 'local' ? 'this PC' : (this.peers[who] ? this.peers[who].name : 'a PC'));
      throw new Error(locked ? 'Too many wrong passcodes. Try again in 5 minutes.' : 'Wrong passcode');
    }
    this.pinFails.delete(key);
    return true;
  }
  unlockAdmin(pin) {
    if (!this.isMain || !this.main.lock) return true;
    this._verifyAsMain(pin, 'local');
    this.adminUntil = Date.now() + 10 * 60000;
    this._changed();
    return true;
  }
  lockAdmin() { this.adminUntil = 0; this._changed(); }
  adminLocked() { return this.isMain && !!this.main.lock && Date.now() > this.adminUntil; }
  _requireAdmin() { if (this.adminLocked()) throw new Error('Locked: enter the main PC passcode'); }

  becomeMain(pin) {
    if (this.main.mainId && this.main.mainId !== this.id) throw new Error(`${this.peers[this.main.mainId] ? this.peers[this.main.mainId].name : 'Another PC'} is already the main PC`);
    this._validPasscode(pin);
    this.main = { isMain: true, mainId: this.id, lock: this._makeVerifier(pin), fallback: null };
    this.adminUntil = Date.now() + 10 * 60000;
    this._saveSettings();
    this.audit('info', 'main', `This PC is now the main PC (${pin.length}-digit passcode)`);
    for (const c of Object.values(this.conns)) c.send({ t: 'main-claim' });
    this._changed();
  }
  changePasscode(oldPin, newPin) {
    if (!this.isMain) throw new Error('Only the main PC has a passcode');
    this._verifyAsMain(oldPin, 'local');
    this._validPasscode(newPin);
    this.main.lock = this._makeVerifier(newPin);
    this._saveSettings();
    this.audit('info', 'main', 'Main PC passcode changed');
    this._pushVerifier();
  }
  releaseMain(pin) {
    if (!this.isMain) return;
    this._verifyAsMain(pin, 'local');
    for (const c of Object.values(this.conns)) c.send({ t: 'main-release' });
    this.main = { isMain: false, mainId: '', lock: null, fallback: null };
    this._saveSettings();
    this.audit('info', 'main', 'This PC is no longer the main PC');
  }
  // kid PCs with sharing on get a backup verifier only for 6-digit passcodes
  _pushVerifier(conn) {
    if (!this.isMain || !this.main.lock) return;
    const v = this.main.lock.digits === 6 ? { salt: this.main.lock.salt, hash: this.main.lock.hash } : null;
    const targets = conn ? [conn] : Object.entries(this.conns).filter(([id]) => this.remote[id] && this.remote[id].monitored).map(([, c]) => c);
    for (const c of targets) c.send({ t: 'main-verifier', v });
  }

  // --- on any PC: check the main PC's passcode ---
  async verifyMainPasscode(pin) {
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) throw new Error('Enter the 4 or 6 digit passcode');
    if (this.isMain) return this._verifyAsMain(pin, 'local');
    const mainId = this.main.mainId;
    if (!mainId) throw new Error('There is no main PC yet');
    const c = this.conns[mainId];
    if (c) {
      const reqId = C.randomId();
      const ok = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pendingPin.delete(reqId); reject(new Error('The main PC did not answer')); }, 15000);
        this.pendingPin.set(reqId, { peerId: mainId, timer, resolve, reject });
        c.send({ t: 'pin-check', reqId, pin });
      });
      return ok;
    }
    if (this.main.fallback) {
      this._failCheck('fallback');
      if (!this._matches(this.main.fallback, pin)) {
        this.audit('warn', 'main', 'Wrong main passcode entered on this PC (main PC offline)');
        const locked = this._failBump('fallback', 'this PC');
        throw new Error(locked ? 'Too many wrong passcodes. Try again in 5 minutes.' : 'Wrong passcode');
      }
      this.pinFails.delete('fallback');
      return true;
    }
    throw new Error(`Turn on the main PC (${this.peers[mainId] ? this.peers[mainId].name : 'main PC'}) first — it checks the passcode`);
  }

  // first connection: the requesting PC chooses which PC is the main one
  async chooseMain(peerId, who, pin) {
    if (!V.isId(peerId) || !this.peers[peerId]) throw new Error('Unknown computer');
    if (who === 'self') return this.becomeMain(pin);
    if (who !== 'peer') throw new Error('Choose a PC');
    this._validPasscode(pin);
    const c = this.conns[peerId];
    if (!c) throw new Error('That PC is offline');
    const reqId = C.randomId();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingPin.delete(reqId); reject(new Error('No answer from that PC')); }, 20000);
      this.pendingPin.set(reqId, { peerId, timer, resolve, reject });
      c.send({ t: 'main-set', reqId, pin });
    });
    this._adoptMain(peerId);
  }
  _adoptMain(peerId) {
    if (this.isMain || (this.main.mainId && this.main.mainId !== peerId)) return false;
    if (this.main.mainId === peerId) return true;
    this.main.mainId = peerId;
    this._saveSettings();
    this.audit('info', 'main', `${this.peers[peerId] ? this.peers[peerId].name : 'A PC'} is now the main PC`);
    this._changed();
    return true;
  }
  _mainInfoMsg() { return { t: 'main-info', isMain: this.isMain, hasMain: !!this.mainId, plan: this.tier(), kids: this.kidCount(), kidLimit: this.limits().kids }; }
  _broadcastMainInfo() { if (!this.isMain) return; const m = this._mainInfoMsg(); for (const c of Object.values(this.conns)) c.send(m); }

  // ---------- plans & license ----------
  // This PC's plan: its own license, or the main PC's plan (one purchase covers the household).
  tier() {
    const own = this.license.tier();
    if (this.isMain || !this.main.mainId) return own;
    return Plans.best(own, this.mainPlan);
  }
  limits(tier = this.tier()) { return Object.assign({}, Plans.plan(tier), this.planOverrides[tier] || {}); }
  _fileLimitWith(peerId) {
    const r = this.remote[peerId];
    const t = Plans.best(this.tier(), r && r.plan);
    const l = this.limits(t);
    return { tier: t, name: l.name, bytes: l.maxFileBytes };
  }
  kidCount() { return Object.values(this.peers).filter(p => p.child).length; }
  // linked PCs = other PCs this one is paired with (this PC doesn't count)
  pcCount() { return Object.keys(this.peers).length; }
  // re-pairing a PC that's already linked is always fine; existing links are never cut on a downgrade
  canLink(peerId) { return !!(peerId && this.peers[peerId]) || this.pcCount() < this.limits().pcs; }
  _linkLimitText() {
    const l = this.limits();
    return `The ${l.name} plan links up to ${l.pcs} other PCs${this._upsell(this.tier(), 'pcs')}. You can also unpair a PC you no longer use.`;
  }
  // " — Family links up to 6" style hint for the next plan up (empty on the top plan)
  _upsell(tier, what) {
    const up = Plans.next(tier);
    if (!up) return '';
    const l = this.limits(up);
    if (what === 'pcs') return ` — ${l.name} links up to ${l.pcs}`;
    return ` — ${l.name} sends ${Number.isFinite(l.maxFileBytes) ? 'up to ' + Math.round(l.maxFileBytes / 1024 ** 3) + ' GB' : 'any size'}`;
  }
  async activateLicense(key) {
    this._requireAdmin();
    const info = await this.license.activate(key, `VELS Syndicate · ${this.settings.name}`);
    this.audit('info', 'plan', `${Plans.plan(info.tier).name} license activated on this PC`);
    this._planChanged();
    return info;
  }
  async removeLicense() {
    this._requireAdmin();
    await this.license.remove();
    this.audit('info', 'plan', 'License removed from this PC');
    this._planChanged();
  }
  async _checkLicense() {
    if (!this.license.needsCheck()) return;
    const before = this.tier();
    let r;
    try { r = await this.license.validate(); } catch { return; }
    if (r === 'ok' && before !== this.tier()) this.audit('info', 'plan', 'The license key is valid again');
    if (r === 'revoked' && before !== this.tier()) { this.audit('alert', 'plan', 'The license key is no longer valid (refunded or turned off) — back to the Free plan'); this._toast('warn', 'Your license key is no longer valid. VELS Syndicate is back on the Free plan.'); }
    if (this.tier() !== before) this._planChanged();
  }
  _planChanged() { this._tickStats(); this._broadcastMainInfo(); this._changed(); }
  planInfo() {
    const t = this.tier(), own = this.license.tier(), l = this.limits(t);
    return {
      tier: t, name: l.name, pcs: l.pcs, kids: l.kids, maxFileBytes: Number.isFinite(l.maxFileBytes) ? l.maxFileBytes : null,
      pcCount: this.pcCount(), commercial: !!l.commercial,
      own, inherited: t !== own, fromName: t !== own && this.peers[this.main.mainId] ? this.peers[this.main.mainId].name : '',
      kidCount: this.isMain ? this.kidCount() : null, license: this.license.info(),
      tiers: Plans.ORDER.map(x => { const p = this.limits(x); return { tier: x, name: p.name, pcs: p.pcs, kids: p.kids, commercial: !!p.commercial, maxFileBytes: Number.isFinite(p.maxFileBytes) ? p.maxFileBytes : null }; }),
    };
  }

  // ---------- parental monitoring (kid side) ----------
  _tellParent(msg) { const c = this.monitor.enabled && this.conns[this.monitor.parentId]; if (c) c.send(msg); }
  _monitorHello(conn) {
    conn.send({ t: 'monitor-hello', urls: this.monitor.urls, keepDays: this.monitor.keepDays });
    if (this.selfActivity) conn.send({ t: 'activity', a: this.selfActivity });
  }
  _onOwnActivity(a) {
    this.selfActivity = a;
    this._tellParent({ t: 'activity', a });
    this._changed();
  }
  // Turn on, change or turn off sharing. Always needs the main PC's passcode.
  async configureMonitor({ enabled, urls, keepDays, pin } = {}) {
    if (this.isMain) throw new Error('The main PC is the parent — turn sharing on from the kids\' PCs');
    const parentId = this.main.mainId;
    if (!parentId || !this.peers[parentId]) throw new Error('Choose a main PC first (it is asked when connecting, or in Settings)');
    await this.verifyMainPasscode(pin);
    const wasOn = this.monitor.enabled;
    const mi = this.remote[parentId] && this.remote[parentId].mainInfo;
    if (!wasOn && enabled !== false && mi && mi.kidLimit && mi.kids >= mi.kidLimit) {
      throw new Error(`${this.peers[parentId].name} is on the ${Plans.plan(mi.plan).name} plan, which allows ${mi.kidLimit} kid PCs, and all are in use. Upgrade the main PC to add more.`);
    }
    if (enabled === false) { if (wasOn) this._disableMonitor('Turned off with the main PC passcode'); return; }
    if (typeof urls === 'boolean') { this.monitor.urls = urls; this.activity.setIncludeUrls(urls); }
    if (Number.isInteger(keepDays)) { this.monitor.keepDays = Math.min(365, Math.max(1, keepDays)); this.activity.keepDays = this.monitor.keepDays; }
    this.monitor.parentId = parentId;
    this.monitor.enabled = true;
    // a monitored PC must keep running in the background and start with the computer
    this.settings.keepInTray = true; this.settings.startWithWindows = true;
    this._saveSettings();
    this.activity.start();
    const c = this.conns[parentId];
    if (c) this._monitorHello(c);
    this.audit('info', 'monitor', `${wasOn ? 'Updated' : 'Turned on'} activity sharing with ${this.peers[parentId].name}`);
    this.emit('monitor-changed', this.monitorInfo());
  }
  _disableMonitor(reason) {
    if (!this.monitor.enabled) return;
    this._tellParent({ t: 'monitor-off', reason });
    this.monitor.enabled = false;
    this.activity.stop();
    this.activity.wipe(); this._hsCache = null;
    this.selfActivity = null;
    this._saveSettings();
    this.audit('info', 'monitor', reason);
    this.emit('monitor-changed', this.monitorInfo());
  }
  monitorInfo() {
    const p = this.peers[this.monitor.parentId];
    return { enabled: this.monitor.enabled, parentId: this.monitor.parentId, parentName: p ? p.name : '', urls: this.monitor.urls, keepDays: this.monitor.keepDays, supported: this.activity.supported };
  }
  mainInfo() {
    const mp = this.main.mainId && this.peers[this.main.mainId];
    return {
      isMain: this.isMain, mainId: this.mainId || '', mainName: this.isMain ? this.settings.name : (mp ? mp.name : ''),
      digits: this.isMain && this.main.lock ? this.main.lock.digits : (this.main.fallback ? 6 : null),
      locked: this.adminLocked(), mainOnline: this.isMain || !!(this.main.mainId && this.conns[this.main.mainId]), offlineCheck: !!this.main.fallback,
    };
  }
  requestHistory(peerId, daysAgo = 0) { return this._askKid(peerId, { t: 'activity-req', daysAgo: Math.max(0, Math.min(400, daysAgo | 0)) }); }
  // delete the history saved on a kid's PC (main PC only, while unlocked)
  async deleteKidHistory(peerId) {
    const r = await this._askKid(peerId, { t: 'activity-wipe' });
    const p = this.peers[peerId];
    this.audit('info', 'monitor', `Deleted the activity history saved on ${p ? p.name : 'a kid PC'}`);
    return r;
  }
  _askKid(peerId, msg) {
    try { this._requireAdmin(); } catch (e) { return Promise.reject(e); }
    if (!V.isId(peerId)) return Promise.reject(new Error('Unknown computer'));
    const c = this.conns[peerId];
    if (!c) return Promise.reject(new Error('That PC is offline — history is kept on the kid\'s PC'));
    const reqId = C.randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingHistory.delete(reqId); reject(new Error('No answer from that PC')); }, 15000);
      this.pendingHistory.set(reqId, { peerId, resolve, reject, timer });
      c.send(Object.assign({}, msg, { reqId }));
    });
  }
  // descriptions for websites in a kid's history (only on the main PC, only when the setting is on)
  async describeSites(hosts) {
    this._requireAdmin();
    if (!Array.isArray(hosts) || !this.settings.describeSites) return {};
    return this.siteInfo.describe(hosts.filter(h => typeof h === 'string').slice(0, 200));
  }
  // folder size is read at most every 30 s (the window asks for state several times a second)
  _historyStorage() {
    const now = Date.now();
    // an empty reading is never kept: checking an empty folder is cheap, and the first saved line should show right away
    if (!this._hsCache || !this._hsCache.v.bytes || now - this._hsCache.at > 30000) this._hsCache = { at: now, v: this.activity.storage() };
    return this._hsCache.v;
  }
  // kid PC: where its own history is saved and how big it is (opening the folder needs the main PC's passcode)
  historyFolder() { return this.activity.dir; }
  async openHistoryFolderCheck(pin) {
    if (this.isMain) throw new Error('History is saved on the kids\' PCs, not on the main PC');
    if (this.monitor.enabled) await this.verifyMainPasscode(pin);
    return this.activity.dir;
  }
  _cleanActivity(a) {
    if (!a || typeof a !== 'object' || !ACTIVITY_KINDS.includes(a.kind)) return null;
    return { kind: a.kind, app: V.cleanText(a.app, 80, 'App'), detail: V.cleanText(a.detail, 160), site: V.cleanText(a.site, 80), since: V.num(a.since, 0, 1e15), at: Date.now() };
  }
  _cleanEntry(e) {
    if (!e || typeof e !== 'object' || !ACTIVITY_KINDS.includes(e.kind)) return null;
    const start = V.num(e.start, 0, 1e15), end = V.num(e.end, 0, 1e15);
    if (end < start) return null;
    const url = e.kind === 'browser' ? pageUrl(e.url) : '';
    const out = { start, end, kind: e.kind, app: V.cleanText(e.app, 80, 'App'), detail: V.cleanText(e.detail, 160), site: V.cleanText(e.site, 80), live: e.live === true };
    if (url) { out.url = url; out.host = siteFromUrl(url); }
    return out;
  }

  // ---------- transfer history (kept between restarts, on this PC only) ----------
  _loadTransfers() {
    const list = readJSON(this.transfersFile, []);
    if (!Array.isArray(list)) return;
    for (const t of list.slice(-300)) {
      if (!t || !V.isId(t.id) || !['in', 'out'].includes(t.direction)) continue;
      this.transfers.set(t.id, {
        id: t.id, direction: t.direction, peerId: V.isId(t.peerId) ? t.peerId : '', peerName: V.cleanText(t.peerName, 64), name: V.cleanText(t.name, 1024, 'file'),
        size: V.num(t.size, 0, 2 ** 53), bytes: V.num(t.bytes, 0, 2 ** 53), state: ['done', 'failed', 'declined', 'cancelled'].includes(t.state) ? t.state : 'failed',
        error: V.cleanText(t.error, 200), finalPath: typeof t.finalPath === 'string' ? t.finalPath : undefined, abs: typeof t.abs === 'string' ? t.abs : undefined, createdAt: V.num(t.createdAt, 0, 1e15), endedAt: V.num(t.endedAt, 0, 1e15), history: true,
      });
    }
  }
  _saveTransfers() {
    clearTimeout(this._saveTrTimer);
    this._saveTrTimer = setTimeout(() => {
      const done = [...this.transfers.values()].filter(t => ['done', 'failed', 'declined', 'cancelled'].includes(t.state))
        .sort((a, b) => a.createdAt - b.createdAt).slice(-300)
        .map(t => ({ id: t.id, direction: t.direction, peerId: t.peerId, peerName: t.peerName || (this.peers[t.peerId] ? this.peers[t.peerId].name : ''), name: t.name, size: t.size, bytes: t.bytes, state: t.state, error: t.error || '', finalPath: t.direction === 'in' ? t.finalPath : undefined, abs: t.direction === 'out' ? t.abs : undefined, createdAt: t.createdAt, endedAt: t.endedAt || Date.now() }));
      try { writeJSON(this.transfersFile, done); } catch {}
    }, 500);
  }

  // ---------- settings ----------
  updateSettings(patch) {
    const clean = V.cleanSettingsPatch(patch);
    if ('name' in clean && !clean.name) delete clean.name;
    const before = { allowPairing: this.settings.allowPairing, lanOnly: this.settings.lanOnly, taskPolicy: this.settings.taskPolicy, filePolicy: this.settings.filePolicy };
    if (this.monitor.enabled) { delete clean.keepInTray; delete clean.startWithWindows; }
    if (['allowPairing', 'lanOnly', 'taskPolicy', 'filePolicy'].some(k => k in clean && clean[k] !== this.settings[k])) this._requireAdmin();
    Object.assign(this.settings, clean);
    for (const k of Object.keys(before)) if (k in clean && clean[k] !== before[k]) this.audit('info', 'setting', `Setting changed: ${k} = ${clean[k]}`);
    this._saveSettings();
    if ('name' in clean && this.udp) this._beaconAll(false);
    if ('maxParallel' in clean) this._pump();
    this._tickStats();
  }

  // ---------- snapshot for the UI ----------
  getState() {
    const now = Date.now();
    const devices = [];
    const ids = new Set([...Object.keys(this.peers), ...Object.keys(this.nearby)]);
    for (const id of ids) {
      const p = this.peers[id], n = this.nearby[id], r = this.remote[id] || {};
      const connected = !!this.conns[id];
      devices.push({
        id, name: (p && p.name) || (n && n.name) || 'Unknown PC',
        paired: !!p, perms: p ? p.perms : null, connected, connecting: !!this.connecting[id],
        nearby: !!n, host: (n && n.host) || (p && p.lastHost) || '', port: (n && n.port) || (p && p.lastPort) || 47821,
        status: connected ? (r.status || 'Idle') : 'Offline', role: r.role || '',
        stats: connected ? r.stats || null : null, platform: r.stats ? r.stats.platform : null,
        latency: connected ? r.latency : null, activeTask: connected ? r.activeTask || '' : '', queued: connected ? r.queued || 0 : 0,
        lastSeen: n ? now - n.lastSeen : null, plan: r.plan || null,
        child: !!(p && p.child), connectedFor: connected && r.connectedAt ? now - r.connectedAt : 0, monitored: connected ? !!r.monitored : !!(p && p.child), activity: connected && r.monitored ? r.activity || null : null,
      });
    }
    devices.sort((a, b) => (b.paired - a.paired) || (b.connected - a.connected) || a.name.localeCompare(b.name));
    const strip = o => { const { output, abs, ws, hash, partPath, root, ...rest } = o; return rest; };
    const trView = t => Object.assign(strip(t), { canOpen: t.state === 'done' && !!(t.direction === 'out' ? t.abs : t.finalPath) });
    const blocked = [];
    for (const [key, b] of this.blocks) if (b.until > now) blocked.push({ key, label: b.label || key.replace(/^(ip|id):/, ''), reason: b.reason, until: b.until });
    return {
      self: {
        id: this.id, name: this.settings.name, status: this.effectiveStatus(), manualStatus: this.manualStatus, role: this.role,
        main: this.mainInfo(), monitor: this.monitorInfo(), activity: this.monitor.enabled ? this.selfActivity : null,
        historyStorage: this.monitor.enabled ? this._historyStorage() : null,
        stats: this.stats, platform: process.platform, port: this.tcpPort, udpPort: this.udpPort, activeTask: this._activeTaskTitle(), queued: this.queue.length,
      },
      devices,
      tasks: [...this.tasks.values()].map(t => Object.assign(strip(t), { outLen: t.output.length })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
      transfers: [...this.transfers.values()].map(trView).sort((a, b) => b.createdAt - a.createdAt).slice(0, 400),
      settings: this.settings,
      plan: this.planInfo(),
      security: { keyProtection: this.keyProtection, blocked, log: this.secLog.slice(-150).reverse() },
    };
  }
}

module.exports = { VelsNode, Conn, STATUSES };
