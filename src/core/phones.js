'use strict';
// Phones and tablets: send and receive files with no app to install.
//
// This PC serves a small web page on the home network. A phone opens it by scanning a QR code.
// The QR holds a one-time 20-character code. The code is never sent over the network: the phone
// and this PC each turn it into (a) a lookup token and (b) an encryption key. Everything after
// that is encrypted and authenticated with NaCl secretbox (XSalsa20-Poly1305, tweetnacl), because
// phone browsers block their built-in encryption on plain home-network addresses.
// After this PC approves the phone, it gets its own random key, so the code is useless afterwards.
// Every later request is encrypted with that key and carries a timestamp and a one-time number,
// so a copied or replayed request is refused.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const nacl = require('../vendor/nacl-fast');
const V = require('./validate');
const Stats = require('./stats');
const QR = require('./qr');

const PAIR_TTL = 2 * 60 * 1000;          // a QR code works for 2 minutes
const CLOCK_SKEW = 5 * 60 * 1000;        // phone and PC clocks may differ a little
const MAX_BODY = 2 * 1024 * 1024 + 4096; // one encrypted chunk
const CHUNK_MAX = 2 * 1024 * 1024;
const PHONE_DL_MAX = 2 * 1024 ** 3;      // a phone browser keeps a download in memory: cap it
const ONLINE_MS = 25 * 1000;
const FORGET_TEMP_MS = 12 * 60 * 60 * 1000; // "don't remember" phones are dropped after 12 h unused
const OUTBOX_DAYS = 7;
const CODE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// the same accent colors as the PC window (src/renderer/app.js), so the phone page matches the PC
const ACCENTS = { blue: '#0a84ff', purple: '#bf5af2', hotpink: '#ff2d95', pink: '#ff375f', crimson: '#e5484d', orange: '#ff9f0a', green: '#30d158', teal: '#40c8e0', graphite: '#8e8e93' }; // no I, L, O, U (easy to mistype)
const PHONE_DIR = path.join(__dirname, '..', 'phone');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/phone.css': ['phone.css', 'text/css; charset=utf-8'],
  '/nacl.js': [path.join('..', 'vendor', 'nacl-fast.js'), 'text/javascript; charset=utf-8'],
  '/icon.png': [path.join('..', '..', 'build', 'icon.png'), 'image/png'],
};
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ---------- small helpers (the phone page has the same ones) ----------
function normCode(s) {
  return String(s || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
}
function deriveFromCode(code) {
  const h = crypto.createHash('sha512').update('vels-phone-pair-v1|' + normCode(code)).digest();
  return { token: h.subarray(0, 16).toString('hex'), key: new Uint8Array(h.subarray(32, 64)) };
}
function newCode() {
  const b = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += CODE_CHARS[b[i] & 31];
  return s.match(/.{4}/g).join('-');
}
function seal(key, bytes) {
  const nonce = crypto.randomBytes(24);
  const box = nacl.secretbox(new Uint8Array(bytes), new Uint8Array(nonce), key);
  return Buffer.concat([nonce, Buffer.from(box)]);
}
function open(key, buf) {
  if (!buf || buf.length < 24 + 16) return null;
  const out = nacl.secretbox.open(new Uint8Array(buf.subarray(24)), new Uint8Array(buf.subarray(0, 24)), key);
  return out ? Buffer.from(out) : null;
}
// frame = 4-byte length + JSON + optional binary data
function frame(obj, data) {
  const j = Buffer.from(JSON.stringify(obj || {}));
  const len = Buffer.alloc(4); len.writeUInt32BE(j.length, 0);
  return data && data.length ? Buffer.concat([len, j, data]) : Buffer.concat([len, j]);
}
function unframe(buf) {
  if (!buf || buf.length < 4) return null;
  const n = buf.readUInt32BE(0);
  if (n > 64 * 1024 || 4 + n > buf.length) return null;
  try { const obj = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); return obj && typeof obj === 'object' ? { obj, data: buf.subarray(4 + n) } : null; } catch { return null; }
}
const b64 = u => Buffer.from(u).toString('base64');
function kindFromUA(ua) {
  ua = String(ua || '');
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Phone';
}
function cleanFileName(n) {
  let s = V.cleanText(String(n || '').split(/[\\/]/).pop(), 200, '').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s || 'file';
}
// the address a phone should use: the real Wi-Fi/Ethernet adapter first, virtual ones (WSL, Hyper-V, VPNs) last
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|Hamachi|VPN|TAP-|WireGuard|Bluetooth/i;
function pickAddress() {
  const list = Stats.localIPs().filter(i => V.isLocalAddress(i.address) && !/^169\.254\./.test(i.address));
  const rank = i => (VIRTUAL.test(i.name) ? 10 : 0) + (i.address.startsWith('192.168.') ? 0 : i.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b)).map(i => i.address);
}

class PhoneHub {
  // node: the VelsNode. store: { readKeep, writeKeep } for files that must survive updates.
  constructor(node, store, opts = {}) {
    this.node = node;
    this.store = store;
    this.file = path.join(node.dataDir, 'phones.json');
    this.relayDir = path.join(node.dataDir, 'phone-relay');
    this.phones = {};        // id -> { id, name, kind, key(Uint8Array), remember, createdAt, lastSeen, lastIp }
    this._locked = {};       // saved phones whose key can't be unlocked yet (kept, never deleted)
    this.pairings = new Map(); // token -> session
    this.seen = new Map();   // replay protection: "phoneId:n" -> time
    this.fails = new Map();  // ip -> { n, first, until }
    this.server = null;
    this._load();
    // the phone page's address must stay the same, or phones lose their saved login: keep the port
    this.fixedPort = opts.port === 0;
    this.port = opts.port === 0 ? 0 : (this.savedPort || opts.port || 47822);
  }

  // ---------- saved phones ----------
  _load() {
    const r = this.store.readKeep(this.file);
    const raw = (r.data && r.data.phones) || {};
    const ss = this.node.secretStore;
    for (const [id, p] of Object.entries(raw)) {
      if (!V.isId(id) || !p || typeof p !== 'object') continue;
      let key = null;
      if (typeof p.keyEnc === 'string') { try { key = ss.decrypt ? ss.decrypt(p.keyEnc) : null; } catch { key = null; } if (!key) { this._locked[id] = p; continue; } }
      else if (typeof p.key === 'string') key = p.key;
      if (!V.isB64(key, 64)) continue;
      const k = Buffer.from(key, 'base64'); if (k.length !== 32) continue;
      this.phones[id] = { id, name: V.cleanText(p.name, 40, 'Phone'), kind: V.cleanText(p.kind, 24, 'Phone'), key: new Uint8Array(k), remember: true, createdAt: V.num(p.createdAt, 0, 1e15), lastSeen: V.num(p.lastSeen, 0, 1e15), lastIp: '' };
    }
    this.outbox = Array.isArray(r.data && r.data.outbox) ? r.data.outbox : [];
    this.savedPort = V.num(r.data && r.data.port, 1024, 65535, 0) || 0;
  }
  _save() {
    const ss = this.node.secretStore;
    const phones = {};
    for (const p of Object.values(this.phones)) {
      if (!p.remember) continue;
      const key = b64(p.key);
      phones[p.id] = Object.assign({ name: p.name, kind: p.kind, createdAt: p.createdAt, lastSeen: p.lastSeen }, ss.encrypt ? { keyEnc: ss.encrypt(key) } : { key });
    }
    for (const [id, p] of Object.entries(this._locked)) if (!phones[id]) phones[id] = p;
    const outbox = [];
    for (const tr of this.node.transfers.values()) {
      if (tr.phone && tr.direction === 'out' && tr.state === 'waiting' && this.phones[tr.peerId] && this.phones[tr.peerId].remember) {
        outbox.push({ id: tr.id, phoneId: tr.peerId, name: tr.name, abs: tr.abs, size: tr.size, createdAt: tr.createdAt, relay: !!tr.relay });
      }
    }
    try { this.store.writeKeep(this.file, { port: this.port || undefined, phones, outbox }); } catch {}
  }
  // files waiting for a phone survive a restart (they were offered, not yet downloaded)
  restoreOutbox() {
    const cutoff = Date.now() - OUTBOX_DAYS * 86400000;
    for (const o of this.outbox || []) {
      if (!o || !V.isId(o.id) || !this.phones[o.phoneId] || typeof o.abs !== 'string' || V.num(o.createdAt, 0, 1e15) < cutoff) continue;
      let st; try { st = fs.statSync(o.abs); } catch { continue; }
      if (!st.isFile() || st.size !== o.size) continue;
      this.node.transfers.set(o.id, { id: o.id, direction: 'out', phone: true, relay: !!o.relay, peerId: o.phoneId, peerName: this.phones[o.phoneId].name, name: V.cleanText(o.name, 1024, 'file'), abs: o.abs, size: o.size, bytes: 0, state: 'waiting', createdAt: o.createdAt });
    }
    this.outbox = [];
  }

  has(id) { return !!this.phones[id]; }
  view() {
    const now = Date.now();
    return Object.values(this.phones).map(p => ({ id: p.id, name: p.name, kind: p.kind, online: now - p.lastSeen < ONLINE_MS, lastSeen: p.lastSeen, remember: p.remember }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  rename(id, name) {
    const p = this.phones[id]; if (!p) throw new Error('Unknown phone');
    p.name = V.cleanText(name, 40, p.name);
    for (const tr of this.node.transfers.values()) if (tr.peerId === id) tr.peerName = p.name;
    this._save(); this.node._changed();
  }
  forget(id) {
    const p = this.phones[id]; if (!p) return;
    delete this.phones[id];
    for (const tr of this.node.transfers.values()) if (tr.peerId === id && !['done', 'failed', 'declined', 'cancelled'].includes(tr.state)) this._failTr(tr, 'cancelled', 'The phone was removed');
    this._save();
    this.node.audit('info', 'phone', `Removed ${p.name}`);
    this.node._changed();
    if (!Object.keys(this.phones).length && !this.pairings.size) this.stop();
  }

  // ---------- web server ----------
  async start() {
    if (this.server) return;
    const srv = http.createServer((req, res) => this._handle(req, res).catch(() => { try { this._send(res, 500, 'text/plain', 'Error'); } catch {} }));
    srv.headersTimeout = 20000; srv.requestTimeout = 120000; srv.keepAliveTimeout = 10000;
    srv.maxHeadersCount = 40;
    const tryListen = port => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '0.0.0.0', () => { srv.off('error', reject); resolve(); }); });
    // if another program already uses the port, take the next free one (and remember it)
    let port = this.port, lastErr = null;
    for (let i = 0; i < 12; i++) {
      try { await tryListen(port); lastErr = null; break; }
      catch (e) { lastErr = e; if (e.code !== 'EADDRINUSE' || this.fixedPort) break; port++; }
    }
    if (lastErr) throw new Error(lastErr.code === 'EADDRINUSE' ? `Phones can't connect: port ${this.port} is used by another program.` : lastErr.message);
    this.server = srv;
    const was = this.port, moved = was && srv.address().port !== was;
    this.port = srv.address().port;
    if (moved) this.node.audit('warn', 'phone', `Port ${was} is used by another program, so phones now use port ${this.port}. Phones connected before need to scan a new code once.`);
    if (moved || this.savedPort !== this.port) { this.savedPort = this.port; this._save(); }
    clearInterval(this._sweep); clearInterval(this._live);
    this._sweep = setInterval(() => this._housekeep(), 30000); this._sweep.unref && this._sweep.unref();
    // "Page open" / "Page closed" on the PC: refresh when a phone stops checking in
    this._onlineKey = '';
    this._live = setInterval(() => { const k = this.view().filter(p => p.online).map(p => p.id).join(); if (k !== this._onlineKey) { this._onlineKey = k; this.node._changed(); } }, 5000);
    this._live.unref && this._live.unref();
  }
  stop() {
    clearInterval(this._sweep); clearInterval(this._live);
    if (this.server) { try { this.server.close(); this.server.closeAllConnections && this.server.closeAllConnections(); } catch {} this.server = null; }
  }
  // the phone server only runs when there's a reason to: phones saved, or a QR code on screen
  async ensureRunning() { if (Object.keys(this.phones).length || this.pairings.size) await this.start(); }

  _send(res, code, type, body, extra) {
    res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }, SEC_HEADERS, extra || {}));
    res.end(body);
  }
  _blocked(ip) { const f = this.fails.get(ip); return f && f.until > Date.now(); }
  _fail(ip, why) {
    const now = Date.now();
    let f = this.fails.get(ip);
    if (!f || now - f.first > 5 * 60000) f = { n: 0, first: now, until: 0 };
    f.n++;
    if (f.n >= 15 && !f.until) { f.until = now + 5 * 60000; this.node.audit('alert', 'phone', `Blocked ${ip} for 5 minutes: too many bad phone requests (${why})`); }
    this.fails.set(ip, f);
  }
  _readBody(req, max) {
    return new Promise((resolve, reject) => {
      const len = +req.headers['content-length'];
      if (Number.isFinite(len) && len > max) return reject(Object.assign(new Error('too big'), { code: 413 }));
      const parts = []; let got = 0;
      req.on('data', c => { got += c.length; if (got > max) { req.destroy(); reject(Object.assign(new Error('too big'), { code: 413 })); } else parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  async _handle(req, res) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
    if (!V.isLocalAddress(ip)) { req.destroy(); return; } // home network only, always
    if (this._blocked(ip)) return this._send(res, 429, 'text/plain', 'Too many attempts. Try again in a few minutes.');
    // Host must be a plain IP address (or localhost): stops other websites from reaching this
    // server through a hostname that secretly points at your network (DNS rebinding)
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '::1')) return this._send(res, 421, 'text/plain', 'Open this page with the address shown on the PC.');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = await fsp.readFile(path.join(PHONE_DIR, file));
      return this._send(res, 200, type, body);
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return this._send(res, 404, 'text/plain', 'Not found');
    if ((req.headers.origin && !/^http:\/\/[\d.]+(:\d+)?$/.test(req.headers.origin))) return this._send(res, 403, 'text/plain', 'Not allowed');
    let body;
    try { body = await this._readBody(req, MAX_BODY); } catch (e) { return this._send(res, e.code === 413 ? 413 : 400, 'text/plain', 'Bad request'); }
    if (url.pathname === '/api/pair') return this._pairHello(req, res, ip, body);
    if (url.pathname === '/api/pair-wait') return this._pairWait(res, ip, body);
    if (url.pathname === '/api/x') return this._api(req, res, ip, body);
    return this._send(res, 404, 'text/plain', 'Not found');
  }

  // ---------- pairing ----------
  async newPairing() {
    if (!this.node.settings.allowPairing) throw new Error('"Accept new connection requests" is off in Settings → Security.');
    // one code on screen at a time
    for (const [t, s] of this.pairings) if (s.state !== 'approved') this.pairings.delete(t);
    await this.start();
    const code = newCode();
    const { token, key } = deriveFromCode(code);
    const sid = crypto.randomBytes(8).toString('hex');
    const addrs = pickAddress();
    const addr = addrs[0] || '127.0.0.1';
    const url = `http://${addr}:${this.port}/#${code.replace(/-/g, '')}`;
    this.pairings.set(token, { sid, token, key, code, created: Date.now(), expires: Date.now() + PAIR_TTL, state: 'open', rid: null, ip: '', name: '', kind: '' });
    return { sid, code, url, address: `${addr}:${this.port}`, others: addrs.slice(1).map(a => `${a}:${this.port}`), expiresAt: Date.now() + PAIR_TTL, qr: QR.svg(url) };
  }
  cancelPairing(sid) {
    for (const [t, s] of this.pairings) if (s.sid === sid && s.state !== 'approved') this.pairings.delete(t);
    if (!Object.keys(this.phones).length && !this.pairings.size) this.stop();
  }
  _session(token) {
    const s = typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? this.pairings.get(token) : null;
    if (!s) return null;
    if (s.state !== 'approved' && Date.now() > s.expires && s.state !== 'asking') { this.pairings.delete(token); return null; }
    return s;
  }
  _pairBody(body) {
    let j; try { j = JSON.parse(body.toString('utf8')); } catch { return null; }
    if (!j || typeof j.tok !== 'string' || typeof j.box !== 'string' || j.box.length > 4000) return null;
    return j;
  }
  async _pairHello(req, res, ip, body) {
    const j = this._pairBody(body);
    const s = j && this._session(j.tok);
    if (!s) { this._fail(ip, 'unknown code'); return this._send(res, 404, 'application/json', JSON.stringify({ error: 'This code expired. Make a new one on the PC.' })); }
    const plain = open(s.key, Buffer.from(j.box, 'base64'));
    const u = plain && unframe(plain);
    const o = u && u.obj;
    if (!o || !V.isStr(o.rid, 64) || !/^[0-9a-f]{16,64}$/.test(o.rid) || Math.abs(Date.now() - V.num(o.ts, 0, 1e15)) > CLOCK_SKEW) { this._fail(ip, 'bad code'); return this._send(res, 400, 'application/json', JSON.stringify({ error: 'That code didn’t work.' })); }
    if (s.state !== 'open') {
      if (s.rid === o.rid) return this._send(res, 200, 'application/json', JSON.stringify({ ok: true })); // retry of the same phone
      return this._send(res, 409, 'application/json', JSON.stringify({ error: 'Another device already used this code. Make a new one on the PC.' }));
    }
    s.state = 'asking'; s.rid = o.rid; s.ip = ip; s.kind = kindFromUA(req.headers['user-agent']);
    s.name = V.cleanText(o.name, 40, '') || s.kind;
    s.asked = Date.now();
    this.node.audit('info', 'phone', `A ${s.kind} at ${ip} scanned the connect code`);
    this.node.emit('phone-request', { sid: s.sid, kind: s.kind, name: s.name, ip });
    return this._send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  }
  async _pairWait(res, ip, body) {
    const j = this._pairBody(body);
    const s = j && this._session(j.tok);
    if (!s) return this._send(res, 404, 'application/json', JSON.stringify({ state: 'gone' }));
    const plain = open(s.key, Buffer.from(j.box, 'base64'));
    const u = plain && unframe(plain);
    if (!u || u.obj.rid !== s.rid) { this._fail(ip, 'bad code'); return this._send(res, 400, 'application/json', JSON.stringify({ state: 'gone' })); }
    if (s.state === 'asking' && Date.now() - s.asked > 3 * 60000) { this.pairings.delete(s.token); return this._send(res, 200, 'application/json', JSON.stringify({ state: 'timeout' })); }
    if (s.state === 'denied') { this.pairings.delete(s.token); return this._send(res, 200, 'application/json', JSON.stringify({ state: 'denied' })); }
    if (s.state === 'approved') {
      this.pairings.delete(s.token); // delivered once; the code is now useless
      const p = this.phones[s.phoneId];
      if (!p) return this._send(res, 200, 'application/json', JSON.stringify({ state: 'gone' }));
      const box = seal(s.key, frame({ phoneId: p.id, key: b64(p.key), pcName: this.node.settings.name, pcId: this.node.id, name: p.name, remember: p.remember }));
      return this._send(res, 200, 'application/json', JSON.stringify({ state: 'approved', box: box.toString('base64') }));
    }
    return this._send(res, 200, 'application/json', JSON.stringify({ state: 'waiting' }));
  }
  // the PC user's answer to "Allow this phone to connect?"
  answer(sid, allow, name, remember) {
    let s = null;
    for (const x of this.pairings.values()) if (x.sid === sid) s = x;
    if (!s || s.state !== 'asking') throw new Error('That request is gone. Scan a new code.');
    if (!allow) { s.state = 'denied'; this.node.audit('warn', 'phone', `Refused a ${s.kind} at ${s.ip}`); return null; }
    const id = this.node._newId ? this.node._newId() : crypto.randomBytes(16).toString('hex');
    const finalName = V.cleanText(name, 40, s.name || s.kind);
    // same name as a phone already listed = the same phone connecting again (it lost its login):
    // replace the old entry instead of listing it twice, and hand over files waiting for it
    const old = Object.values(this.phones).find(x => x.name.toLowerCase() === finalName.toLowerCase());
    const p = { id, name: finalName, kind: s.kind, key: new Uint8Array(crypto.randomBytes(32)), remember: remember !== false, createdAt: Date.now(), lastSeen: Date.now(), lastIp: s.ip };
    this.phones[id] = p;
    if (old) {
      for (const tr of this.node.transfers.values()) if (tr.peerId === old.id) { tr.peerId = id; tr.peerName = p.name; }
      delete this.phones[old.id];
      this.node.audit('info', 'phone', `${p.name} connected again (replaces the old entry)`);
    }
    s.state = 'approved'; s.phoneId = id;
    this._save();
    this.node.audit('info', 'phone', `Connected ${p.name} (${s.kind}, ${s.ip})`);
    this.node._changed();
    return { id, name: p.name };
  }

  // ---------- encrypted requests from a connected phone ----------
  async _api(req, res, ip, body) {
    const id = String(req.headers['x-vels-id'] || '');
    const p = V.isId(id) ? this.phones[id] : null;
    if (!p) { this._fail(ip, 'unknown phone'); return this._send(res, 401, 'text/plain', 'This phone is not connected. Scan a new code on the PC.'); }
    const plain = open(p.key, body);
    const u = plain && unframe(plain);
    const m = u && u.obj;
    const now = Date.now();
    if (!m || typeof m.op !== 'string' || !V.isStr(m.n, 64) || Math.abs(now - V.num(m.ts, 0, 1e15)) > CLOCK_SKEW) { this._fail(ip, 'bad request'); return this._send(res, 401, 'text/plain', 'Bad request'); }
    const nk = id + ':' + m.n;
    if (this.seen.has(nk)) { this._fail(ip, 'replayed request'); return this._send(res, 401, 'text/plain', 'Bad request'); }
    this.seen.set(nk, now);
    if (this.seen.size > 20000) for (const [k, t] of this.seen) { if (now - t > 2 * CLOCK_SKEW) this.seen.delete(k); if (this.seen.size < 15000) break; }
    const wasOnline = now - p.lastSeen < ONLINE_MS;
    p.lastSeen = now; p.lastIp = ip;
    if (!wasOnline) this.node._changed();
    let out;
    try { out = await this._op(p, m, u.data); }
    catch (e) { out = { obj: { error: String(e && e.message || e).slice(0, 300) } }; }
    const enc = seal(p.key, frame(out.obj, out.data));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': enc.length }, SEC_HEADERS));
    res.end(enc);
  }

  _accent() { return ACCENTS[this.node.settings.accent] || ACCENTS.green; }
  _tabs() { const t = this.node.settings.tabNames || {}; return { send: t.phoneSend || '', get: t.phoneGet || '', nas: t.phoneNas || '' }; }
  _limitBytes() { const l = this.node.limits(); return Number.isFinite(l.maxFileBytes) ? l.maxFileBytes : Infinity; }
  _planName() { return this.node.limits().name; }

  async _op(p, m, data) {
    const T = this.node.transfers;
    switch (m.op) {
      case 'hi': {
        // a phone that's already connected scanned the QR (to open its page): no new pairing needed
        if (typeof m.scan === 'string' && /^[0-9a-f]{32}$/.test(m.scan)) {
          const s = this.pairings.get(m.scan);
          if (s && s.state === 'open') { this.pairings.delete(m.scan); this.node.emit('phone-reopened', { sid: s.sid, id: p.id, name: p.name }); }
        }
        const max = this._limitBytes();
        return { obj: { pcName: this.node.settings.name, accent: this._accent(), tabs: this._tabs(), nas: this._nasInfo(), name: p.name, kind: p.kind, maxFile: Number.isFinite(max) ? max : null, plan: this._planName(), maxDownload: PHONE_DL_MAX,
          phones: Object.values(this.phones).filter(x => x.id !== p.id).map(x => ({ id: x.id, name: x.name })) } };
      }
      case 'inbox': {
        const list = [...T.values()].filter(t => t.phone && t.direction === 'out' && t.peerId === p.id && ['waiting', 'sending'].includes(t.state))
          .sort((a, b) => a.createdAt - b.createdAt).map(t => ({ fid: t.id, name: t.name.split('/').pop(), path: t.name, size: t.size, from: t.relayFrom || this.node.settings.name, at: t.createdAt }));
        return { obj: { files: list, accent: this._accent(), tabs: this._tabs() } };
      }
      case 'up-start': return this._upStart(p, m);
      case 'up-chunk': return this._upChunk(p, m, data);
      case 'up-end': return this._upEnd(p, m);
      case 'up-cancel': {
        const tr = T.get(m.fid);
        if (tr && tr.phone && tr.direction === 'in' && tr.peerId === p.id) this._failTr(tr, 'cancelled', 'Cancelled on the phone');
        return { obj: { ok: true } };
      }
      case 'dl-chunk': return this._dlChunk(p, m);
      case 'dl-done': {
        const tr = T.get(m.fid);
        if (tr && tr.phone && tr.direction === 'out' && tr.peerId === p.id && ['waiting', 'sending'].includes(tr.state)) {
          tr.state = 'done'; tr.bytes = tr.size; tr.endedAt = Date.now();
          if (tr.relay) { try { fs.unlinkSync(tr.abs); } catch {} }
          this._save(); this.node._saveTransfers(); this.node._changed();
        }
        return { obj: { ok: true } };
      }
      // the NAS, when this PC is the NAS
      case 'nas-list': return { obj: Object.assign(await this._nas().list(this._nasAcc(), m.dir), this._nas().space(), { label: this._nas().label() }) };
      case 'nas-mkdir': return { obj: await this._nas().mkdir(this._nasAcc(), m.dir, m.name) };
      case 'nas-get': {
        const N = this._nas(), acc = this._nasAcc();
        if (!Array.isArray(m.paths) || !m.paths.length || m.paths.length > 50) throw new Error('Nothing selected');
        const files = [];
        for (const r of m.paths) { const abs = N._abs(acc, r); const st = await fsp.stat(abs); if (st.isFile()) files.push({ abs, rel: path.basename(abs), size: st.size }); }
        if (!files.length) throw new Error('Those files are gone');
        const batchId = await this.offer(p.id, files);
        const list = [...T.values()].filter(t => t.batchId === batchId).map(t => ({ fid: t.id, name: t.name, path: t.name, size: t.size, from: 'NAS', at: t.createdAt }));
        return { obj: { files: list } };
      }
      case 'bye': { this.node.audit('info', 'phone', `${p.name} disconnected itself`); this.forget(p.id); return { obj: { ok: true } }; }
      default: return { obj: { error: 'Unknown request' } };
    }
  }

  _nas() { const N = this.node.nas; if (!N || !N.cfg.root || !N.active()) throw new Error('The NAS isn’t on this PC'); return N; }
  _nasAcc() { return this.node.nas.accessFor({ phone: true }); }
  _nasInfo() {
    const N = this.node.nas; if (!N) return null;
    if (N.active()) return Object.assign({ here: true, label: N.label() }, N.space());
    const h = N.hostElsewhere();
    return h ? { here: false, host: h.name, label: h.label } : null;
  }
  async _upStart(p, m) {
    const T = this.node.transfers;
    const size = m.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Bad file size');
    const name = cleanFileName(m.name);
    let to = null;
    if (m.to != null) { if (!V.isId(m.to) || !this.phones[m.to] || m.to === p.id) throw new Error('That phone is no longer connected'); to = m.to; }
    const max = this._limitBytes();
    if (size > max) throw new Error(`"${name}" is too big for the ${this._planName()} plan (up to ${(max / 1024 ** 3).toFixed(0)} GB per file).`);
    if (to && size > PHONE_DL_MAX) throw new Error(`Phones can download files up to ${PHONE_DL_MAX / 1024 ** 3} GB. Send it to the PC instead.`);
    // resume: the same phone sending the same file again (connection dropped, page reloaded)
    for (const tr of T.values()) {
      if (tr.phone && tr.direction === 'in' && tr.peerId === p.id && tr.state === 'receiving' && tr.name === name && tr.size === size && (tr.relayTo || null) === to && !!tr.nasDir === (typeof m.nasDir === 'string') && (tr.nasDir || '') === (m.nasDir || '') && tr.fh) {
        return { obj: { fid: tr.id, have: tr.bytes } };
      }
    }
    let dir = to ? this.relayDir : this.node.settings.receiveDir, nas = false;
    if (typeof m.nasDir === 'string' && !to) { const N = this._nas(); const acc = this._nasAcc(); N._need(acc, true); dir = N._abs(acc, m.nasDir); nas = true; }
    await fsp.mkdir(dir, { recursive: true });
    if (size + 200 * 1024 * 1024 > this.node._freeSpace(dir)) throw new Error('The PC doesn’t have enough free space for this file.');
    const id = crypto.randomBytes(16).toString('hex');
    const finalPath = path.join(dir, to ? `${id.slice(0, 8)}-${name}` : name);
    const partPath = uniquePath(finalPath + '.velspart');
    const fh = await fsp.open(partPath, 'wx');
    const tr = { id, direction: 'in', phone: true, peerId: p.id, peerName: p.name, name, size, bytes: 0, state: 'receiving', createdAt: Date.now(), startedAt: Date.now(), fh, partPath, finalPath, relayTo: to, touched: Date.now(), nas: nas || undefined, nasDir: nas ? m.nasDir : undefined };
    T.set(id, tr);
    this.node._changed();
    return { obj: { fid: id, have: 0 } };
  }
  async _upChunk(p, m, data) {
    const tr = this.node.transfers.get(m.fid);
    if (!tr || !tr.phone || tr.direction !== 'in' || tr.peerId !== p.id) throw new Error('Unknown upload');
    if (tr.state !== 'receiving' || !tr.fh) throw new Error(tr.error || 'This upload was stopped');
    if (!data || data.length > CHUNK_MAX) throw new Error('Bad data');
    if (m.off !== tr.bytes) return { obj: { have: tr.bytes } }; // out of step: phone continues from here
    if (tr.bytes + data.length > tr.size) { this._failTr(tr, 'failed', 'More data than announced'); throw new Error('More data than announced'); }
    if (tr.busy) return { obj: { have: tr.bytes } };
    tr.busy = true;
    try { await tr.fh.write(data, 0, data.length, tr.bytes); tr.bytes += data.length; tr.touched = Date.now(); }
    catch (e) { tr.busy = false; this._failTr(tr, 'failed', e.message); throw e; }
    tr.busy = false;
    this.node._changed();
    return { obj: { have: tr.bytes } };
  }
  async _upEnd(p, m) {
    const tr = this.node.transfers.get(m.fid);
    if (!tr || !tr.phone || tr.direction !== 'in' || tr.peerId !== p.id) throw new Error('Unknown upload');
    if (tr.state === 'done') return { obj: { ok: true } };
    if (tr.state !== 'receiving' || !tr.fh) throw new Error(tr.error || 'This upload was stopped');
    if (tr.bytes !== tr.size) throw new Error('Not all of the file arrived');
    const fh = tr.fh; tr.fh = null;
    await fh.close();
    let dest = uniquePath(tr.finalPath);
    for (let n = 8; ; n--) { // Windows antivirus can briefly lock a brand-new file
      try { fs.renameSync(tr.partPath, dest); break; }
      catch (e) { if (n > 0 && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) await new Promise(r => setTimeout(r, 250)); else { this._failTr(tr, 'failed', e.message); throw e; } }
    }
    tr.finalPath = dest; tr.state = 'done'; tr.endedAt = Date.now();
    if (tr.relayTo) {
      // phone to phone: keep it in the relay folder until the other phone downloads it
      const to = this.phones[tr.relayTo];
      tr.name = to ? `${tr.name} → ${to.name}` : tr.name;
      if (to) {
        const oid = crypto.randomBytes(16).toString('hex');
        this.node.transfers.set(oid, { id: oid, direction: 'out', phone: true, relay: true, relayFrom: p.name, peerId: to.id, peerName: to.name, name: path.basename(dest).slice(9), abs: dest, size: tr.size, bytes: 0, state: 'waiting', createdAt: Date.now() });
      }
      this._save();
    } else {
      if (tr.nas) this.node.audit('info', 'nas', `${p.name} saved "${tr.name}" to the NAS`);
      else {
        this.node._markDownloaded(dest);
        this.node.emit('file-received', { name: tr.name, path: dest });
        this.node.audit('info', 'file', `Received "${tr.name}" from ${p.name}`);
      }
    }
    this.node._saveTransfers();
    this.node._changed();
    return { obj: { ok: true } };
  }
  async _dlChunk(p, m) {
    const tr = this.node.transfers.get(m.fid);
    if (!tr || !tr.phone || tr.direction !== 'out' || tr.peerId !== p.id) throw new Error('That file is no longer offered');
    if (!['waiting', 'sending'].includes(tr.state)) throw new Error(tr.state === 'cancelled' ? 'The PC stopped sending this file' : 'That file is no longer offered');
    const off = m.off, len = Math.min(m.len | 0, CHUNK_MAX);
    if (!Number.isSafeInteger(off) || off < 0 || off > tr.size || len <= 0) throw new Error('Bad request');
    const fh = await fsp.open(tr.abs, 'r');
    try {
      const st = await fh.stat();
      if (st.size !== tr.size) { this._failTr(tr, 'failed', 'The file changed on the PC'); throw new Error('The file changed on the PC'); }
      const buf = Buffer.alloc(Math.min(len, tr.size - off));
      const { bytesRead } = await fh.read(buf, 0, buf.length, off);
      if (tr.state === 'waiting') { tr.state = 'sending'; tr.startedAt = Date.now(); }
      tr.bytes = Math.max(tr.bytes, off + bytesRead); tr.touched = Date.now();
      this.node._changed();
      return { obj: { off, size: tr.size }, data: buf.subarray(0, bytesRead) };
    } finally { await fh.close(); }
  }

  // ---------- PC → phone ----------
  async offer(phoneId, files) {
    const p = this.phones[phoneId]; if (!p) throw new Error('Unknown phone');
    const max = Math.min(this._limitBytes(), PHONE_DL_MAX);
    const big = files.find(f => f.size > max);
    if (big) throw new Error(big.size > PHONE_DL_MAX ? `"${path.basename(big.abs)}" is over ${PHONE_DL_MAX / 1024 ** 3} GB. Phones can download files up to ${PHONE_DL_MAX / 1024 ** 3} GB from the page.` : `"${path.basename(big.abs)}" is too big for the ${this._planName()} plan.`);
    const batchId = crypto.randomBytes(16).toString('hex');
    for (const f of files) {
      const id = crypto.randomBytes(16).toString('hex');
      this.node.transfers.set(id, { id, batchId, direction: 'out', phone: true, peerId: phoneId, peerName: p.name, name: f.rel.split(path.sep).join('/'), abs: f.abs, size: f.size, bytes: 0, state: 'waiting', createdAt: Date.now() });
    }
    this._save();
    await this.ensureRunning();
    this.node._changed();
    return batchId;
  }
  cancel(tr) { this._failTr(tr, 'cancelled', ''); }

  _failTr(tr, state, error) {
    tr.state = state; tr.error = error || ''; tr.endedAt = Date.now();
    if (tr.fh) { const fh = tr.fh; tr.fh = null; fh.close().catch(() => {}).then(() => { try { fs.unlinkSync(tr.partPath); } catch {} }); }
    if (tr.relay && tr.direction === 'out') { try { fs.unlinkSync(tr.abs); } catch {} }
    this._save(); this.node._saveTransfers(); this.node._changed();
  }

  _housekeep() {
    const now = Date.now();
    for (const [t, s] of this.pairings) if (s.state === 'open' && now > s.expires + 5000) this.pairings.delete(t);
    for (const [ip, f] of this.fails) if (f.until < now && now - f.first > 10 * 60000) this.fails.delete(ip);
    for (const tr of this.node.transfers.values()) {
      // uploads from a phone that went quiet for an hour are given up
      if (tr.phone && tr.direction === 'in' && tr.state === 'receiving' && now - (tr.touched || tr.createdAt) > 60 * 60000) this._failTr(tr, 'failed', 'The phone stopped sending');
      if (tr.phone && tr.direction === 'out' && tr.state === 'sending' && now - (tr.touched || tr.createdAt) > 10 * 60000) { tr.state = 'waiting'; tr.bytes = 0; this.node._changed(); }
    }
    let changed = false;
    for (const p of Object.values(this.phones)) if (!p.remember && now - p.lastSeen > FORGET_TEMP_MS) { delete this.phones[p.id]; changed = true; }
    if (changed) { this._save(); this.node._changed(); }
  }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 10000; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q; }
  return `${base}-${Date.now()}${ext}`;
}

module.exports = { PhoneHub, deriveFromCode, normCode, seal, open, frame, unframe, newCode, PAIR_TTL };
