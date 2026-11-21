'use strict';
// NAS: one shared folder for the whole home, kept on one PC (the "host").
// Other paired PCs and phones open, save and share files there.
//
// Access (chosen on the host):  full = open, save, rename, delete
//                               view = open and download only
//                               none = can't see it
// The Kids folder: a kid's PC (Family) sees only that folder, with full rights inside it.
// Deleting moves files to the NAS recycle bin (.vels-recycle), kept 30 days; with the bin off,
// files go to the host's own Recycle Bin.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const V = require('./validate');

const BIN = '.vels-recycle';
const KIDS = 'Kids';
const BIN_DAYS = 30;
const LEVELS = ['full', 'view', 'none'];

const cleanName = n => {
  const s = String(n == null ? '' : n).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/[. ]+$/, '').trim().slice(0, 200);
  if (!s || s === '.' || s === '..' || s.toLowerCase() === BIN || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) throw new Error('Pick a different name');
  return s;
};
// "Photos/2026" style path inside the NAS, never leaving it
const cleanRel = r => {
  if (r == null || r === '' || r === '/') return '';
  if (typeof r !== 'string' || r.length > 2048) throw new Error('Bad folder');
  const parts = r.split(/[\\/]+/).filter(Boolean);
  for (const p of parts) if (p === '.' || p === '..' || p.toLowerCase() === BIN || /[\u0000-\u001f<>:"|?*]/.test(p)) throw new Error('Bad folder');
  return parts.join('/');
};

class Nas {
  constructor(node, store) {
    this.node = node;
    this.file = path.join(node.dataDir, 'nas.json');
    this.store = store; // { readKeep, writeKeep }
    this.cfg = Object.assign({ root: '', label: '', recycle: true, awake: true, askNew: true, access: {}, since: 0 }, store.readKeep(this.file, {}) || {});
    if (!this.cfg.access || typeof this.cfg.access !== 'object') this.cfg.access = {};
    this.asking = new Map(); // peerId -> promise (one question per PC at a time)
    this.client = { level: null, kids: false, hostId: '' }; // what this PC may do on someone else's NAS
  }
  _save() { this.store.writeKeep(this.file, this.cfg); }

  // ---------- host side ----------
  planOk() { return !!this.node.limits().nas; }
  active() { return !!this.cfg.root && this.planOk() && fs.existsSync(this.cfg.root); }
  label() { return this.cfg.label || path.basename(this.cfg.root) || 'NAS'; }
  advert() { return this.active() ? { label: this.label() } : null; } // sent to other PCs with the stats

  async setup(root, opts = {}) {
    this.node._requireAdmin();
    if (!this.planOk()) throw new Error(`The NAS is part of Pro${this.node._upsellNas()}`);
    const other = this.hostElsewhere();
    if (other && !opts.takeOver) throw new Error(`${other.name} is already the NAS. Use "Move the NAS" to move it here.`);
    root = this._checkRoot(root);
    await fsp.mkdir(path.join(root, KIDS), { recursive: true });
    Object.assign(this.cfg, { root, label: path.basename(root), since: Date.now() });
    for (const k of ['recycle', 'awake', 'askNew']) if (typeof opts[k] === 'boolean') this.cfg[k] = opts[k];
    this._save();
    this.node.audit('info', 'nas', `This PC is now the NAS (${root})`);
    this._announce();
    return this.view();
  }
  _checkRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Choose a folder');
    root = path.resolve(root);
    if (path.parse(root).root === root) throw new Error('Pick a folder on the drive, not the whole drive (for example D:\\Family Files)');
    fs.mkdirSync(root, { recursive: true });
    if (!fs.statSync(root).isDirectory()) throw new Error('That is not a folder');
    const data = path.resolve(this.node.dataDir);
    if (data.startsWith(root + path.sep) || root.startsWith(data + path.sep) || root === data) throw new Error('Pick a folder outside VELS Syndicate\'s own folder');
    return root;
  }
  update(opts) {
    this.node._requireAdmin();
    if (!this.cfg.root) throw new Error('This PC is not the NAS');
    for (const k of ['recycle', 'awake', 'askNew']) if (typeof opts[k] === 'boolean') this.cfg[k] = opts[k];
    if (typeof opts.label === 'string') this.cfg.label = V.cleanText(opts.label, 40) || path.basename(this.cfg.root);
    this._save(); this._announce();
    return this.view();
  }
  setAccess(peerId, level, kids) {
    this.node._requireAdmin();
    if (!V.isId(peerId) || !this.node.peers[peerId]) throw new Error('Unknown computer');
    if (level === 'ask') delete this.cfg.access[peerId];
    else { if (!LEVELS.includes(level)) throw new Error('Bad access'); this.cfg.access[peerId] = { level, kids: !!kids }; }
    this._save(); this._announce();
    this.node.audit('info', 'nas', `NAS access for ${this.node.peers[peerId].name}: ${level === 'ask' ? 'ask again' : level}${kids ? ' (Kids folder only)' : ''}`);
  }
  // stop being the NAS. Files stay in the folder.
  stop() {
    this.node._requireAdmin();
    if (!this.cfg.root) return this.view();
    this.node.audit('info', 'nas', `This PC stopped being the NAS (files stay in ${this.cfg.root})`);
    this.cfg.root = ''; this._save(); this._announce();
    return this.view();
  }
  // move to another folder on this PC: copy everything over, or start empty
  async move(newRoot, mode) {
    this.node._requireAdmin();
    if (!this.cfg.root) throw new Error('This PC is not the NAS');
    if (!['copy', 'empty'].includes(mode)) throw new Error('Bad choice');
    const from = this.cfg.root;
    const to = this._checkRoot(newRoot);
    if (to === from || to.startsWith(from + path.sep) || from.startsWith(to + path.sep)) throw new Error('Pick a folder that is not inside the current NAS folder');
    if (mode === 'copy') {
      const need = this._size(from);
      if (need + 200 * 1024 * 1024 > this.node._freeSpace(to)) throw new Error('Not enough free space in that folder');
      await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false, filter: s => path.basename(s) !== BIN });
    }
    await fsp.mkdir(path.join(to, KIDS), { recursive: true });
    this.cfg.root = to; this.cfg.label = path.basename(to); this._save(); this._announce();
    this.node.audit('info', 'nas', `NAS moved from ${from} to ${to} (${mode === 'copy' ? 'files copied' : 'started empty'}). The old folder was left as it is.`);
    return this.view();
  }
  _size(dir) {
    let n = 0;
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) n += fs.statSync(p).size; } };
    try { walk(dir); } catch {}
    return n;
  }
  _announce() { this.node.emit('nas-awake', this.active() && this.cfg.awake); setImmediate(() => this.node._tickStats()); this.node._changed(); }

  // who may do what (on the host)
  accessFor(who, claimsKid) {
    if (who === 'self') return { level: 'full', kids: false };
    if (who && who.phone) return { level: 'full', kids: false }; // phones were approved on this PC when they were paired
    const peer = this.node.peers[who];
    if (!peer) return { level: 'none', kids: false };
    if (peer.child || claimsKid === true) return { level: 'full', kids: true }; // a kid's PC: the Kids folder, no question needed
    if (this.node.mainId === who) return { level: 'full', kids: false };
    const a = this.cfg.access[who];
    if (a && LEVELS.includes(a.level)) return { level: a.level, kids: !!a.kids };
    return this.cfg.askNew ? { level: 'ask', kids: false } : { level: 'full', kids: false };
  }
  // base folder for that access (the whole NAS, or just Kids)
  _base(acc) { return acc.kids ? path.join(this.cfg.root, KIDS) : this.cfg.root; }
  _abs(acc, rel) {
    const base = path.resolve(this._base(acc));
    const abs = path.resolve(base, cleanRel(rel));
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('Bad folder');
    // a link inside the NAS must not lead outside it
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch {} }
    let realBase = base; try { realBase = fs.realpathSync(base); } catch {}
    if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error('Bad folder');
    return abs;
  }
  _need(acc, write) {
    if (!this.active()) throw new Error('The NAS is not available right now');
    if (acc.level === 'none') throw new Error('You don\'t have access to the NAS');
    if (acc.level === 'ask') throw new Error('Waiting for the NAS owner to allow this PC');
    if (write && acc.level !== 'full') throw new Error('You can only view the NAS');
  }

  // a PC opens the NAS: asks the host user the first time
  async open(peerId, claimsKid) {
    if (!this.active()) throw new Error(this.cfg.root ? 'The NAS is switched off on that PC' : 'That PC is not the NAS');
    let acc = this.accessFor(peerId, claimsKid);
    if (acc.level === 'ask') {
      if (!this.asking.has(peerId)) {
        const p = this.node._askUser('nas', peerId, { label: this.label() }, 5 * 60000).then(r => {
          this.asking.delete(peerId);
          const lvl = r.extra && r.extra.level;
          if (LEVELS.includes(lvl)) {
            this.cfg.access[peerId] = { level: lvl, kids: !!(r.extra && r.extra.kids) }; this._save();
            this.node.audit('info', 'nas', `NAS access for ${this.node.peers[peerId] ? this.node.peers[peerId].name : 'a PC'}: ${lvl}${r.extra.kids ? ' (Kids folder only)' : ''}`);
            this.node._changed();
          }
          return r;
        });
        this.asking.set(peerId, p);
      }
      await this.asking.get(peerId);
      acc = this.accessFor(peerId, claimsKid);
      if (acc.level === 'ask') throw new Error('The NAS owner hasn\'t decided yet. Try again later.');
    }
    if (acc.level === 'none') throw new Error('The NAS owner didn\'t give this PC access');
    return Object.assign({ label: this.label(), host: this.node.settings.name, root: this.cfg.root, recycle: this.cfg.recycle }, acc, this.space());
  }
  space() {
    try { const s = fs.statfsSync(this.cfg.root); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return { free: 0, total: 0 }; }
  }

  async list(acc, rel) {
    this._need(acc, false);
    const dir = this._abs(acc, rel);
    const out = [];
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name === BIN || e.name.endsWith('.velspart') || e.name.startsWith('~$') || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      try {
        const st = await fsp.stat(p);
        if (st.isDirectory()) { let count = 0; try { count = (await fsp.readdir(p)).filter(n => n !== BIN && !n.endsWith('.velspart')).length; } catch {} out.push({ name: e.name, dir: true, count, at: st.mtimeMs }); }
        else if (st.isFile()) out.push({ name: e.name, dir: false, size: st.size, at: st.mtimeMs });
      } catch {}
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { dir: cleanRel(rel), entries: out.slice(0, 5000), kids: acc.kids, level: acc.level };
  }
  async search(acc, q) {
    this._need(acc, false);
    q = String(q || '').trim().toLowerCase().slice(0, 100);
    if (!q) return { results: [] };
    const base = this._base(acc), results = [];
    let seen = 0;
    const walk = async (d, rel, depth) => {
      if (depth > 24 || results.length >= 200 || seen > 50000) return;
      let list; try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (++seen > 50000 || results.length >= 200) return;
        if (e.name === BIN || e.isSymbolicLink() || e.name.endsWith('.velspart')) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.name.toLowerCase().includes(q)) {
          try { const st = await fsp.stat(path.join(d, e.name)); results.push({ name: e.name, path: r, dir: e.isDirectory(), size: st.size, at: st.mtimeMs }); } catch {}
        }
        if (e.isDirectory()) await walk(path.join(d, e.name), r, depth + 1);
      }
    };
    await walk(base, '', 0);
    return { results };
  }
  async mkdir(acc, rel, name) {
    this._need(acc, true);
    const p = path.join(this._abs(acc, rel), cleanName(name));
    if (fs.existsSync(p)) throw new Error('There\'s already something with that name');
    await fsp.mkdir(p);
    return { ok: true };
  }
  async rename(acc, rel, name, who) {
    this._need(acc, true);
    const from = this._abs(acc, rel);
    if (from === path.resolve(this._base(acc)) || (!acc.kids && path.relative(this.cfg.root, from) === KIDS)) throw new Error('That folder can\'t be renamed');
    const to = path.join(path.dirname(from), cleanName(name));
    if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error('There\'s already something with that name');
    await fsp.rename(from, to);
    this.node.audit('info', 'nas', `${who} renamed "${path.basename(from)}" to "${path.basename(to)}" on the NAS`);
    return { ok: true };
  }
  async remove(acc, rels, who) {
    this._need(acc, true);
    if (!Array.isArray(rels) || !rels.length || rels.length > 500) throw new Error('Nothing selected');
    let n = 0;
    for (const rel of rels) {
      const abs = this._abs(acc, rel);
      if (abs === path.resolve(this._base(acc)) || (!acc.kids && path.relative(this.cfg.root, abs) === KIDS)) continue; // never the NAS itself or the Kids folder
      if (!fs.existsSync(abs)) continue;
      if (this.cfg.recycle) {
        const id = crypto.randomBytes(8).toString('hex');
        const binDir = path.join(this.cfg.root, BIN);
        await fsp.mkdir(binDir, { recursive: true });
        try { require('child_process').execFileSync('attrib', ['+h', binDir], { windowsHide: true, stdio: 'ignore' }); } catch {}
        await fsp.rename(abs, path.join(binDir, id));
        const idx = this._bin(); idx.push({ id, name: path.basename(abs), from: path.relative(this.cfg.root, abs).split(path.sep).join('/'), at: Date.now(), by: who, kids: acc.kids }); this._saveBin(idx);
      } else await this.node._toTrash(abs);
      n++;
    }
    if (n) this.node.audit('warn', 'nas', `${who} deleted ${n} item(s) on the NAS${this.cfg.recycle ? ' (in the NAS recycle bin for 30 days)' : ' (moved to the Recycle Bin)'}`);
    return { ok: true, count: n };
  }
  _binFile() { return path.join(this.cfg.root, BIN, 'index.json'); }
  _bin() { try { const a = JSON.parse(fs.readFileSync(this._binFile(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
  _saveBin(a) { fs.mkdirSync(path.dirname(this._binFile()), { recursive: true }); fs.writeFileSync(this._binFile(), JSON.stringify(a)); }
  bin(acc) {
    this._need(acc, false);
    return { items: this._bin().filter(x => !acc.kids || x.kids || x.from.startsWith(KIDS + '/')).map(x => ({ id: x.id, name: x.name, from: x.from, at: x.at, by: x.by, left: Math.max(0, Math.ceil((x.at + BIN_DAYS * 86400000 - Date.now()) / 86400000)) })) };
  }
  async restore(acc, ids) {
    this._need(acc, true);
    const idx = this._bin(); let n = 0;
    for (const id of ids) {
      const i = idx.findIndex(x => x.id === id); if (i < 0) continue;
      const x = idx[i];
      if (acc.kids && !(x.kids || x.from.startsWith(KIDS + '/'))) continue;
      let dest = path.resolve(this.cfg.root, cleanRel(x.from));
      if (!dest.startsWith(path.resolve(this.cfg.root) + path.sep)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) { const ext = path.extname(dest); dest = dest.slice(0, dest.length - ext.length) + ' (restored)' + ext; }
      await fsp.rename(path.join(this.cfg.root, BIN, x.id), dest);
      idx.splice(i, 1); n++;
    }
    this._saveBin(idx);
    return { ok: true, count: n };
  }
  async purge(acc, ids) {
    this._need(acc, true);
    const idx = this._bin(); const keep = [];
    for (const x of idx) {
      const mine = !acc.kids || x.kids || x.from.startsWith(KIDS + '/');
      if (mine && (ids === 'all' || (Array.isArray(ids) && ids.includes(x.id)))) await fsp.rm(path.join(this.cfg.root, BIN, x.id), { recursive: true, force: true });
      else keep.push(x);
    }
    this._saveBin(keep);
    return { ok: true, count: idx.length - keep.length };
  }
  async cleanBin() {
    if (!this.cfg.root || !fs.existsSync(this.cfg.root)) return;
    const idx = this._bin(), keep = [], cut = Date.now() - BIN_DAYS * 86400000;
    for (const x of idx) { if (x.at < cut) await fsp.rm(path.join(this.cfg.root, BIN, x.id), { recursive: true, force: true }).catch(() => {}); else keep.push(x); }
    if (keep.length !== idx.length) this._saveBin(keep);
  }
  // files on the NAS → that PC (it asked, so it accepts without a question)
  async get(acc, peerId, rels) {
    this._need(acc, false);
    if (!Array.isArray(rels) || !rels.length || rels.length > 500) throw new Error('Nothing selected');
    const paths = rels.map(r => this._abs(acc, r)).filter(p => fs.existsSync(p));
    if (!paths.length) throw new Error('Those files are gone');
    return this.node.sendFiles(peerId, paths, { pull: true });
  }
  // a PC uploads files into a NAS folder
  incomingOffer(peerId, m, ids) {
    const node = this.node, peer = node.peers[peerId];
    let dir;
    try {
      const handover = m.pull === true && (node._expect.get(peerId) || 0) > Date.now(); // the old NAS PC hands its files over
      const acc = handover ? { level: 'full', kids: false } : this.accessFor(peerId, m.kid === true);
      this._need(acc, true);
      dir = this._abs(acc, m.nasDir);
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      node.audit('warn', 'nas', `Refused NAS upload from ${peer.name}: ${e.message}`);
      return node.answerFiles(m.batchId, false, e.message);
    }
    node.audit('info', 'nas', `${peer.name} is saving ${ids.length} file(s) to the NAS`);
    return node.answerFiles(m.batchId, true, '', dir);
  }

  // ---------- the other side: a PC using a NAS on another PC ----------
  hostElsewhere() {
    for (const [id, r] of Object.entries(this.node.remote)) if (r.nas && this.node.peers[id] && id !== this.node.id) return { id, name: this.node.peers[id].name, label: r.nas.label, online: !!this.node.conns[id] };
    return null;
  }

  // ---------- move the NAS to this PC from another PC ----------
  async takeOver(root, mode, pin) {
    const old = this.hostElsewhere();
    if (!old) return this.setup(root, {});
    if (!old.online) throw new Error(`${old.name} is offline. Turn it on to move the NAS.`);
    if (!['copy', 'empty'].includes(mode)) throw new Error('Bad choice');
    if (!this.planOk()) throw new Error(`The NAS is part of Pro${this.node._upsellNas()}`);
    this.node._requireAdmin();
    root = this._checkRoot(root);
    // ask the old NAS first, then become the NAS
    const r = await this.node._rpc(old.id, 'nas.handover', { mode, pin }, 6 * 60000);
    if (!r || !r.ok) throw new Error('The NAS PC said no');
    if (mode === 'copy' && r.bytes + 200 * 1024 * 1024 > this.node._freeSpace(root)) {
      throw new Error('Not enough free space in that folder for everything on the NAS');
    }
    await this.setup(root, { takeOver: true });
    if (mode === 'copy') {
      this.node._expect.set(old.id, Date.now() + 6 * 3600000);
      await this.node._rpc(old.id, 'nas.sendall', {}, 60000);
    }
    return this.view();
  }
  // on the old NAS PC: someone wants to move the NAS away from here
  async handoverIn(peerId, a) {
    if (!this.cfg.root) throw new Error('This PC is not the NAS');
    const peer = this.node.peers[peerId];
    let ok = this.node.mainId ? await this.node._familyOk(peerId, a.pin) : false;
    if (!ok) {
      if (this.node.mainId) throw new Error('Enter the main PC passcode first');
      const r = await this.node._askUser('files', peerId, { action: 'nasmove', names: [this.label()], count: 1, targetName: peer.name, mode: a.mode }, 5 * 60000);
      if (!r.ok) throw new Error(r.timeout ? 'Nobody answered on the NAS PC' : 'The NAS PC said no');
    }
    this._handTo = { peerId, until: Date.now() + 10 * 60000, root: this.cfg.root };
    const bytes = a.mode === 'copy' ? this._size(this.cfg.root) : 0;
    this.node.audit('info', 'nas', `The NAS is moving to ${peer.name}${a.mode === 'copy' ? ' (copying the files)' : ''}. Files stay in ${this.cfg.root} on this PC too.`);
    this.cfg.root = ''; this._save(); this._announce();
    return { ok: true, bytes };
  }
  async sendAllIn(peerId) {
    const h = this._handTo;
    if (!h || h.peerId !== peerId || h.until < Date.now()) throw new Error('No NAS move in progress');
    this._handTo = null;
    const files = [];
    const walk = async (d, depth) => {
      if (depth > 32) return;
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        if (e.name === BIN || e.isSymbolicLink() || e.name.endsWith('.velspart')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p, depth + 1); else if (e.isFile()) files.push(p);
      }
    };
    await walk(h.root, 0);
    for (let i = 0; i < files.length; i += 4000) await this.node.sendFiles(peerId, files.slice(i, i + 4000), { pull: true, nasDir: '', relFrom: h.root });
    return { ok: true, count: files.length };
  }

  view() {
    const host = this.cfg.root ? { here: true, root: this.cfg.root, label: this.label(), active: this.active(), missing: !!this.cfg.root && !fs.existsSync(this.cfg.root), recycle: this.cfg.recycle, awake: this.cfg.awake, askNew: this.cfg.askNew, space: this.active() ? this.space() : null,
      access: Object.values(this.node.peers).map(p => Object.assign({ id: p.id, name: p.name }, this.accessFor(p.id))) } : null;
    return { feature: this.planOk(), host, elsewhere: host ? null : this.hostElsewhere() };
  }
}

module.exports = { Nas, cleanRel, cleanName, BIN, KIDS };
