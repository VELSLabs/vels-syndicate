// VELS Syndicate — phone page. Talks only to the PC that served it.
// Encryption: NaCl secretbox (tweetnacl). The pairing code never leaves this phone: it is turned
// into a lookup token + a key, exactly like the PC does (src/core/phones.js).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var enc = new TextEncoder(), dec = new TextDecoder();
  var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  var KIND = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) ? 'iPad' : /iPhone|iPod/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? (/Mobile/.test(navigator.userAgent) ? 'Android phone' : 'Android tablet') : 'phone';
  var CHUNK = 1024 * 1024;
  var CODE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  // ---------- storage (localStorage if "Remember this phone", else this tab only) ----------
  function store(remember) { try { return remember ? window.localStorage : window.sessionStorage; } catch (e) { return null; } }
  function loadCreds() {
    var a = [store(true), store(false)];
    for (var i = 0; i < a.length; i++) { try { var s = a[i] && a[i].getItem('vels:phone'); if (s) { var c = JSON.parse(s); if (c && c.id && c.key) { c.k = b64d(c.key); return c; } } } catch (e) {} }
    return null;
  }
  function saveCreds(c) { var s = store(c.remember); try { s && s.setItem('vels:phone', JSON.stringify({ id: c.id, key: c.key, pcName: c.pcName, name: c.name, remember: c.remember })); } catch (e) {} }
  function clearCreds() { [store(true), store(false)].forEach(function (s) { try { s && s.removeItem('vels:phone'); } catch (e) {} }); }
  function pref(k, v) { try { if (v === undefined) return localStorage.getItem('vels:' + k); localStorage.setItem('vels:' + k, v); } catch (e) { return null; } }

  // ---------- bytes ----------
  function b64e(u8) { var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function b64d(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function hex(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
  function rnd(n) { return hex(nacl.randomBytes(n)); }
  function concat(list) { var n = 0, i; for (i = 0; i < list.length; i++) n += list[i].length; var out = new Uint8Array(n), o = 0; for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; } return out; }
  function frame(obj, data) {
    var j = enc.encode(JSON.stringify(obj)), len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, j.length);
    return data && data.length ? concat([len, j, data]) : concat([len, j]);
  }
  function unframe(u8) {
    if (!u8 || u8.length < 4) return null;
    var n = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0);
    if (4 + n > u8.length) return null;
    try { return { obj: JSON.parse(dec.decode(u8.subarray(4, 4 + n))), data: u8.subarray(4 + n) }; } catch (e) { return null; }
  }
  function seal(key, bytes) { var nonce = nacl.randomBytes(24); return concat([nonce, nacl.secretbox(bytes, nonce, key)]); }
  function open(key, u8) { if (!u8 || u8.length < 40) return null; return nacl.secretbox.open(u8.subarray(24), u8.subarray(0, 24), key); }
  function normCode(s) { return String(s || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, ''); }
  function derive(code) {
    var h = nacl.hash(enc.encode('vels-phone-pair-v1|' + normCode(code)));
    return { token: hex(h.subarray(0, 16)), key: h.slice(32, 64) };
  }
  function fmtBytes(n) { if (n < 1024) return n + ' B'; var u = ['KB', 'MB', 'GB', 'TB'], i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; }
  function kindOf(name) { var e = (String(name).split('.').pop() || '').toLowerCase(); if (/^(jpe?g|png|gif|heic|heif|webp|bmp|tiff?|avif)$/.test(e)) return 'img'; if (/^(mov|mp4|m4v|avi|mkv|webm|3gp)$/.test(e)) return 'vid'; if (/^(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/.test(e)) return 'aud'; return 'doc'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(d) { var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; }
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- colors: the PC's accent, light/dark from the phone's own setting ----------
  function hexRgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return null; var n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function mix(rgb, to, t) { return '#' + rgb.map(function (c) { return Math.round(c + (to - c) * t).toString(16).padStart(2, '0'); }).join(''); }
  var accentNow = '';
  function applyAccent(hex) {
    var rgb = hexRgb(hex); if (!rgb) return;
    hex = '#' + /([0-9a-f]{6})$/i.exec(hex)[1].toLowerCase();
    if (hex === accentNow) return;
    accentNow = hex;
    var r = document.documentElement.style;
    r.setProperty('--accent', hex);
    r.setProperty('--accent-rgb', rgb.join(', '));
    r.setProperty('--accent-hi', mix(rgb, 255, 0.4));  // brighter, for text on dark
    r.setProperty('--accent-lo', mix(rgb, 0, 0.3));    // deeper, for text on light
    pref('accent', hex);
  }
  function applyScheme() {
    var light = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches;
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', light ? '#f2f2f7' : '#121215');
  }
  applyAccent(pref('accent') || '#30d158'); // last color seen, so the page doesn't flash; VELS Green before that
  applyScheme();
  if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: light)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(applyScheme); }

  // ---------- views ----------
  function show(id) { ['vCode', 'vWait', 'vGone', 'vMain'].forEach(function (v) { $(v).classList.toggle('hidden', v !== id); }); $('helpBtn').classList.toggle('hidden', id !== 'vMain'); }

  // ---------- pairing ----------
  async function pairWith(code) {
    var n = normCode(code);
    if (n.length !== 20) { showCode('That code is 20 letters and numbers, like K7Q2-M9XF-3RTA-WPZ4-HN6C.'); return; }
    var d = derive(n), rid = rnd(12);
    show('vWait'); $('waitKind').textContent = KIND; $('waitErr').classList.add('hidden'); $('waitRetry').classList.add('hidden');
    var post = function (url, obj) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj), cache: 'no-store' }); };
    var box = function (o) { o.ts = Date.now(); return b64e(seal(d.key, frame(o))); };
    try {
      var r = await post('api/pair', { tok: d.token, box: box({ rid: rid, name: '' }) });
      if (!r.ok) { var j = {}; try { j = await r.json(); } catch (e) {} return waitFail(j.error || 'That code didn’t work.'); }
      for (var i = 0; i < 150; i++) {
        await wait(1200);
        var w = await post('api/pair-wait', { tok: d.token, box: box({ rid: rid }) });
        var s = await w.json();
        if (s.state === 'waiting') continue;
        if (s.state === 'approved') {
          var u = unframe(open(d.key, b64d(s.box)));
          if (!u) return waitFail('Something went wrong. Make a new code on the PC.');
          creds = { id: u.obj.phoneId, key: u.obj.key, k: b64d(u.obj.key), pcName: u.obj.pcName, name: u.obj.name, remember: u.obj.remember !== false };
          saveCreds(creds);
          return startMain();
        }
        if (s.state === 'denied') return waitFail('The PC didn’t allow this ' + KIND + '.');
        return waitFail('The code expired. Make a new one on the PC.');
      }
      waitFail('The PC didn’t answer. Make a new code and try again.');
    } catch (e) { waitFail('Can’t reach the PC. Is this ' + KIND + ' on the same Wi-Fi?'); }
  }
  function waitFail(msg) { $('waitErr').textContent = msg; $('waitErr').classList.remove('hidden'); $('waitRetry').classList.remove('hidden'); }
  function showCode(err) { show('vCode'); $('codeErr').classList.toggle('hidden', !err); $('codeErr').textContent = err || ''; }
  $('codeGo').onclick = function () { pairWith($('codeIn').value); };
  $('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') pairWith($('codeIn').value); });
  $('codeIn').addEventListener('input', function () { var v = normCode(this.value).slice(0, 20); this.value = (v.match(/.{1,4}/g) || []).join('-'); });
  $('waitRetry').onclick = function () { showCode(); };
  $('goneCode').onclick = function () { showCode(); };

  // ---------- encrypted requests ----------
  var creds = null;
  var quiet401 = false;
  async function api(op, obj, data) {
    var m = Object.assign({ op: op, ts: Date.now(), n: rnd(12) }, obj || {});
    var r = await fetch('api/x', { method: 'POST', headers: { 'X-Vels-Id': creds.id, 'Content-Type': 'application/octet-stream' }, body: seal(creds.k, frame(m, data)), cache: 'no-store' });
    if (r.status === 401) { if (quiet401) { clearCreds(); creds = null; } else lost('This ' + KIND + ' isn’t connected to the PC anymore.'); throw new Error('gone'); }
    if (r.status === 429) throw new Error('The PC is busy. Try again in a few minutes.');
    if (!r.ok) throw new Error('net');
    var u = unframe(open(creds.k, new Uint8Array(await r.arrayBuffer())));
    if (!u) throw new Error('net');
    if (u.obj.error) { var e = new Error(u.obj.error); e.server = true; throw e; }
    u.obj.data = u.data;
    return u.obj;
  }
  function lost(text) { clearCreds(); creds = null; $('goneText').textContent = text; show('vGone'); }

  // ---------- main screen ----------
  var info = null, online = true;
  async function startMain(scanToken) {
    show('vMain');
    $('connText').textContent = 'Connected to ';
    var b = el('b', null, creds.pcName || 'the PC'); $('connText').appendChild(b);
    try { await hello(scanToken); } catch (e) {}
    pollInbox();
    if (!pref('seen-welcome')) { pref('seen-welcome', '1'); help('welcome'); }
  }
  async function hello(scanToken) {
    info = await api('hi', scanToken ? { scan: scanToken } : null);
    if (info.accent) applyAccent(info.accent);
    applyTabs(info.tabs);
    creds.pcName = info.pcName; $('connText').lastChild.textContent = info.pcName;
    $('limitHint').textContent = info.maxFile ? 'The ' + info.plan + ' plan sends files up to ' + fmtBytes(info.maxFile) + ' each.' : '';
    var sel = $('toSel'), cur = sel.value; sel.textContent = '';
    var o = el('option', null, info.pcName + ' (PC)'); o.value = ''; sel.appendChild(o);
    info.phones.forEach(function (p) { var x = el('option', null, p.name); x.value = p.id; sel.appendChild(x); });
    sel.value = cur; if (sel.value !== cur) sel.value = '';
    $('toRow').classList.toggle('hidden', !info.phones.length);
    $('tabNas').classList.toggle('hidden', !info.nas);
    if (!info.nas && curTab === 'nas') tab('send');
    setOnline(true);
  }
  // tab names come from the PC (Settings → Appearance → Tab names); empty = default
  function applyTabs(t) {
    t = t || {};
    $('lblSend').textContent = t.send || 'Send';
    $('lblGet').textContent = t.get || 'Get';
    $('lblNas').textContent = t.nas || 'NAS';
  }
  function setOnline(v) { online = v; $('dot').classList.toggle('off', !v); }
  $('tabSend').onclick = function () { tab('send'); };
  $('tabGet').onclick = function () { tab('get'); };
  $('tabNas').onclick = function () { tab('nas'); };
  var curTab = 'send';
  function tab(t) {
    curTab = t;
    ['send', 'get', 'nas'].forEach(function (x) { var k = x[0].toUpperCase() + x.slice(1); $('tab' + k).classList.toggle('on', t === x); $('p' + k).classList.toggle('hidden', t !== x); });
    if (t === 'get') pollInbox(true);
    if (t === 'nas') nasLoad();
  }

  // ---------- the NAS (when this phone's PC is the NAS) ----------
  var nasDir = '', nasBusy = false;
  function nasDate(ts) { var d = new Date(ts), n = new Date(); if (d.toDateString() === n.toDateString()) return 'Today'; if (d.toDateString() === new Date(n - 86400000).toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  async function nasLoad() {
    var n = info && info.nas;
    $('nasHere').classList.toggle('hidden', !(n && n.here)); $('nasAway').classList.toggle('hidden', !!(n && n.here));
    if (!n) return;
    if (!n.here) { $('nasAway').textContent = 'The NAS (' + n.label + ') is on ' + n.host + '. To use it from this ' + KIND + ', open VELS Syndicate on ' + n.host + ', press Phone QR and scan the code.'; return; }
    var r;
    try { r = await api('nas-list', { dir: nasDir }); }
    catch (e) { if (e.message === 'gone') return; if (nasDir) { nasDir = ''; return nasLoad(); } $('nasList').textContent = ''; $('nasEmpty').classList.remove('hidden'); $('nasEmpty').textContent = e.server ? e.message : 'Couldn’t reach the PC.'; return; }
    var who = $('nasWhere'); who.textContent = 'On '; who.appendChild(el('b', null, info.pcName)); who.appendChild(document.createTextNode(' · ' + (r.level === 'full' ? 'Full access' : 'View only')));
    $('nasMeter').style.width = r.total ? ((r.total - r.free) / r.total * 100).toFixed(1) + '%' : '0';
    $('nasFree').textContent = r.total ? fmtBytes(r.free) + ' free of ' + fmtBytes(r.total) : '';
    var cr = $('nasCrumbs'); cr.textContent = '';
    var parts = nasDir ? nasDir.split('/') : [];
    var crumb = function (label, d, cur) { var b = el('button', cur ? 'cur' : null, label); b.type = 'button'; b.onclick = function () { nasDir = d; nasLoad(); }; cr.appendChild(b); };
    crumb(r.label, '', !parts.length);
    parts.forEach(function (p, i) { cr.appendChild(el('span', null, '›')); crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1); });
    var list = $('nasList'); list.textContent = '';
    r.entries.forEach(function (e) {
      var rel = nasDir ? nasDir + '/' + e.name : e.name;
      if (e.dir) {
        var row = el('button', 'row folder'); row.type = 'button';
        var th = el('div', 'th dir'); th.appendChild(svg('<path d="M4 7.5A2.5 2.5 0 016.5 5H10l2 2h5.5A2.5 2.5 0 0120 9.5v7a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5z"/>'));
        var t = el('div', 't'); t.appendChild(el('b', null, e.name)); t.appendChild(el('span', null, e.count + (e.count === 1 ? ' item' : ' items')));
        row.appendChild(th); row.appendChild(t); row.appendChild(el('span', 'chev', '›'));
        row.onclick = function () { nasDir = rel; nasLoad(); };
        list.appendChild(row);
      } else {
        var fr = fileRow(e.name, e.size); fr.sub.textContent = fmtBytes(e.size) + ' · ' + nasDate(e.at); fr.bar.classList.add('hidden');
        var b = el('button', 'dl', '↓ Get'); b.type = 'button';
        b.onclick = async function () {
          if (downloading) return alert('Wait for the current download to finish.');
          b.disabled = true; b.textContent = 'Getting…';
          try { var g = await api('nas-get', { paths: [rel] }); for (var i = 0; i < g.files.length; i++) await download(g.files[i]); }
          catch (err) { if (err.message !== 'gone') alert(err.server ? err.message : 'Couldn’t reach the PC.'); }
          b.disabled = false; b.textContent = '↓ Get';
        };
        fr.root.appendChild(b); list.appendChild(fr.root);
      }
    });
    $('nasEmpty').classList.toggle('hidden', r.entries.length > 0);
    $('nasEmpty').innerHTML = 'This folder is empty. Tap <b>Save to NAS</b> to add photos, videos or files.';
    document.querySelector('.nas-btns').classList.toggle('hidden', r.level !== 'full');
  }
  $('nasNew').onclick = async function () {
    var n = prompt('New folder name');
    if (!n) return;
    try { await api('nas-mkdir', { dir: nasDir, name: n }); nasLoad(); } catch (e) { if (e.message !== 'gone') alert(e.server ? e.message : 'Couldn’t reach the PC.'); }
  };
  $('inNas').onchange = function () {
    var dir = nasDir, files = this.files;
    for (var i = 0; i < files.length; i++) {
      var item = { file: files[i], to: null, nasDir: dir, have: 0, state: 'queued', row: fileRow(files[i].name, files[i].size) };
      $('nasUp').appendChild(item.row.root); queue.push(item);
    }
    this.value = '';
    runQueue().then(function () { if (curTab === 'nas') nasLoad(); });
  };

  // ---------- sending (phone → PC) ----------
  var queue = [], sending = false;
  function addFiles(list) {
    var to = $('toSel').value || null, toName = to ? $('toSel').selectedOptions[0].textContent : null;
    for (var i = 0; i < list.length; i++) {
      var f = list[i], item = { file: f, to: to, toName: toName, have: 0, state: 'queued', row: null };
      item.row = fileRow(f.name, f.size);
      if (info && info.maxFile && f.size > info.maxFile) { item.state = 'error'; setRow(item.row, 'Too big for the ' + info.plan + ' plan (' + fmtBytes(info.maxFile) + ' each)', true); }
      $('sendList').insertBefore(item.row.root, $('sendList').firstChild);
      queue.push(item);
    }
    $('sendHead').classList.remove('hidden');
    runQueue();
  }
  $('inPhotos').onchange = function () { addFiles(this.files); this.value = ''; };
  $('inFiles').onchange = function () { addFiles(this.files); this.value = ''; };
  function fileRow(name, size) {
    var root = el('div', 'row'), th = el('div', 'th ' + kindOf(name), kindOf(name) === 'doc' ? (String(name).split('.').pop() || '').slice(0, 4) : ''), t = el('div', 't');
    var nb = el('b', null, name), sub = el('span', null, fmtBytes(size) + ' · Waiting'), bar = el('div', 'bar'), fill = el('i');
    bar.appendChild(fill); t.appendChild(nb); t.appendChild(sub); t.appendChild(bar); root.appendChild(th); root.appendChild(t);
    return { root: root, sub: sub, bar: bar, fill: fill, size: size, t: t };
  }
  function setRow(r, text, bad, pct) {
    r.sub.textContent = text; r.sub.classList.toggle('bad', !!bad);
    if (pct == null) r.bar.classList.add('hidden'); else { r.bar.classList.remove('hidden'); r.fill.style.width = Math.max(1, Math.min(100, pct)) + '%'; }
  }
  function rowDone(r, text) { setRow(r, text); if (!r.root.querySelector('.ok')) r.root.appendChild(el('span', 'ok', '✓')); }
  function readSlice(file, start, end) {
    var blob = file.slice(start, end);
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(new Uint8Array(fr.result)); }; fr.onerror = function () { rej(fr.error); }; fr.readAsArrayBuffer(blob); });
  }
  async function runQueue() {
    if (sending) return;
    sending = true; $('keepOpen').classList.remove('hidden');
    try {
      for (;;) {
        var item = queue.find(function (q) { return q.state === 'queued'; });
        if (!item) break;
        await sendOne(item);
      }
    } finally { sending = false; $('keepOpen').classList.add('hidden'); }
  }
  async function sendOne(item) {
    var f = item.file, tries = 0;
    item.state = 'sending';
    for (;;) {
      try {
        var s = await api('up-start', Object.assign({ name: f.name, size: f.size, type: f.type || '', to: item.to }, typeof item.nasDir === 'string' ? { nasDir: item.nasDir } : {}));
        var off = s.have, fid = s.fid;
        while (off < f.size) {
          setRow(item.row, fmtBytes(off) + ' of ' + fmtBytes(f.size) + ' · ' + Math.floor(off / f.size * 100) + '%', false, off / f.size * 100);
          var data = await readSlice(f, off, Math.min(f.size, off + CHUNK));
          var r = await api('up-chunk', { fid: fid, off: off }, data);
          off = r.have; tries = 0; setOnline(true);
        }
        await api('up-end', { fid: fid });
        item.state = 'done';
        rowDone(item.row, fmtBytes(f.size) + ' · ' + (typeof item.nasDir === 'string' ? 'Saved to the NAS' : item.to ? 'Sent to ' + item.toName : 'Sent'));
        return;
      } catch (e) {
        if (e.message === 'gone') { item.state = 'error'; return; }
        if (e.server) { item.state = 'error'; setRow(item.row, e.message, true); return; }
        // connection dropped (screen locked, Wi-Fi blip): wait and continue where it stopped
        setOnline(false);
        if (++tries > 40) { item.state = 'error'; setRow(item.row, 'Couldn’t reach the PC. Pick the file again to continue.', true); return; }
        setRow(item.row, 'Waiting for the PC… it will continue by itself', false, null);
        await wait(Math.min(15000, 1500 * tries));
      }
    }
  }

  // ---------- getting (PC → phone) ----------
  var inbox = [], downloading = null, pollTimer = null;
  function doneList() { try { return JSON.parse(pref('done') || '[]'); } catch (e) { return []; } }
  async function pollInbox(now) {
    clearTimeout(pollTimer);
    if (!creds) return;
    if (document.visibilityState === 'visible' || now) {
      try { var r = await api('inbox'); inbox = r.files; if (r.accent) applyAccent(r.accent); applyTabs(r.tabs); setOnline(true); renderGet(); }
      catch (e) { if (e.message === 'gone') return; setOnline(false); }
    }
    pollTimer = setTimeout(pollInbox, 3000);
  }
  function renderGet() {
    $('getCount').textContent = inbox.length ? '(' + inbox.length + ')' : '';
    var list = $('getList'); list.textContent = '';
    inbox.forEach(function (f) {
      var r = fileRow(f.name, f.size);
      r.sub.textContent = fmtBytes(f.size) + ' · from ' + f.from; r.bar.classList.add('hidden');
      var b = el('button', 'dl', '↓ Download'); b.type = 'button';
      if (downloading && downloading.fid === f.fid) { b.disabled = true; b.textContent = 'Saving…'; downloading.row = r; setRow(r, downloading.text || 'Starting…', false, downloading.pct); }
      else if (downloading) b.disabled = true;
      b.onclick = function () { download(f); };
      r.root.appendChild(b); list.appendChild(r.root);
    });
    $('getEmpty').classList.toggle('hidden', inbox.length > 0);
    var done = doneList(), dl = $('doneList'); dl.textContent = '';
    done.slice(0, 15).forEach(function (d) { var r = fileRow(d.name, d.size); rowDone(r, fmtBytes(d.size) + ' · ' + (IS_IOS ? 'in Files › Downloads' : 'in Downloads')); r.bar.classList.add('hidden'); dl.appendChild(r.root); });
    $('doneHead').classList.toggle('hidden', !done.length);
  }
  async function download(f) {
    if (downloading) return;
    if (info && f.size > info.maxDownload) { alert('This file is too big to download on a phone page.'); return; }
    downloading = { fid: f.fid, pct: 0, text: 'Starting…' }; renderGet(); $('keepOpen').classList.remove('hidden');
    var parts = [], off = 0, tries = 0;
    try {
      while (off < f.size) {
        try {
          var r = await api('dl-chunk', { fid: f.fid, off: off, len: CHUNK });
          if (!r.data.length) break;
          parts.push(new Uint8Array(r.data)); off += r.data.length; tries = 0;
          downloading.pct = off / f.size * 100; downloading.text = fmtBytes(off) + ' of ' + fmtBytes(f.size) + ' · ' + Math.floor(downloading.pct) + '%';
          if (downloading.row) setRow(downloading.row, downloading.text, false, downloading.pct);
        } catch (e) {
          if (e.server || e.message === 'gone') throw e;
          if (++tries > 30) throw new Error('Couldn’t reach the PC. Try again.');
          await wait(Math.min(10000, 1000 * tries));
        }
      }
      if (off !== f.size) throw new Error('The download stopped early. Try again.');
      saveBlob(new Blob(parts, { type: 'application/octet-stream' }), f.name);
      try { await api('dl-done', { fid: f.fid }); } catch (e) {}
      var done = doneList(); done.unshift({ name: f.name, size: f.size, at: Date.now() }); pref('done', JSON.stringify(done.slice(0, 30)));
      inbox = inbox.filter(function (x) { return x.fid !== f.fid; });
      downloading = null; renderGet();
      var k = kindOf(f.name);
      if ((k === 'img' || k === 'vid') && !pref('hide-photos')) setTimeout(function () { help('photos'); }, 700);
      else if (!pref('hide-where')) setTimeout(function () { help('where'); }, 700);
    } catch (e) {
      downloading = null; renderGet();
      if (e.message !== 'gone') alert(e.message || 'The download failed.');
    } finally { if (!sending) $('keepOpen').classList.add('hidden'); }
  }
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && creds) { hello().catch(function () {}); pollInbox(true); } });

  // ---------- help pop-ups ----------
  var I = {
    files: '<path d="M4 7.5A2.5 2.5 0 016.5 5H10l2 2h5.5A2.5 2.5 0 0120 9.5v7a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5z"/>',
    share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M7 10H6a2 2 0 00-2 2v7a2 2 0 002 2h12a2 2 0 002-2v-7a2 2 0 00-2-2h-1"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
    down: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    screen: '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>',
  };
  function step(n, pic, picCls, title, sub) {
    var s = el('div', 'step'), p = el('div', 'pic ' + (picCls || ''));
    if (pic.charAt(0) === '<') p.appendChild(svg(pic)); else p.textContent = pic;
    var t = el('div'); t.appendChild(el('b', null, title)); if (sub) t.appendChild(el('span', 's', sub));
    s.appendChild(el('div', 'num', String(n))); s.appendChild(p); s.appendChild(t); return s;
  }
  var TOPICS = {
    photos: function (b) {
      if (IS_IOS) {
        b.appendChild(el('h3', null, 'Put it in your Photos'));
        b.appendChild(el('p', null, 'iPhone saves downloads in the Files app. Moving it to Photos takes 3 taps:'));
        b.appendChild(step(1, I.files, 'sky', 'Open the file', 'Files app › Downloads (or tap the download arrow in Safari)'));
        b.appendChild(step(2, I.share, 'blue', 'Tap Share', 'The square with the arrow up'));
        b.appendChild(step(3, 'Save Video', '', 'Tap Save Video', 'or Save Image for photos. Done!'));
      } else {
        b.appendChild(el('h3', null, 'Where’s my photo or video?'));
        b.appendChild(el('p', null, 'Android saves it in your Downloads folder. Your Gallery or Photos app usually shows it too:'));
        b.appendChild(step(1, I.down, 'green', 'Open Downloads', 'From the notification, or the Files app'));
        b.appendChild(step(2, I.photo, 'sky', 'Or open Gallery / Photos', 'Look in the Downloads album'));
      }
      return 'hide-photos';
    },
    where: function (b) {
      b.appendChild(el('h3', null, 'Where did it go?'));
      if (IS_IOS) {
        b.appendChild(el('p', null, 'iPhone keeps downloads in the Files app:'));
        b.appendChild(step(1, I.files, 'sky', 'Open the Files app', 'Then Browse › Downloads'));
        b.appendChild(step(2, '♫', '', 'Music plays right there', 'iPhone doesn’t let other apps add songs to Apple Music'));
      } else {
        b.appendChild(el('p', null, 'Android keeps downloads in the Downloads folder:'));
        b.appendChild(step(1, I.down, 'green', 'Open Downloads', 'From the notification, or the Files app'));
      }
      return 'hide-where';
    },
    send: function (b) {
      b.appendChild(el('h3', null, 'Sending to the PC'));
      b.appendChild(step(1, I.photo, 'sky', 'Tap Photos & videos', IS_IOS ? 'Tap Select (top right) to pick several at once' : 'Long-press to pick several at once'));
      b.appendChild(step(2, I.screen, '', 'Keep this screen open', 'Phones pause web pages in the background. If it stops, it continues where it left off'));
      b.appendChild(step(3, I.files, '', 'Find them on the PC', 'In the received files folder (Files tab › Received files)'));
      return null;
    },
    welcome: function (b) {
      b.appendChild(el('h3', null, 'You’re connected'));
      b.appendChild(el('p', null, 'This ' + KIND + ' can now send files to ' + (creds && creds.pcName || 'the PC') + ' and get files it sends you. Everything is encrypted on your home Wi-Fi.'));
      b.appendChild(step(1, I.share, 'blue', IS_IOS ? 'Add to Home Screen' : 'Add a shortcut', IS_IOS ? 'Share › Add to Home Screen, to open VELS like an app' : 'Menu ⋮ › Add to Home screen'));
      return null;
    },
    menu: function (b) {
      b.appendChild(el('h3', null, 'Help'));
      var list = el('div', 'help-list');
      [['Put photos and videos in my Photos', 'photos'], ['Where do downloads go?', 'where'], ['How do I send to the PC?', 'send']].forEach(function (x) { var btn = el('button', null, x[0]); btn.type = 'button'; btn.onclick = function () { help(x[1], true); }; list.appendChild(btn); });
      b.appendChild(list);
      return null;
    },
  };
  function help(topic, fromMenu) {
    var body = $('sheetBody'); body.textContent = '';
    var key = TOPICS[topic](body);
    var chk = null;
    if (key && !fromMenu) { var lab = el('label', 'chk'); chk = el('input'); chk.type = 'checkbox'; lab.appendChild(chk); lab.appendChild(document.createTextNode('Don’t show this again')); body.appendChild(lab); }
    var ok = el('button', 'btn primary', 'Got it'); ok.type = 'button'; body.appendChild(ok);
    var close = function () { if (key && chk && chk.checked) pref(key, '1'); $('sheet').classList.add('hidden'); $('dim').classList.add('hidden'); document.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    ok.onclick = close; $('sheetX').onclick = close; $('dim').onclick = close;
    document.addEventListener('keydown', esc);
    $('sheet').classList.remove('hidden'); $('dim').classList.remove('hidden');
  }
  $('helpBtn').onclick = function () { help('menu'); };
  $('byeBtn').onclick = async function () {
    if (!confirm('Disconnect this ' + KIND + ' from ' + (creds.pcName || 'the PC') + '? You can connect again with a new code.')) return;
    try { await api('bye'); } catch (e) {}
    lost('This ' + KIND + ' was disconnected.');
  };

  // ---------- start ----------
  var hash = location.hash.replace(/^#/, '');
  if (hash) history.replaceState(null, '', location.pathname); // don't keep the code in history
  creds = loadCreds();
  if (hash && normCode(hash).length === 20 && creds) {
    // already connected: scanning the QR just opens the page (and tells the PC, which closes its QR window)
    quiet401 = true;
    api('hi', { scan: derive(hash).token }).then(function () { quiet401 = false; startMain(); }, function (e) {
      quiet401 = false;
      if (e.message === 'gone' || !creds) pairWith(hash); // this phone's old login is gone: connect again
      else startMain();
    });
  }
  else if (hash && normCode(hash).length === 20) pairWith(hash);
  else if (creds) startMain();
  else showCode();
})();
