'use strict';
/* VELS Syndicate — renderer */
const api = window.vels;
const I = window.ICONS;

let S = null;            // latest state from the node
let ENV = {};
let view = 'office';
let officeFilter = null;
let selTask = null;
let tTarget = null, tShell = 'powershell', fTarget = null;
let sheet = null;        // { id, el }
let lastSettingsKey = '';

const ACCENTS = { blue: '#0a84ff', purple: '#bf5af2', hotpink: '#ff2d95', pink: '#ff375f', crimson: '#e5484d', orange: '#ff9f0a', green: '#30d158', teal: '#40c8e0', graphite: '#8e8e93' };
const ACCENT_NAMES = { blue: 'Blue', purple: 'Purple', hotpink: 'Bright pink', pink: 'Rose', crimson: 'Crimson', orange: 'Orange', green: 'Green', teal: 'Teal', graphite: 'Graphite' };
const STATUSES = ['Idle', 'Waiting', 'Working', 'Busy'];
const SHELL_LABEL = { powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'Bash', sh: 'sh' };
const SHELL_PROMPT = { powershell: 'PS>', cmd: '>', bash: '$', sh: '$' };
const shellsFor = plat => plat === 'win32' ? ['powershell', 'cmd'] : plat ? ['bash', 'sh'] : ['powershell', 'cmd', 'bash'];
function platformOf(id) {
  if (!S) return null;
  if (id === S.self.id) return S.self.platform;
  const d = S.devices.find(x => x.id === id);
  return d ? d.platform : null;
}
const osWord = plat => plat === 'win32' ? 'Windows' : plat === 'linux' ? 'Linux' : plat === 'darwin' ? 'macOS' : '';
function presetsFor(plat) { return (S.settings.presets || []).map((p, i) => Object.assign({ i }, p)).filter(p => shellsFor(plat).includes(p.shell)); }
const isTrusted = d => d.perms && (d.perms.tasks === 'allow' || d.perms.files === 'allow');
const ROLE_IDEAS = ['Render node', 'Storage', 'Build server', 'AI brain', 'Gaming', 'Backup', 'Media'];

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = n => { if (!n && n !== 0) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = +n; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i]; };
const fmtDur = ms => { if (ms == null || ms < 0) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const fmtUptime = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };
const stripAnsi = t => String(t).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
const heat = p => p >= 85 ? 'hot' : p >= 65 ? 'warm' : '';

function toast(text, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<i></i><span>${esc(text)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}
async function act(promise, okText) {
  try { const v = await promise; if (okText) toast(okText, 'ok'); return v; }
  catch (e) { toast(e.message || String(e), 'err', 5200); return undefined; }
}

function allDesks() {
  if (!S) return [];
  const me = Object.assign({}, S.self, { isSelf: true, connected: true, paired: true, latency: null });
  return [me, ...S.devices.filter(d => d.paired)];
}
function nameOf(id) {
  if (!S) return '';
  if (id === S.self.id) return S.self.name + ' (this PC)';
  const d = S.devices.find(x => x.id === id);
  return d ? d.name : 'Unknown PC';
}
function onlineTargets() { return allDesks().filter(d => d.isSelf || d.connected); }

// ---------- smooth updates ----------
// Instead of rebuilding a whole section on every refresh (which restarts animations, drops hover
// states and makes bars jump), we compare the new HTML with what's on screen and only touch the
// parts that changed.
const HTML_PROP = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
function sameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.tagName === b.tagName && a.getAttribute('data-id') === b.getAttribute('data-id') && a.getAttribute('data-key') === b.getAttribute('data-key');
}
function patchNode(a, b) {
  if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') return;
  morphChildren(a, b);
}
function morphChildren(a, b) {
  const want = [...b.childNodes];
  want.forEach((bn, i) => {
    const an = a.childNodes[i];
    if (!an) a.appendChild(bn);
    else if (sameNode(an, bn)) patchNode(an, bn);
    else a.replaceChild(bn, an);
  });
  while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
}
function morphable(el) {
  if (!el || el.__morph) return el;
  el.__morph = true;
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return HTML_PROP.get.call(this); },
    set(html) {
      if (!this.firstChild) return HTML_PROP.set.call(this, html);
      const tpl = document.createElement('template');
      HTML_PROP.set.call(tpl, html);
      morphChildren(this, tpl.content);
    },
  });
  return el;
}
const MORPH_IDS = ['oSum', 'oDesks', 'cNearby', 'cPaired', 'tTargets', 'tShell', 'tPresets', 'tList', 'fTargets', 'fList', 'secCards', 'secBlocked', 'secLog', 'famSelf', 'famKids', 'shHead', 'shStatus', 'shShell', 'shPresets', 'shTasks', 'shFiles', 'shKv'];
function makeMorphable(root) { for (const id of MORPH_IDS) { const el = root.querySelector('#' + id); if (el) morphable(el); } }

// ---------- theme ----------
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', !!dark);
  document.documentElement.classList.toggle('light', !dark);
}
function applyAccent() {
  const a = ACCENTS[(S && S.settings.accent) || 'blue'] || ACCENTS.blue;
  document.documentElement.style.setProperty('--accent', a);
}

// ---------- nav ----------
const NAV = [
  { id: 'office', label: 'Office', icon: 'office' },
  { id: 'connections', label: 'Connections', icon: 'link' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'family', label: 'Family', icon: 'family' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
function renderNav() {
  const nearbyNew = S ? S.devices.filter(d => !d.paired && d.nearby).length : 0;
  const running = S ? S.tasks.filter(t => ['running', 'pending', 'queued', 'sent'].includes(t.state)).length : 0;
  const moving = S ? S.transfers.filter(t => ['sending', 'receiving', 'queued', 'offered', 'verifying'].includes(t.state)).length : 0;
  const online = S ? S.devices.filter(d => d.connected).length + 1 : 1;
  const alerts = S ? S.security.log.filter(e => e.level === 'alert' && Date.now() - e.ts < 86400000).length : 0;
  const kidsOnline = S ? S.devices.filter(d => d.monitored && d.connected).length : 0;
  const extra = { family: kidsOnline ? `<span class="count">${kidsOnline}</span>` : '', security: alerts ? `<span class="badge" style="background:#ff453a">${alerts}</span>` : '', office: `<span class="count">${online}</span>`, connections: nearbyNew ? `<span class="badge">${nearbyNew}</span>` : '', tasks: running ? `<span class="badge">${running}</span>` : '', files: moving ? `<span class="badge">${moving}</span>` : '' };
  $('#nav').innerHTML = NAV.map(n => `<button class="nav-item ${view === n.id ? 'active' : ''}" data-act="nav" data-view="${n.id}">${I[n.icon]}<span>${n.label}</span>${extra[n.id] || ''}</button>`).join('');
  if (S) {
    $('.brand-sub').textContent = S.plan && S.plan.tier !== 'free' ? `Syndicate · ${S.plan.name}` : 'Syndicate';
    const me = S.self;
    $('#meCard').innerHTML = `<div class="n"><span class="dot ${me.status}"></span>${esc(me.name)}</div><div class="s">This PC · ${esc(me.status)}${me.role ? ' · ' + esc(me.role) : ''}</div>`;
    $('#meCard').dataset.act = 'open-desk'; $('#meCard').dataset.id = me.id;
    if (me.monitor && me.monitor.enabled) $('#meCard').innerHTML += `<div class="shared">${I.eye}Activity shared with ${esc(me.monitor.parentName || 'parent PC')}</div>`;
  }
}

// ---------- views ----------
const Views = {};

Views.office = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Office</h1><div class="sub" id="oSub"></div></div>
        <div class="actions"><button class="btn" data-act="nav" data-view="connections">${I.plus}Add a PC</button></div></div>
      <div class="summary" id="oSum"></div>
      <div class="desks" id="oDesks"></div></div>`;
  },
  update() {
    const desks = allDesks();
    const counts = { Idle: 0, Waiting: 0, Working: 0, Busy: 0, Offline: 0 };
    desks.forEach(d => counts[d.status] = (counts[d.status] || 0) + 1);
    const online = desks.filter(d => d.connected).length;
    $('#oSub').textContent = `${desks.length} computer${desks.length === 1 ? '' : 's'} · ${online} online · drag files onto a desk to send them`;
    $('#oSum').innerHTML = [...STATUSES, 'Offline'].map(s => `<div class="sum ${officeFilter === s ? 'on' : ''}" data-act="filter" data-s="${s}"><span class="dot ${s}"></span><b>${counts[s] || 0}</b><span>${s}</span></div>`).join('');
    const shown = desks.filter(d => !officeFilter || d.status === officeFilter);
    $('#oDesks').innerHTML = shown.map(deskCard).join('') + (officeFilter ? '' : `<div class="desk add" data-act="nav" data-view="connections"><div class="in">${I.plus}<span>Pair another PC</span></div></div>`);
  },
};

function meter(label, p, sub) {
  const v = Math.max(0, Math.min(100, Math.round(p || 0)));
  return `<div class="meter"><div class="lbl"><span>${label}</span><b>${sub != null ? sub : v + '%'}</b></div><div class="bar"><i class="${heat(v)}" style="width:${v}%"></i></div></div>`;
}
function deskMeters(st) {
  if (!st) return `<div class="meters">${meter('CPU', 0, '—')}${meter('RAM', 0, '—')}${meter('GPU', 0, '—')}</div>`;
  const ram = st.ramTotal ? st.ramUsed / st.ramTotal * 100 : 0;
  return `<div class="meters">${meter('CPU', st.cpu)}${meter('RAM', ram)}${st.gpu ? meter('GPU', st.gpu.util) : meter('GPU', 0, 'n/a')}</div>`;
}
function deskCard(d) {
  const st = d.stats;
  const meta = [d.role || (d.isSelf ? 'No role yet' : ''), osWord(d.platform || (st && st.platform)), d.isSelf ? (st && st.ips && st.ips[0]) || '' : d.host].filter(Boolean).join(' · ');
  const foot = d.status === 'Offline'
    ? `<span>${d.connecting ? 'Connecting…' : 'Not reachable'}</span>`
    : d.activeTask ? `${I.bolt.replace('<svg', '<svg width="14" height="14"')}<span class="task">${esc(d.activeTask)}</span>${d.queued ? `<span class="tag gray">+${d.queued} queued</span>` : ''}`
    : `<span>${d.status === 'Idle' ? 'Ready for work' : d.status === 'Waiting' ? 'Waiting for input' : d.status === 'Busy' ? 'Do not disturb' : ''}</span>`;
  return `<div class="desk s-${d.status} ${d.connected ? '' : 'offline'}" data-act="open-desk" data-id="${esc(d.id)}" data-drop="${d.isSelf ? '' : esc(d.id)}">
    <div class="desk-top"><div class="monitor">${I.desktop}<span class="dot ${d.status}"></span></div>
      <div style="min-width:0"><div class="desk-name">${esc(d.name)}${isTrusted(d) ? `<span title="Trusted">${I.shield.replace('<svg', '<svg width="14" height="14" style="color:var(--c-idle)"')}</span>` : ''}</div>
      <div class="desk-meta">${d.isSelf ? '<span class="tag">This PC</span> ' : ''}${d.id === S.self.main.mainId ? '<span class="tag main">Main</span> ' : ''}${esc(meta) || '&nbsp;'}</div></div>
      <span class="pill ${d.status}">${d.status}</span></div>
    ${deskMeters(st)}
    <div class="desk-foot">${foot}${d.latency != null ? `<span class="lat">${d.latency} ms</span>` : ''}</div></div>`;
}

Views.connections = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Connections</h1><div class="sub">Request access to computers on your network. The other PC shows a 6-digit PIN that you type here.</div></div></div>
      <h2 class="sec" id="cNearbyH">Nearby</h2><div class="group" id="cNearby"></div>
      <h2 class="sec" id="cPairedH">Paired</h2><div class="group" id="cPaired"></div>
      <h2 class="sec">Connect by IP address</h2>
      <div class="card"><div class="line"><input class="field grow" id="ipHost" placeholder="192.168.1.25" spellcheck="false">
        <input class="field" id="ipPort" style="width:100px" placeholder="47821">
        <button class="btn primary" data-act="pair-ip">${I.link}Request access</button></div>
        <div class="small muted" style="margin-top:8px">Use this if a PC doesn't show up under Nearby (different subnet, or discovery blocked). The other PC must have VELS Syndicate open.</div></div></div>`;
    $('#ipHost').addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-act="pair-ip"]').click(); });
  },
  update() {
    const nearby = S.devices.filter(d => !d.paired && d.nearby);
    $('#cNearbyH').innerHTML = `Nearby <span class="spin"></span>`;
    $('#cNearby').innerHTML = nearby.length ? nearby.map(d => `<div class="row"><div class="ico">${I.desktop}</div>
        <div class="main"><div class="t">${esc(d.name)}</div><div class="d">${esc(d.host)} · not paired</div></div>
        <div class="end"><button class="btn primary sm" data-act="pair" data-id="${esc(d.id)}">Request access</button></div></div>`).join('')
      : `<div class="empty"><div class="big radar">${I.radar}</div><h3>Looking for computers…</h3><div class="small">Open VELS Syndicate on another PC on the same network.</div></div>`;
    const paired = S.devices.filter(d => d.paired), pl = S.plan, full = pl.pcCount >= pl.pcs;
    $('#cPairedH').innerHTML = `Paired <span class="sec-note ${full ? 'hot' : ''}">${pl.pcCount} of ${pl.pcs} PCs · ${esc(pl.name)}${full && pl.tier !== 'business' ? ` · <span class="link" data-act="nav" data-view="settings">Upgrade for more</span>` : ''}</span>`;
    const pseg = (d, kind, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${d.perms[kind] === v ? 'on' : ''}" data-act="perm" data-id="${esc(d.id)}" data-k="${kind}" data-v="${v}">${l}</button>`).join('')}</div>`;
    $('#cPaired').innerHTML = paired.length ? paired.map(d => `<div class="row" style="flex-wrap:wrap"><div class="ico">${I.desktop}</div>
        <div class="main"><div class="t">${esc(d.name)} <span class="pill ${d.connected ? 'Idle' : 'Offline'}"><span class="dot ${d.connected ? 'Idle' : ''}"></span>${d.connected ? 'Connected' : d.connecting ? 'Connecting…' : 'Offline'}</span>${d.platform ? `<span class="tag gray">${osWord(d.platform)}</span>` : ''}</div>
          <div class="d">${esc(d.host || 'address unknown')}${d.latency != null ? ' · ' + d.latency + ' ms' : ''}</div></div>
        <div class="end"><button class="btn sm danger" data-act="unpair" data-id="${esc(d.id)}">${I.trash}Remove access</button></div>
        <div class="perms"><span class="small muted">What ${esc(d.name)} may do on this PC:</span>
          <label>Run tasks ${pseg(d, 'tasks', [['ask', 'Ask'], ['allow', 'Allow'], ['never', 'Never']])}</label>
          <label>Send files ${pseg(d, 'files', [['ask', 'Ask'], ['allow', 'Allow'], ['never', 'Never']])}</label>
          <label>Change my status ${pseg(d, 'status', [['allow', 'Allow'], ['never', 'Never']])}</label></div></div>`).join('')
      : `<div class="empty"><h3>No paired computers yet</h3><div class="small">Pair one from the Nearby list above.</div></div>`;
  },
};

Views.tasks = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Tasks</h1><div class="sub">Run commands on any computer and watch the output live.</div></div>
        <div class="actions"><button class="btn" data-act="clear-tasks">${I.trash}Clear finished</button></div></div>
      <div class="cols"><div class="stack">
        <div class="card stack">
          <div><div class="label">Run on</div><div class="targets" id="tTargets"></div></div>
          <div class="line"><div class="seg" id="tShell"></div><span class="small muted" id="tOs"></span></div>
          <input class="field" id="tTitle" placeholder="Name this task (optional)">
          <textarea class="field" id="tCmd" rows="4" placeholder="Get-Process | Select-Object -First 10&#10;&#10;Ctrl + Enter to run" spellcheck="false"></textarea>
          <div class="chips" id="tPresets"></div>
          <div class="line"><button class="btn primary" data-act="run">${I.play}Run</button><button class="btn ghost sm" data-act="save-preset">Save as preset</button></div>
        </div>
        <div class="label" style="margin:6px 2px 0">Recent</div>
        <div class="task-list" id="tList"></div>
      </div>
      <div class="console" id="tConsole"></div></div></div>`;
    $('#tCmd').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('[data-act="run"]').click(); } });
    renderConsole(true);
  },
  update() {
    const targets = onlineTargets();
    if (!tTarget || !targets.some(t => t.id === tTarget)) tTarget = S.self.id;
    $('#tTargets').innerHTML = allDesks().map(d => `<button class="target ${tTarget === d.id ? 'on' : ''}" data-act="t-target" data-id="${esc(d.id)}" ${d.connected || d.isSelf ? '' : 'disabled'}><span class="dot ${d.status}"></span>${esc(d.name)}${d.isSelf ? ' (this PC)' : ''}</button>`).join('');
    const tPlat = platformOf(tTarget), tShells = shellsFor(tPlat);
    if (!tShells.includes(tShell)) tShell = tShells[0];
    $('#tShell').innerHTML = tShells.map(v => `<button class="${v === tShell ? 'on' : ''}" data-act="shell" data-v="${v}">${SHELL_LABEL[v]}</button>`).join('');
    $('#tOs').textContent = tPlat ? osWord(tPlat) + ' PC' : '';
    $('#tPresets').innerHTML = presetsFor(tPlat).map(p => `<span class="chip" data-act="preset" data-i="${p.i}">${I.terminal.replace('<svg', '<svg width="13" height="13"')}${esc(p.name)}<span class="x" data-act="del-preset" data-i="${p.i}">${I.x}</span></span>`).join('');
    $('#tList').innerHTML = S.tasks.length ? S.tasks.map(taskItem).join('') : `<div class="empty small">No tasks yet.</div>`;
    renderConsole(false);
  },
};
function taskItem(t) {
  const where = t.direction === 'in' ? `from ${esc(nameOf(t.peerId))}` : `on ${esc(nameOf(t.peerId))}`;
  const dur = t.startedAt ? fmtDur((t.endedAt || Date.now()) - t.startedAt) : '';
  return `<div class="titem ${selTask === t.id ? 'sel' : ''}" data-act="sel-task" data-id="${esc(t.id)}">
    <div class="l1"><span class="st ${t.state}">${t.state === 'sent' ? 'sending' : t.state}</span><span>${esc(t.title || SHELL_LABEL[t.shell] || 'Task')}</span><span class="who">${where}${dur ? ' · ' + dur : ''}</span></div>
    <div class="cmd">${t.direction === 'in' ? '⇠ ' : ''}${esc(t.cmd)}</div></div>`;
}
let consoleFor = null, consoleTok = 0;
async function renderConsole(force) {
  const box = $('#tConsole');
  if (!box) return;
  const t = S && S.tasks.find(x => x.id === selTask);
  if (!t) {
    if (consoleFor !== '__none' || force) {
      consoleFor = '__none';
      box.innerHTML = `<div class="bar-top"><span class="con-ico">${I.terminal}</span><span class="ttl">Output</span></div><div class="placeholder">${I.terminal.replace('<svg', '<svg width="34" height="34"')}<div style="margin-top:10px">Pick a task to see its output</div></div>`;
    }
    return;
  }
  const active = ['running', 'queued', 'pending', 'sent'].includes(t.state);
  const header = `<span class="con-ico">${I.terminal}</span><span class="ttl">${esc(t.title || t.cmd)} — ${esc(nameOf(t.peerId))}</span>
    <span class="st ${t.state}">${t.state}${t.code != null && !active ? ' · exit ' + t.code : ''}</span>
    ${active ? `<button class="btn sm" data-act="cancel-task" data-id="${esc(t.id)}">${I.stop}Stop</button>` : `<button class="btn sm" data-act="rerun" data-id="${esc(t.id)}">${I.play}Run again</button>`}`;
  if (consoleFor !== t.id || force) {
    consoleFor = t.id;
    const tok = ++consoleTok;
    box.innerHTML = `<div class="bar-top">${header}</div><pre id="tOut"><span class="cmdline">${SHELL_PROMPT[t.shell] || '>'} ${esc(t.cmd)}</span>\n</pre>`;
    const out = await api.taskOutput(t.id).catch(() => '');
    const pre = $('#tOut');
    if (pre && consoleFor === t.id && tok === consoleTok) { pre.appendChild(document.createTextNode(stripAnsi(out))); pre.scrollTop = pre.scrollHeight; }
    if (t.error && tok === consoleTok) appendOut(t.id, `\n${t.error}\n`);
  } else {
    box.querySelector('.bar-top').innerHTML = header;
  }
}
function appendOut(taskId, data) {
  if (consoleFor !== taskId) return;
  const pre = $('#tOut'); if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.appendChild(document.createTextNode(stripAnsi(data)));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

Views.files = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Files</h1><div class="sub">Send files and folders straight to another computer. Everything is encrypted on the way.</div></div>
        <div class="actions"><button class="btn" data-act="open-received">${I.folder}Received files</button><button class="btn" data-act="clear-transfers">${I.trash}Clear finished</button></div></div>
      <div class="card stack" style="margin-bottom:16px"><div class="label">Send to</div><div class="targets" id="fTargets"></div>
        <div class="dropzone" id="fDrop"><div class="big">${I.upload}</div><h3>Drop files or folders here</h3>
          <div class="muted small" style="margin-bottom:14px" id="fDropSub"></div>
          <div class="line" style="justify-content:center"><button class="btn primary" data-act="pick-files">Choose files…</button><button class="btn" data-act="pick-folder">Choose folder…</button></div></div></div>
      <div class="label" style="margin:0 2px 8px">Transfers</div><div class="group" id="fList"></div></div>`;
    const dz = $('#fDrop');
    dz.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); endDrag(); if (!fTarget) return toast('Pick a computer to send to first', 'warn'); sendDropped(fTarget, e.dataTransfer.files); });
  },
  update() {
    const remote = S.devices.filter(d => d.paired);
    if (fTarget && !remote.some(d => d.id === fTarget && d.connected)) fTarget = null;
    if (!fTarget) { const first = remote.find(d => d.connected); fTarget = first ? first.id : null; }
    $('#fTargets').innerHTML = remote.length ? remote.map(d => `<button class="target ${fTarget === d.id ? 'on' : ''}" data-act="f-target" data-id="${esc(d.id)}" ${d.connected ? '' : 'disabled'}><span class="dot ${d.status}"></span>${esc(d.name)}</button>`).join('')
      : `<span class="muted small">Pair a computer first in Connections.</span>`;
    $('#fDropSub').textContent = (fTarget ? `They'll arrive on ${nameOf(fTarget)}` : 'No computer online to send to') + ` · ${S.plan.name}: files ${fmtLimit(S.plan.maxFileBytes)} each`;
    $('#fList').innerHTML = S.transfers.length ? S.transfers.map(transferRow).join('') : `<div class="empty small">Nothing sent or received yet.</div>`;
  },
};
const speeds = {};
function transferRow(t) {
  const p = t.size ? Math.round(t.bytes / t.size * 100) : (t.state === 'done' ? 100 : 0);
  let rate = '';
  if (['sending', 'receiving'].includes(t.state)) {
    const prev = speeds[t.id], now = Date.now();
    if (prev && now - prev.at > 300) { const r = (t.bytes - prev.bytes) / ((now - prev.at) / 1000); speeds[t.id] = { at: now, bytes: t.bytes, rate: r }; }
    else if (!prev) speeds[t.id] = { at: now, bytes: t.bytes, rate: 0 };
    rate = speeds[t.id].rate ? ' · ' + fmtBytes(speeds[t.id].rate) + '/s' : '';
  }
  const who = S.devices.some(d => d.id === t.peerId) ? nameOf(t.peerId) : (t.peerName || 'a removed PC');
  const dir = t.direction === 'out' ? `To ${esc(who)}` : `From ${esc(who)}`;
  const when = t.endedAt || t.createdAt ? ` · ${ago(t.endedAt || t.createdAt)}` : '';
  const live = ['offered', 'queued', 'sending', 'receiving', 'verifying'].includes(t.state);
  const stateText = { offered: 'Waiting for approval', queued: 'Queued', sending: 'Sending', receiving: 'Receiving', verifying: 'Verifying', done: 'Done', failed: 'Failed', declined: 'Declined', cancelled: 'Cancelled' }[t.state] || t.state;
  return `<div class="row"><div class="ico">${t.direction === 'out' ? I.upload : I.folder}</div>
    <div class="main"><div class="t" style="font-weight:550">${esc(t.name)}</div>
      <div class="d">${dir} · ${t.state === 'done' ? fmtBytes(t.size) : `${fmtBytes(t.bytes)} of ${fmtBytes(t.size)}`} · ${stateText}${t.error ? ' — ' + esc(t.error) : ''}${rate}${when}</div>
      <div class="prog"><i class="${t.state === 'done' ? 'done' : ['failed', 'declined', 'cancelled'].includes(t.state) ? 'fail' : ''}" style="width:${p}%"></i></div></div>
    <div class="end">${live ? `<button class="btn sm icon" title="Cancel" data-act="cancel-transfer" data-id="${esc(t.id)}">${I.x}</button>` : ''}
      ${t.canOpen ? `<button class="btn sm" data-act="open-transfer" data-id="${esc(t.id)}" data-dir="${t.direction}" data-name="${esc(t.name)}">${I.open}Open</button><button class="btn sm ghost" data-act="show-transfer" data-id="${esc(t.id)}" title="Show in folder">${I.folder}</button>` : ''}</div></div>`;
}

Views.settings = {
  mount(el) { el.innerHTML = `<div class="view settings" id="setRoot"></div>`; lastSettingsKey = ''; },
  update() {
    const root = $('#setRoot');
    if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const s = S.settings;
    const key = JSON.stringify([s, S.self.name, S.self.role, ENV.dark, S.self.monitor, S.self.historyStorage, S.self.main, S.plan, S.devices.filter(d => d.paired).map(d => d.id)]);
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;
    const seg = (name, val, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${val === v ? 'on' : ''}" data-act="set" data-k="${name}" data-v="${v}">${l}</button>`).join('')}</div>`;
    const locked = S.self.monitor && S.self.monitor.enabled;
    const tog = (name, val) => `<button class="toggle ${val ? 'on' : ''}" data-act="set-toggle" data-k="${name}" ${locked && ['keepInTray', 'startWithWindows'].includes(name) ? 'disabled title="Required while activity sharing is on"' : ''}></button>`;
    const blurText = ENV.blur === 'acrylic' ? 'Windows 11 acrylic — your desktop shows through' : ENV.blur === 'vibrancy' ? 'System vibrancy' : ENV.platform === 'linux' ? 'Frosted glass' : 'Frosted glass (Windows 10 style)';
    root.innerHTML = `
      <div class="head"><div><h1>Settings</h1><div class="sub">Applies to this computer only.</div></div></div>
      <h2 class="sec">Plan</h2><div class="group">${planRows()}</div>
      <h2 class="sec">This PC</h2><div class="group">
        <div class="set-row"><div class="k"><b>Name</b><small>How other computers see this one</small></div><input class="field" id="sName" value="${esc(s.name)}" style="width:240px"></div>
        <div class="set-row"><div class="k"><b>Role</b><small>What this computer is for — shown on its desk</small></div><input class="field" id="sRole" value="${esc(S.self.role)}" placeholder="e.g. Render node" style="width:240px" list="roleIdeas"></div>
        <div class="set-row"><div class="k"><b>Status</b><small>Changes to Working on its own while tasks run</small></div>${statusSeg(S.self.id, S.self.manualStatus)}</div>
      </div>
      <datalist id="roleIdeas">${ROLE_IDEAS.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
      <h2 class="sec">Appearance</h2><div class="group">
        <div class="set-row"><div class="k"><b>Theme</b></div>${seg('theme', s.theme, [['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']])}</div>
        <div class="set-row"><div class="k"><b>Accent color</b></div><div class="swatches">${Object.entries(ACCENTS).map(([k, c]) => `<button class="sw ${s.accent === k ? 'on' : ''}" style="background:${c}" title="${ACCENT_NAMES[k] || k}" data-act="set" data-k="accent" data-v="${k}"></button>`).join('')}</div></div>
        <div class="set-row"><div class="k"><b>Glass</b><small>Picked automatically for this system</small></div><span class="muted small">${blurText}</span></div>
      </div>
      <h2 class="sec">Security</h2><div class="group">
        <div class="set-row"><div class="k"><b>Accept new connection requests</b><small>Turn off to stop other PCs from asking for access. Paired PCs still connect.</small></div>${tog('allowPairing', s.allowPairing !== false)}</div>
        <div class="set-row"><div class="k"><b>Local network only</b><small>Refuse connections from outside your home network (VPN ranges such as Tailscale still work)</small></div>${tog('lanOnly', s.lanOnly !== false)}</div>
        <div class="set-row"><div class="k"><b>Tasks from other computers</b><small>Trusted computers never need to ask</small></div>${seg('taskPolicy', s.taskPolicy, [['ask', 'Ask me'], ['deny', 'Block all']])}</div>
        <div class="set-row"><div class="k"><b>Incoming files</b><small>Trusted computers never need to ask</small></div>${seg('filePolicy', s.filePolicy, [['ask', 'Ask me'], ['auto', 'Accept all']])}</div>
        <div class="set-row"><div class="k"><b>Tasks at the same time</b><small>Extra tasks wait in a queue</small></div><div class="stepper"><button data-act="par" data-d="-1">−</button><span>${s.maxParallel}</span><button data-act="par" data-d="1">+</button></div></div>
      </div>
      <h2 class="sec">Files</h2><div class="group">
        <div class="set-row"><div class="k"><b>Save received files to</b><small style="user-select:text">${esc(s.receiveDir)}</small></div><button class="btn sm" data-act="pick-recv">Change…</button><button class="btn sm" data-act="open-received">Open</button></div>
      </div>
      <h2 class="sec">Main PC</h2><div class="group">${S.self.main.isMain ? `
        <div class="set-row"><div class="k"><b>This PC is the main (parent) PC</b><small>${S.self.main.digits}-digit passcode · protects security settings, the Family page and kids' parental settings${S.self.main.locked ? ' · locked' : ' · unlocked'}</small></div>${S.self.main.locked ? `<button class="btn sm" data-act="unlock">${I.lock}Unlock</button>` : `<button class="btn sm" data-act="lock-now">${I.lock}Lock now</button>`}<button class="btn sm" data-act="change-pass">Change passcode…</button><button class="btn sm danger" data-act="release-main">Stop being main</button></div>`
        : S.self.main.mainId ? `<div class="set-row"><div class="k"><b>Main PC: ${esc(S.self.main.mainName || 'unknown')}</b><small>${S.self.main.mainOnline ? 'Online' : 'Offline'} · its passcode protects parental controls on this PC</small></div></div>`
        : `<div class="set-row"><div class="k"><b>No main PC yet</b><small>The main (parent) PC gets a 4 or 6 digit passcode that protects settings and parental controls.</small></div><button class="btn sm" data-act="become-main">Make this PC the main PC…</button></div>`}
      </div>
      ${S.self.main.isMain ? `<h2 class="sec">Parental controls</h2><div class="group">
        <div class="set-row"><div class="k"><b>Describe websites in history</b><small>Shows a short line about what each website is. Popular sites are built in; others are looked up once from the site's home page and remembered.</small></div>${tog('describeSites', s.describeSites !== false)}</div>
        <div class="set-row"><div class="k"><b>Where history is saved</b><small>On each kid's PC, not on this one. Open Family → History to see how much space it uses or to delete it.</small></div></div>
      </div>` : `<h2 class="sec">Parental controls</h2><div class="group">${S.self.monitor.enabled ? `
        <div class="set-row"><div class="k"><b>Activity is shared with ${esc(S.self.monitor.parentName || 'the main PC')}</b><small>Apps, games${S.self.monitor.urls ? ', websites and pages' : ''} and times · history kept ${S.self.monitor.keepDays} days · protected by the main PC passcode</small></div><button class="btn sm" data-act="monitor-setup">${I.lock}Change…</button></div>
        <div class="set-row"><div class="k"><b>History saved on this PC</b><small>${S.self.historyStorage ? `${fmtBytes(S.self.historyStorage.bytes)} · ${S.self.historyStorage.days} day${S.self.historyStorage.days === 1 ? '' : 's'} · days older than ${S.self.historyStorage.keepDays} are deleted automatically` : '—'}</small></div><button class="btn sm" data-act="open-history-folder">${I.folder}Open folder</button></div>`
        : `<div class="set-row"><div class="k"><b>Share this PC's activity with the main PC</b><small>For a kid's computer: the main PC sees what's being played or watched, plus a daily history. Needs the main PC passcode.</small></div><button class="btn sm" data-act="monitor-setup" ${S.self.main.mainId ? '' : 'disabled'}>Set up…</button></div>`}
      </div>`}
      <h2 class="sec">System</h2><div class="group">
        <div class="set-row"><div class="k"><b>Keep running when the window is closed</b><small>Stays in the system tray so other computers can still reach it</small></div>${tog('keepInTray', s.keepInTray)}</div>
        <div class="set-row"><div class="k"><b>Start when I sign in</b><small>Opens quietly in the background when you sign in</small></div>${tog('startWithWindows', s.startWithWindows)}</div>
        <div class="set-row"><div class="k"><b>Firewall</b><small>${ENV.platform === 'linux' ? `Opens ports ${S.self.port} TCP and ${S.self.udpPort} UDP in ufw, for home-network addresses only. Asks for your password.` : `Allows VELS Syndicate on private networks (ports ${S.self.port} TCP, ${S.self.udpPort} UDP). Windows asks for admin approval.`}</small></div><button class="btn sm" data-act="firewall">${I.shield}Allow</button></div>
        <div class="set-row"><div class="k"><b>Device ID</b></div><code class="kcode">${esc(S.self.id)}</code></div>
      </div>
      <h2 class="sec">About</h2><div class="group">
        <div class="set-row"><div class="k"><b>VELS Syndicate</b><small>Version ${esc(ENV.version || '')}${ENV.portable ? ' · portable' : ''} · ${osWord(ENV.platform)} · © 2026 VELS Labs</small></div><button class="btn sm danger" data-act="quit">Quit completely</button></div>
      </div>`;
    const commit = (id, fn) => { const inp = $(id); inp.addEventListener('change', fn); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); }); };
    commit('#sName', () => act(api.settings({ name: $('#sName').value.trim() })));
    commit('#sRole', () => act(api.setStatus(null, null, $('#sRole').value.trim())));
  },
};
function statusSeg(id, current) {
  return `<div class="seg">${STATUSES.map(s => `<button class="${current === s ? 'on' : ''}" data-act="set-status" data-id="${esc(id)}" data-s="${s}"><span class="dot ${s}" style="animation:none"></span>${s}</button>`).join('')}</div>`;
}


const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return new Date(ts).toLocaleDateString(); };
Views.security = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Security</h1><div class="sub">Who can reach this PC, what they may do, and everything that happened.</div></div>
        <div class="actions"><button class="btn" data-act="clear-log">${I.trash}Clear log</button></div></div>
      <div class="sec-cards" id="secCards"></div>
      <h2 class="sec">Temporarily blocked</h2><div class="group" id="secBlocked"></div>
      <h2 class="sec">Activity</h2><div class="group" id="secLog"></div></div>`;
  },
  update() {
    const sec = S.security, st = S.settings;
    const keyText = { os: [ENV.platform === 'win32' ? 'Locked to your Windows account' : 'Locked in your system keyring', 'ok'], weak: ['No keyring found — keys are only lightly protected', 'warn'], none: ['Not protected — keys are stored as plain files', 'warn'] }[sec.keyProtection] || ['Unknown', 'warn'];
    const card = (title, body, state, extra = '') => `<div class="sec-card ${state}"><div class="sc-top"><span class="sc-dot"></span><b>${title}</b>${extra}</div><div class="sc-body">${body}</div></div>`;
    const tog = (k, on) => `<button class="toggle ${on ? 'on' : ''}" data-act="set-toggle" data-k="${k}" style="margin-left:auto"></button>`;
    $('#secCards').innerHTML = [
      card('Encrypted connections', 'Everything between your PCs is encrypted (AES-256-GCM) with fresh keys on every connection. Altered or replayed data is refused.', 'ok'),
      card('Saved pairing keys', keyText[0], keyText[1]),
      card('New connection requests', st.allowPairing !== false ? 'Other PCs can ask for access. They need the PIN shown on this screen.' : 'Off — other PCs cannot ask for access. Paired PCs still connect.', st.allowPairing !== false ? 'ok' : 'off', tog('allowPairing', st.allowPairing !== false)),
      card('Local network only', st.lanOnly !== false ? 'Connections from outside your home network are refused.' : 'Off — PCs outside your local network may connect. Only turn this off if you know why.', st.lanOnly !== false ? 'ok' : 'warn', tog('lanOnly', st.lanOnly !== false)),
    ].join('');
    $('#secBlocked').innerHTML = sec.blocked.length ? sec.blocked.map(b => `<div class="row"><div class="ico">${I.lock}</div><div class="main"><div class="t">${esc(b.label)}</div><div class="d">${esc(b.reason)} · until ${new Date(b.until).toLocaleTimeString()}</div></div><div class="end"><button class="btn sm" data-act="unblock" data-key="${esc(b.key)}">Unblock</button></div></div>`).join('')
      : `<div class="empty small">Nobody is blocked right now.</div>`;
    $('#secLog').innerHTML = sec.log.length ? sec.log.map(e => `<div class="row log ${e.level}"><span class="lvl"></span><div class="main"><div class="t" style="font-weight:500;white-space:normal">${esc(e.text)}</div></div><div class="end small muted" title="${esc(new Date(e.ts).toLocaleString())}">${ago(e.ts)}</div></div>`).join('')
      : `<div class="empty small">Nothing yet.</div>`;
  },
};

// ---------- Family (parental monitoring) ----------
const KIND_ICON = { game: 'game', browser: 'globe', app: 'app', away: 'moon', locked: 'lock' };
function presence(a) {
  if (!a) return { line1: 'No activity yet', line2: '', icon: 'clock', kind: 'none' };
  if (a.kind === 'game') return { line1: `Playing <b>${esc(a.app)}</b>`, line2: esc(a.detail), icon: 'game', kind: 'game' };
  if (a.kind === 'browser') return { line1: a.site ? `On <b>${esc(a.site)}</b>` : `Browsing in <b>${esc(a.app)}</b>`, line2: esc(a.detail), icon: 'globe', kind: 'browser' };
  if (a.kind === 'away') return { line1: 'Away', line2: a.detail ? `Last used ${esc(a.detail)}` : 'No keyboard or mouse use', icon: 'moon', kind: 'away' };
  if (a.kind === 'locked') return { line1: 'Locked or signed out', line2: '', icon: 'lock', kind: 'locked' };
  return { line1: `Using <b>${esc(a.app)}</b>`, line2: esc(a.detail), icon: 'app', kind: 'app' };
}
const fmtMin = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const kids = () => S.devices.filter(d => d.paired && (d.child || d.monitored));

Views.family = {
  mount(el) {
    el.innerHTML = `<div class="view">
      <div class="head"><div><h1>Family</h1><div class="sub">See what your kids' computers are doing right now, and look back at their day.</div></div></div>
      <div id="famSelf"></div><div class="kids" id="famKids"></div></div>`;
  },
  update() {
    if (S.self.main.isMain && S.self.main.locked) {
      $('#famSelf').innerHTML = `<div class="card empty"><div class="big">${I.lock}</div><h3>Family is locked</h3><div class="small" style="margin-bottom:14px">Enter the main PC passcode to see your kids' activity.</div><button class="btn primary" data-act="unlock">${I.lock}Unlock</button></div>`;
      $('#famKids').innerHTML = '';
      return;
    }
    const me = S.self.monitor;
    const pl = S.plan;
    const usage = S.self.main.isMain ? `<div class="usage"><div><b>${pl.kidCount} of ${pl.kids}</b> kid PCs · <span class="tag ${pl.tier}">${esc(pl.name)}</span></div><div class="bar"><i class="${pl.kidCount >= pl.kids ? 'hot' : ''}" style="width:${Math.min(100, pl.kidCount / Math.max(1, pl.kids) * 100)}%"></i></div>${pl.kidCount >= pl.kids && pl.tier !== 'business' ? `<button class="btn sm primary" data-act="nav" data-view="settings">Upgrade for more${I.arrow}</button>` : ''}</div>` : '';
    $('#famSelf').innerHTML = usage + (me && me.enabled ? `<div class="notice">${I.eye}<div><b>This PC shares its activity with ${esc(me.parentName || 'a parent PC')}.</b><div class="small muted">Apps, games${me.urls ? ', websites' : ''} and times are shared. Change it in Settings → Parental controls (needs the main PC passcode).</div></div></div>` : '');
    const list = kids();
    $('#famKids').innerHTML = list.length ? list.map(kidCard).join('') : `<div class="card empty" style="grid-column:1/-1"><div class="big">${I.family}</div><h3>No kids' computers yet</h3>
      <div class="small" style="max-width:520px;margin:0 auto;line-height:1.6">On your kid's PC: install VELS Syndicate, connect it to this PC (Connections → Request access), then open <b>Settings → Parental controls</b> there and enter this PC's passcode. Activity is only shared with the main PC.</div></div>`;
  },
};
function kidCard(d) {
  let p, sub = '';
  if (!d.connected) { p = { line1: 'Offline', line2: d.host ? `Last address ${esc(d.host)}` : '', icon: 'moon', kind: 'offline' }; }
  else if (!d.monitored) { p = d.connectedFor > 15000 ? { line1: 'Activity sharing is off', line2: 'It was turned off on that PC, or its app was reset', icon: 'eye', kind: 'warn' } : { line1: 'Connecting…', line2: '', icon: 'clock', kind: 'none' }; }
  else { p = presence(d.activity); if (d.activity && d.activity.since) sub = `for ${fmtDur(Date.now() - d.activity.since)}`; }
  return `<div class="kid">
    <div class="kid-top"><div class="kid-av k-${p.kind}">${I[p.icon]}<span class="dot ${d.connected ? (p.kind === 'away' || p.kind === 'locked' ? 'Waiting' : 'Idle') : ''}"></span></div>
      <div style="min-width:0;flex:1"><div class="kid-name">${esc(d.name)}</div><div class="kid-l1">${p.line1}</div>${p.line2 ? `<div class="kid-l2">${p.line2}</div>` : ''}${sub ? `<div class="kid-l3">${I.clock.replace('<svg', '<svg width="13" height="13"')}${sub}</div>` : ''}</div></div>
    <div class="line" style="margin-top:14px"><button class="btn sm" data-act="history" data-id="${esc(d.id)}" ${d.connected ? '' : 'disabled'}>${I.clock}History</button>
      ${d.connected && d.monitored ? '' : '<span class="small muted">History is kept on that PC and shows when it is online.</span>'}</div></div>`;
}

function historyModal(id) {
  const d = S.devices.find(x => x.id === id);
  if (!d) return;
  closeSheet(true);
  const el = document.createElement('div');
  el.className = 'modal wide hist';
  $('#modalHost').appendChild(el);
  $('#scrim').classList.add('on');
  sheet = { id: '__history', el };
  let daysAgo = 0, cur = null;
  const dayName = n => n === 0 ? 'Today' : n === 1 ? 'Yesterday' : new Date(Date.now() - n * 86400000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  el.innerHTML = `<div class="sheet-head"><div class="monitor">${I.clock}</div><div><h2>${esc(d.name)}</h2><div class="sub">Activity history</div></div>
      <button class="btn sm hcopyday" data-x="copyday" title="Copy this day as text">${I.copy}Copy day</button><button class="btn icon" data-x="close" title="Close (Esc)">${I.x}</button></div>
    <div class="sheet-body"><div class="chips" id="hDays">${[0, 1, 2, 3, 4, 5, 6].map(n => `<button class="chip" data-n="${n}">${dayName(n)}</button>`).join('')}</div>
      <div class="hdesc-tgl"><button class="toggle ${S.settings.describeSites !== false ? 'on' : ''}" data-x="desc" aria-label="Show what each website is"></button><span>Show what each website is</span></div>
      <div id="hBody"></div><div id="hStore" class="hstore"></div><div id="hAsk" class="hask" hidden></div></div>`;
  // a small yes/no bar inside the history window (a separate pop-up would close it)
  const ask = (html, okLabel, okClass, onOk) => {
    const bar = el.querySelector('#hAsk');
    bar.innerHTML = `<div class="hask-t">${html}</div><button class="btn sm" data-a="no">Cancel</button><button class="btn sm ${okClass}" data-a="ok">${okLabel}</button>`;
    bar.hidden = false;
    bar.querySelector('[data-a="no"]').onclick = () => { bar.hidden = true; };
    bar.querySelector('[data-a="ok"]').onclick = () => { bar.hidden = true; onOk(); };
    bar.querySelector('[data-a="ok"]').focus();
  };
  const copied = btn => {
    if (!btn || btn.classList.contains('done')) return;
    const old = btn.innerHTML;
    btn.classList.add('done'); btn.innerHTML = I.check + (btn.classList.contains('hcopyday') ? 'Copied' : '');
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = old; }, 1200);
  };
  const fillDescriptions = async () => {
    const boxes = el.querySelectorAll('.hdesc[data-host]');
    if (!cur || S.settings.describeSites === false) { boxes.forEach(x => { x.textContent = ''; }); return; }
    const hosts = [...new Set(cur.entries.filter(e => e.host).map(e => e.host))];
    if (!hosts.length) return;
    let map = {};
    try { map = await api.describeSites(hosts); } catch { return; }
    el.querySelectorAll('.hdesc[data-host]').forEach(x => { x.textContent = map[x.dataset.host] || ''; });
  };
  const load = async () => {
    [...el.querySelectorAll('#hDays .chip')].forEach(c => c.classList.toggle('on', +c.dataset.n === daysAgo));
    const body = el.querySelector('#hBody');
    body.innerHTML = `<div class="waiting-note"><span class="spin"></span>Loading…</div>`;
    el.querySelector('#hAsk').hidden = true;
    try { cur = await api.history(id, daysAgo); } catch (e) { cur = null; if (/^Locked/.test(e.message)) { closeSheet(true); return; } body.innerHTML = `<div class="empty small">${esc(e.message)}</div>`; el.querySelector('#hStore').innerHTML = ''; return; }
    body.innerHTML = renderHistory(cur.entries);
    const st = cur.storage;
    el.querySelector('#hStore').innerHTML = st ? `<span>${I.folder}Saved on ${esc(d.name)}: <b>${fmtBytes(st.bytes)}</b> · ${st.days} day${st.days === 1 ? '' : 's'}${st.keepDays ? ` · days older than ${st.keepDays} are deleted automatically` : ''}</span><button class="btn sm danger" data-x="wipe">${I.trash}Delete history…</button>` : '';
    fillDescriptions();
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-x],[data-copy],[data-link]');
    if (!b || !el.contains(b)) return;
    if (b.dataset.link != null) {
      e.preventDefault();
      const url = b.dataset.link;
      ask(`Open <b>${esc(url.length > 80 ? url.slice(0, 77) + '…' : url)}</b> in your web browser?`, `${I.open}Open`, 'primary', () => act(api.openUrl(url)));
    } else if (b.dataset.copy != null) {
      const en = cur && cur.entries[+b.dataset.copy];
      if (en) act(api.copyText(historyLine(en)).then(() => copied(b)));
    } else if (b.dataset.x === 'close') {
      closeSheet();
    } else if (b.dataset.x === 'copyday') {
      if (!cur || !cur.entries.length) return toast('Nothing to copy for this day', 'info');
      const date = new Date(Date.now() - daysAgo * 86400000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const text = [`${d.name} · ${daysAgo < 2 ? dayName(daysAgo) + ' (' + date + ')' : date}`, ...cur.entries.map(historyLine)].join('\n');
      act(api.copyText(text).then(() => copied(b)));
    } else if (b.dataset.x === 'desc') {
      const on = S.settings.describeSites === false;
      b.classList.toggle('on', on);
      guarded(() => api.settings({ describeSites: on })).then(() => { S.settings.describeSites = on; fillDescriptions(); });
    } else if (b.dataset.x === 'wipe') {
      ask(`Delete <b>all</b> activity history saved on ${esc(d.name)}? This can't be undone.`, `${I.trash}Delete`, 'danger', () =>
        guarded(() => api.deleteKidHistory(id), `Deleted the history on ${d.name}`).then(r => { if (r) load(); }));
    }
  });
  el.querySelector('#hDays').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) { daysAgo = +c.dataset.n; load(); } });
  load();
}
// one history entry as a line of plain text (for Copy)
function historyLine(e) {
  const t = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const name = e.kind === 'browser' && e.site ? e.site : e.app;
  const parts = [`${t(e.start)} – ${e.live ? 'now' : t(e.end)} (${fmtMin(e.end - e.start)})`, name];
  if (e.detail && e.detail !== name) parts.push(e.detail);
  if (e.url) parts.push(e.url);
  else if (e.kind === 'browser' && e.app && e.app !== name) parts.push(e.app);
  return parts.join(' · ');
}
function renderHistory(entries) {
  const active = entries.filter(e => !['away', 'locked'].includes(e.kind));
  if (!entries.length) return `<div class="empty small">Nothing recorded for this day.</div>`;
  const total = active.reduce((a, e) => a + (e.end - e.start), 0);
  const byKey = {};
  for (const e of active) {
    const key = e.kind === 'browser' ? (e.site || e.app) : e.app;
    const k = byKey[key] || (byKey[key] = { name: key, kind: e.kind, ms: 0 });
    k.ms += e.end - e.start;
  }
  const top = Object.values(byKey).sort((a, b) => b.ms - a.ms).slice(0, 8);
  const max = top.length ? top[0].ms : 1;
  const games = active.filter(e => e.kind === 'game').reduce((a, e) => a + (e.end - e.start), 0);
  const web = active.filter(e => e.kind === 'browser').reduce((a, e) => a + (e.end - e.start), 0);
  const t = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="hsum"><div><b>${fmtMin(total)}</b><span>Screen time</span></div><div><b>${fmtMin(games)}</b><span>Games</span></div><div><b>${fmtMin(web)}</b><span>Websites</span></div></div>
    <div class="label">Most used</div>
    <div class="hbars">${top.map(k => `<div class="hbar"><span class="hb-ico">${I[KIND_ICON[k.kind]] || I.app}</span><span class="hb-name">${esc(k.name)}</span><div class="bar"><i style="width:${Math.max(3, k.ms / max * 100)}%"></i></div><span class="hb-t">${fmtMin(k.ms)}</span></div>`).join('')}</div>
    <div class="label" style="margin-top:6px">Timeline</div>
    <div class="group">${entries.map((e, i) => [e, i]).reverse().map(([e, i]) => {
      const name = e.kind === 'browser' && e.site ? e.site : e.app;
      const link = e.url ? `<a href="#" class="hlink" data-link="${esc(e.url)}" title="${esc(e.url)}">${esc(name)}</a>${e.host && e.host !== name.toLowerCase() ? ` <span class="hhost">${esc(e.host)}</span>` : ''}` : esc(name);
      return `<div class="row tl ${e.kind}"><div class="ico">${I[KIND_ICON[e.kind]] || I.app}</div>
      <div class="main"><div class="t" style="font-weight:550">${link}${e.live ? ' <span class="tag">Now</span>' : ''}</div><div class="d">${esc(e.detail || (e.kind === 'browser' ? e.app : ''))}</div>${e.host ? `<div class="hdesc" data-host="${esc(e.host)}"></div>` : ''}</div>
      <div class="end small muted" style="text-align:right">${t(e.start)} – ${e.live ? 'now' : t(e.end)}<br>${fmtMin(e.end - e.start)}</div>
      <button class="btn icon sm hcopy" data-copy="${i}" title="Copy">${I.copy}</button></div>`; }).join('')}</div>`;
}

// passcode prompt (returns the passcode, or null if cancelled). The passcode is checked before it closes.
function askPasscode(title, text) {
  return new Promise(resolve => {
    queueModal({ key: 'passcode', render(el, close) {
      el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>
        <input class="field pass-in" type="password" inputmode="numeric" maxlength="6" id="pcIn" placeholder="• • • •" autocomplete="off">
        <div class="pin-err" id="pcErr" style="display:none"></div>
        <div class="waiting-note" id="pcWait" style="display:none"><span class="spin"></span>Checking…</div>
        <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">Continue</button></div>`;
      const inp = el.querySelector('#pcIn');
      inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, ''); });
      const go = async () => {
        const v = inp.value;
        el.querySelector('#pcWait').style.display = 'flex'; el.querySelector('#pcErr').style.display = 'none';
        try { await api.checkPin(v); close(); resolve(v); }
        catch (e) { el.querySelector('#pcWait').style.display = 'none'; const er = el.querySelector('#pcErr'); er.textContent = e.message; er.style.display = 'block'; inp.select(); }
      };
      el.querySelector('[data-x="ok"]').onclick = go;
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      el.querySelector('[data-x="no"]').onclick = () => { close(); resolve(null); };
      setTimeout(() => inp.focus(), 60);
    } });
  });
}
// Runs an action; if the main PC is locked it asks for the passcode once and tries again.
async function guarded(fn, okText) {
  try { const v = await fn(); if (okText) toast(okText, 'ok'); return v; }
  catch (e) {
    if (!/^Locked/.test(e.message)) { toast(e.message, 'err', 5200); return undefined; }
    const pin = await askPasscode('Main PC passcode', 'This change is protected. Enter the main PC passcode (unlocks for 10 minutes).');
    if (pin == null) return undefined;
    return act(fn(), okText);
  }
}

// new passcode entry: 4 or 6 digits, typed twice
function passcodeFields(el, digits) {
  return `<div class="label">Passcode length</div>
    <div class="seg" style="margin-bottom:12px"><button class="${digits === 4 ? 'on' : ''}" data-d="4">4 digits</button><button class="${digits === 6 ? 'on' : ''}" data-d="6">6 digits (safer)</button></div>
    <div class="line"><input class="field grow pass-in" type="password" inputmode="numeric" maxlength="${digits}" id="np1" placeholder="New passcode" autocomplete="off"><input class="field grow pass-in" type="password" inputmode="numeric" maxlength="${digits}" id="np2" placeholder="Type it again" autocomplete="off"></div>
    <div class="small muted" style="margin-top:8px">${digits === 4 ? 'With 4 digits, kid PCs can only be changed while the main PC is on.' : 'With 6 digits, kid PCs keep a backup check so they can be changed even when the main PC is off.'}</div>`;
}
function readPasscode(el, digits) {
  const a = el.querySelector('#np1').value, b = el.querySelector('#np2').value;
  if (!new RegExp(`^\\d{${digits}}$`).test(a)) throw new Error(`Type ${digits} digits`);
  if (a !== b) throw new Error("The two passcodes don't match");
  return a;
}
function wirePasscodeFields(el, redraw) {
  el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => redraw(+b.dataset.d));
  el.querySelectorAll('.pass-in').forEach(i => i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }));
}

// asked on the requesting PC after its FIRST connection
function chooseMainModal(e) {
  queueModal({ key: 'choose-main', render(el, close) {
    let who = null, digits = 6;
    const draw = () => {
      el.innerHTML = `<div class="m-ico">${I.family}</div><h2>Which PC is the main PC?</h2>
        <p>The main PC is the parent / admin computer. Its passcode protects its own settings, the Family page, and the parental settings on other PCs.</p>
        <div class="choice">
          <button class="${who === 'self' ? 'on' : ''}" data-w="self">${I.desktop}<b>${esc(S.self.name)}</b><span>This PC</span></button>
          <button class="${who === 'peer' ? 'on' : ''}" data-w="peer">${I.desktop}<b>${esc(e.peerName)}</b><span>The PC you just connected to</span></button>
        </div>
        ${who ? passcodeFields(el, digits) : ''}
        <div class="pin-err" id="cmErr" style="display:none"></div>
        <div class="btns"><button class="btn" data-x="later">Decide later</button><button class="btn primary" data-x="ok" ${who ? '' : 'disabled'}>Set main PC</button></div>`;
      el.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { who = b.dataset.w; draw(); });
      if (who) wirePasscodeFields(el, d => { digits = d; draw(); });
      el.querySelector('[data-x="later"]').onclick = () => { close(); toast('You can choose a main PC later in Settings', 'info'); };
      el.querySelector('[data-x="ok"]').onclick = async () => {
        const err = t => { const x = el.querySelector('#cmErr'); x.textContent = t; x.style.display = 'block'; };
        let pin; try { pin = readPasscode(el, digits); } catch (x) { return err(x.message); }
        try { await api.chooseMain(e.peerId, who, pin); close(); toast(`${who === 'self' ? S.self.name : e.peerName} is now the main PC`, 'ok'); }
        catch (x) { err(x.message); }
      };
    };
    draw();
  } });
}

// Settings → Main PC: become main / change passcode / stop being main
function becomeMainModal() {
  queueModal({ key: 'become-main', render(el, close) {
    let digits = 6;
    const draw = () => {
      el.innerHTML = `<div class="m-ico">${I.family}</div><h2>Make this PC the main PC</h2>
        <p>Choose a passcode. You'll need it to change security and parental settings, open the Family page, and change parental settings on kids' PCs.</p>
        ${passcodeFields(el, digits)}<div class="pin-err" id="bmErr" style="display:none"></div>
        <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">Make main PC</button></div>`;
      wirePasscodeFields(el, d => { digits = d; draw(); });
      el.querySelector('[data-x="no"]').onclick = close;
      el.querySelector('[data-x="ok"]').onclick = async () => {
        const err = t => { const x = el.querySelector('#bmErr'); x.textContent = t; x.style.display = 'block'; };
        try { await api.becomeMain(readPasscode(el, digits)); close(); toast('This PC is now the main PC', 'ok'); } catch (x) { err(x.message); }
      };
    };
    draw();
  } });
}
async function changePasscodeFlow() {
  const old = await askPasscode('Current passcode', 'Enter the current main PC passcode.');
  if (old == null) return;
  queueModal({ key: 'change-pass', render(el, close) {
    let digits = S.self.main.digits || 6;
    const draw = () => {
      el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>New passcode</h2><p>Kid PCs start using the new passcode right away.</p>${passcodeFields(el, digits)}<div class="pin-err" id="cpErr" style="display:none"></div>
        <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">Change passcode</button></div>`;
      wirePasscodeFields(el, d => { digits = d; draw(); });
      el.querySelector('[data-x="no"]').onclick = close;
      el.querySelector('[data-x="ok"]').onclick = async () => {
        const err = t => { const x = el.querySelector('#cpErr'); x.textContent = t; x.style.display = 'block'; };
        try { await api.changePasscode(old, readPasscode(el, digits)); close(); toast('Passcode changed', 'ok'); } catch (x) { err(x.message); }
      };
    };
    draw();
  } });
}
async function releaseMainFlow() {
  const pin = await askPasscode('Stop being the main PC?', 'Kids\' PCs will stop sharing their activity with this PC. Enter the passcode to confirm.');
  if (pin == null) return;
  act(api.releaseMain(pin), 'This PC is no longer the main PC');
}

// set up or change activity sharing on THIS (the kid's) PC
async function monitorSetup() {
  const mm = S.self.main, m = S.self.monitor;
  if (!mm.mainId) return toast('Choose a main PC first (Settings → Main PC)', 'warn', 6000);
  if (mm.isMain) return toast('This is the main PC. Turn sharing on from the kids\' PCs.', 'info', 6000);
  const pin = await askPasscode('Main PC passcode', `Parental controls on this PC are protected by ${mm.mainName}'s passcode.`);
  if (pin == null) return;
  queueModal({ key: 'monitor-setup', render(el, close) {
    let urls = m.urls !== false, keepDays = m.keepDays || 30;
    const draw = () => {
      el.innerHTML = `<div class="m-ico">${I.family}</div><h2>${m.enabled ? 'Activity sharing' : 'Share this PC’s activity'}</h2>
        <p><b>${esc(mm.mainName)}</b> (the main PC) will see which apps, games${urls ? ' and websites' : ''} are used on this PC, live and as a daily history. This PC will always show that it is being shared.</p>
        <div class="set-row" style="padding:8px 0;border:0"><div class="k"><b>Include websites</b><small>Saves each website and page visited (like a YouTube video's address), so the main PC can open it</small></div><button class="toggle ${urls ? 'on' : ''}" data-u></button></div>
        <div class="set-row" style="padding:8px 0;border:0"><div class="k"><b>Keep history for</b></div><div class="seg">${[7, 30, 90].map(n => `<button class="${keepDays === n ? 'on' : ''}" data-k="${n}">${n} days</button>`).join('')}</div></div>
        <div class="pin-err" id="msErr" style="display:none"></div>
        <div class="btns">${m.enabled ? '<button class="btn danger" data-x="off">Turn off</button>' : ''}<button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">${m.enabled ? 'Save' : 'Turn on'}</button></div>`;
      el.querySelector('[data-u]').onclick = () => { urls = !urls; draw(); };
      el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { keepDays = +b.dataset.k; draw(); });
      el.querySelector('[data-x="no"]').onclick = close;
      const err = t => { const e = el.querySelector('#msErr'); e.textContent = t; e.style.display = 'block'; };
      el.querySelector('[data-x="ok"]').onclick = async () => {
        try { await api.monitor({ urls, keepDays, pin }); close(); toast(m.enabled ? 'Activity sharing updated' : 'Activity sharing is on', 'ok'); } catch (e) { err(e.message); }
      };
      const off = el.querySelector('[data-x="off"]');
      if (off) off.onclick = async () => {
        // ask twice inside this window instead of opening a second one on top
        if (!off.dataset.sure) { off.dataset.sure = '1'; off.textContent = 'Turn off? History is deleted'; return; }
        try { await api.monitor({ enabled: false, pin }); close(); toast('Activity sharing turned off', 'ok'); } catch (e) { err(e.message); }
      };
    };
    draw();
  } });
}

// ---------- plans ----------
const fmtLimit = b => b == null ? 'any size' : b >= 1024 ** 3 ? `up to ${Math.round(b / 1024 ** 3)} GB` : `up to ${Math.round(b / 1024 ** 2)} MB`;
function planPrice(L, tier) { return tier === 'free' ? '$0' : (L.price && L.price[tier]) || ''; }
const nextTier = tier => { const o = S.plan.tiers.map(t => t.tier); return o[o.indexOf(tier) + 1] || null; };
const tierName = tier => (S.plan.tiers.find(t => t.tier === tier) || {}).name || tier;
function planCompare(p) {
  return `<div class="plans">${p.tiers.map(t => `<div class="plan-col ${t.tier === p.tier ? 'on' : ''}" data-act="plan-info" data-tier="${t.tier}" title="More about ${esc(t.name)}">
    <b>${esc(t.name)}</b>${planPrice(p.license, t.tier) ? `<span class="price">${esc(planPrice(p.license, t.tier))}</span>` : ''}<span>${t.pcs} linked PCs</span><span>Files ${fmtLimit(t.maxFileBytes)}</span>${t.commercial ? '<span>Business use</span>' : ''}
    ${t.tier === p.tier ? '<em>Current plan</em>' : t.tier !== 'free' ? `<button class="btn sm primary" data-act="buy" data-tier="${t.tier}">Get ${esc(t.name)}${I.arrow}</button>` : ''}
    <span class="more">Details ›</span></div>`).join('')}</div>`;
}
// built from the real limits, so the text always matches plans.js
function planFeatures(t) {
  const prev = S.plan.tiers[S.plan.tiers.findIndex(x => x.tier === t.tier) - 1];
  const files = t.maxFileBytes == null ? 'Send files of any size' : `Send files ${fmtLimit(t.maxFileBytes)} each`;
  const f = [prev ? `Everything in ${prev.name}` : 'Connect your PCs, run tasks and share files',
    `Link up to ${t.pcs} other PCs`, `Family: live status and history for up to ${t.kids} kids' PCs`, files];
  if (t.tier === 'free') f.push('For personal and family use');
  else {
    f.push(t.commercial ? 'Allowed for use in a business' : 'For personal and family use');
    f.push('One purchase covers every PC connected to your main PC', 'One-time payment — no subscription', 'Works offline after activating once');
  }
  if (t.commercial) f.push('If you use the Family page on work PCs, tell your staff they are monitored');
  return f;
}
function planInfoModal(tier) {
  const p = S.plan, t = p.tiers.find(x => x.tier === tier), L = p.license;
  if (!t) return;
  const price = planPrice(L, tier);
  queueModal({ key: 'plan-' + tier, render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.shield}</div><h2>VELS Syndicate ${esc(t.name)}</h2>
      <p>${tier === p.tier ? 'This is your current plan.' : price && tier !== 'free' ? esc(price) : tier === 'free' ? 'Free forever for personal and family use.' : ''}</p>
      <ul class="feat">${planFeatures(t).map(f => `<li>${I.check}<span>${esc(f)}</span></li>`).join('')}</ul>
      <div class="btns">${tier !== 'free' && tier !== p.tier ? `<button class="btn" data-x="key">I have a key</button><button class="btn primary" data-x="buy">Get ${esc(t.name)}${I.arrow}</button>` : '<button class="btn primary" data-x="close">Close</button>'}</div>`;
    const b = el.querySelector('[data-x="buy"]'); if (b) b.onclick = () => { close(); buyPlan(tier); };
    const k = el.querySelector('[data-x="key"]'); if (k) k.onclick = () => { close(); licenseModal(); };
    const c = el.querySelector('[data-x="close"]'); if (c) c.onclick = close;
  } });
}
function buyPlan(tier) {
  const L = S.plan.license, url = L.checkout && L.checkout[tier];
  if (url) return act(api.openCheckout(tier)).then(() => toast('The store opened in your web browser. After paying, paste your key in Settings → Plan → Enter license key.', 'info', 9000));
  queueModal({ key: 'no-store', render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>Purchases aren't set up yet</h2>
      <p>This copy of VELS Syndicate isn't connected to a store, so there's no checkout link to open. If you got a license key another way, you can still enter it.</p>
      <div class="btns"><button class="btn" data-x="close">Close</button><button class="btn primary" data-x="key">Enter license key</button></div>`;
    el.querySelector('[data-x="close"]').onclick = close;
    el.querySelector('[data-x="key"]').onclick = () => { close(); licenseModal(); };
  } });
}
function planRows() {
  const p = S.plan, L = p.license;
  const who = p.inherited ? `Included with ${esc(p.fromName || 'the main PC')} (the main PC)` : p.tier === 'free' ? 'Free forever for home use' : `License ${esc(L.displayKey)} on this PC`;
  return `
    <div class="set-row"><div class="k"><b>VELS Syndicate <span class="tag ${p.tier}">${esc(p.name)}</span></b><small>${who} · ${p.pcCount} of ${p.pcs} linked PCs · files ${fmtLimit(p.maxFileBytes)} each</small></div>
      ${L.hasKey ? `<button class="btn sm danger" data-act="remove-license">${I.trash}Remove from this PC…</button>` : ''}
      <button class="btn sm" data-act="enter-license">${I.lock}Enter license key…</button></div>
    ${L.stale ? '<div class="set-row"><div class="k"><small style="color:#ff9f0a">The license hasn\'t been checked for over 30 days, so this PC is on Free until it can reach the internet once.</small></div></div>' : ''}
    ${!L.configured ? '<div class="set-row"><div class="k"><small>This copy isn\'t connected to a store, so upgrades aren\'t available here.</small></div></div>' : ''}
    <div class="set-row" style="display:block">${planCompare(p)}</div>`;
}
function licenseModal() {
  queueModal({ key: 'license', render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>Enter license key</h2>
      <p>Paste the key from your purchase email. It's checked with the store once (needs the internet), then works offline. One key covers every PC connected to the main PC.</p>
      <input class="field" id="licIn" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" spellcheck="false" autocomplete="off" style="width:100%;height:40px;font-family:var(--mono)">
      <div class="pin-err" id="licErr" style="display:none"></div>
      <div class="waiting-note" id="licWait" style="display:none"><span class="spin"></span>Checking with the store…</div>
      <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">Activate</button></div>
      ${nextTier(S.plan.tier) ? `<div style="text-align:center;margin-top:12px"><button class="btn ghost sm" data-x="buy">Don't have a key? Get ${esc(tierName(nextTier(S.plan.tier)))}</button></div>` : ''}`;
    const buy = el.querySelector('[data-x="buy"]'); if (buy) buy.onclick = () => { close(); buyPlan(nextTier(S.plan.tier)); };
    const inp = el.querySelector('#licIn'), err = el.querySelector('#licErr'), waitEl = el.querySelector('#licWait');
    const go = async () => {
      err.style.display = 'none'; waitEl.style.display = 'flex';
      const res = await guarded(() => api.activateLicense(inp.value.trim()));
      waitEl.style.display = 'none';
      if (res) { close(); toast(`${tierName(res.tier)} unlocked — thank you!`, 'ok', 6000); }
    };
    el.querySelector('[data-x="ok"]').onclick = go;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    el.querySelector('[data-x="no"]').onclick = close;
    setTimeout(() => inp.focus(), 60);
  } });
}

// ---------- view switching ----------
function show(v) {
  view = v;
  const main = $('#main');
  Views[v].mount(main);
  makeMorphable(main);
  main.scrollTop = 0;
  if (S) Views[v].update();
  renderNav();
}
function refresh() {
  if (!S) return;
  applyAccent();
  renderNav();
  Views[view].update();
  if (sheet) updateSheet();
}

// ---------- device sheet ----------
function openSheet(id) {
  closeSheet(true);
  const el = document.createElement('div');
  el.className = 'modal wide';
  $('#modalHost').appendChild(el);
  $('#scrim').classList.add('on');
  sheet = { id, el };
  el.innerHTML = `<div class="sheet-head" id="shHead"></div><div class="sheet-body">
      <div><div class="label">Status</div><div id="shStatus"></div></div>
      <div><div class="label">Role</div><div class="line"><input class="field grow" id="shRole" placeholder="What should this computer do?" list="shRoleIdeas"><button class="btn" data-act="sh-role">Set role</button></div>
        <datalist id="shRoleIdeas">${ROLE_IDEAS.map(r => `<option value="${esc(r)}">`).join('')}</datalist></div>
      <div><div class="label">Run a task here</div>
        <div class="line" style="margin-bottom:8px"><div class="seg" id="shShell"></div></div>
        <div class="line"><input class="field grow" id="shCmd" placeholder="Type a command and press Enter" spellcheck="false" style="font-family:var(--mono);font-size:12.5px"><button class="btn primary" data-act="sh-run">${I.play}Run</button></div>
        <div class="chips" id="shPresets" style="margin-top:8px"></div></div>
      <div id="shTasks"></div>
      <div id="shFiles"></div>
      <div><div class="label">Details</div><dl class="kv" id="shKv"></dl></div></div>`;
  const d = allDesks().find(x => x.id === id);
  $('#shRole').value = d ? d.role || '' : '';
  sheet.shell = shellsFor(platformOf(id))[0];
  $('#shCmd').addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-act="sh-run"]').click(); });
  $('#shRole').addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-act="sh-role"]').click(); });
  makeMorphable(el);
  updateSheet();
}
function updateSheet() {
  if (sheet.id === '__history') return;
  const d = allDesks().find(x => x.id === sheet.id);
  if (!d) return closeSheet();
  const st = d.stats;
  $('#shHead').innerHTML = `<div class="monitor">${I.desktop}<span class="dot ${d.status}"></span></div>
    <div><h2>${esc(d.name)}${d.isSelf ? ' <span class="tag">This PC</span>' : ''}</h2><div class="sub">${d.status}${d.role ? ' · ' + esc(d.role) : ''}${d.latency != null ? ' · ' + d.latency + ' ms' : ''}</div></div>
    <button class="btn icon" data-act="close-sheet" title="Close">${I.x}</button>`;
  $('#shStatus').innerHTML = d.connected ? statusSeg(d.id, d.isSelf ? S.self.manualStatus : d.status) : `<span class="muted">Offline — status can be set once it reconnects.</span>`;
  const plat = d.isSelf ? S.self.platform : d.platform, shells = shellsFor(plat);
  if (!shells.includes(sheet.shell)) sheet.shell = shells[0];
  $('#shShell').innerHTML = shells.map(v => `<button class="${v === sheet.shell ? 'on' : ''}" data-act="sh-shell" data-v="${v}">${SHELL_LABEL[v]}</button>`).join('');
  $('#shPresets').innerHTML = presetsFor(plat).map(p => `<span class="chip" data-act="sh-preset" data-i="${p.i}">${esc(p.name)}</span>`).join('');
  const tasks = S.tasks.filter(t => t.peerId === d.id && t.direction !== 'in').slice(0, 4);
  $('#shTasks').innerHTML = tasks.length ? `<div class="label">Recent tasks</div><div class="stack">${tasks.map(taskItem).join('')}</div>` : '';
  $('#shFiles').innerHTML = d.isSelf ? '' : `<div class="label">Files</div><div class="line"><button class="btn" data-act="pick-files" data-id="${esc(d.id)}" ${d.connected ? '' : 'disabled'}>${I.upload}Send files…</button><button class="btn" data-act="pick-folder" data-id="${esc(d.id)}" ${d.connected ? '' : 'disabled'}>${I.folder}Send folder…</button><span class="small muted">or drop files on this window</span></div>`;
  const rows = st ? [
    ['Processor', `${st.cpuModel} · ${st.cores} threads`], ['CPU', st.cpu + '%'],
    ['Memory', `${fmtBytes(st.ramUsed)} of ${fmtBytes(st.ramTotal)}`],
    ['Graphics', st.gpu ? `${st.gpu.name} · ${st.gpu.util}% · ${fmtBytes(st.gpu.vramUsed * 1048576)} / ${fmtBytes(st.gpu.vramTotal * 1048576)} VRAM${st.gpu.temp ? ' · ' + st.gpu.temp + '°C' : ''}` : 'No NVIDIA GPU detected'],
    ['Disk', st.disk ? `${fmtBytes(st.disk.free)} free of ${fmtBytes(st.disk.total)} (${st.disk.root})` : '—'],
    ['Network', (st.ips || []).join(', ') || '—'], ['Up for', fmtUptime(st.uptime)], ['System', st.osName || st.release],
  ] : [['Status', 'Offline'], ['Last address', d.host || '—']];
  $('#shKv').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  sheet.el.dataset.drop = d.isSelf ? '' : d.id;
}
function closeSheet(instant) {
  if (!sheet) return;
  const el = sheet.el; sheet = null;
  if (!modalQueue.length && !activeModal) $('#scrim').classList.remove('on');
  if (instant) return el.remove();
  el.classList.add('out'); setTimeout(() => el.remove(), 200);
}

// ---------- prompts (pairing, approvals, incoming files) ----------
const modalQueue = [];
let activeModal = null;
function queueModal(m) { modalQueue.push(m); pumpModal(); }
function pumpModal() {
  if (activeModal || !modalQueue.length) return;
  const m = modalQueue.shift();
  if (sheet) closeSheet(true);
  const el = document.createElement('div');
  el.className = 'modal';
  activeModal = { m, el };
  $('#modalHost').appendChild(el);
  $('#scrim').classList.add('on');
  m.render(el, () => closeModal());
  addCloseX(el);
}
// Every pop-up gets an X in the corner, and Esc works too. Closing a pop-up does the same as its
// own Cancel / Decline / Deny / Decide later button, so nothing is left half-done.
const DISMISS_BTNS = ['cancel', 'no', 'later', 'deny', 'close'];
// requests from another PC aren't dismissed by a stray click outside the window (only X or Esc)
const ASKS_FROM_OTHERS = /^(pair:|task:|files:)/;
function addCloseX(el) {
  if (el.querySelector(':scope > .m-x')) return;
  const b = document.createElement('button');
  b.className = 'm-x'; b.type = 'button'; b.title = 'Close (Esc)'; b.setAttribute('aria-label', 'Close');
  b.innerHTML = I.x; b.onclick = dismissModal;
  el.prepend(b);
}
function dismissModal() {
  if (!activeModal) return;
  const el = activeModal.el;
  for (const k of DISMISS_BTNS) { const b = el.querySelector(`[data-x="${k}"]`); if (b && !b.disabled) { b.click(); return; } }
  closeModal();
}
function closeModal(key) {
  if (!activeModal) return;
  if (key && activeModal.m.key !== key) return;
  const el = activeModal.el; activeModal = null;
  el.classList.add('out'); setTimeout(() => el.remove(), 200);
  if (!modalQueue.length && !sheet) $('#scrim').classList.remove('on');
  setTimeout(pumpModal, 220);
}
function dropQueued(key) { const i = modalQueue.findIndex(m => m.key === key); if (i >= 0) modalQueue.splice(i, 1); }

// In-app yes/no box (instead of the plain Windows one). Resolves true or false.
function confirmBox({ title, text, ok = 'OK', danger = false, icon = '' }) {
  return new Promise(resolve => queueModal({ key: 'confirm', render(el, close) {
    el.innerHTML = `<div class="m-ico">${danger ? I.shield : I.check}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${icon && I[icon] ? I[icon] : ''}${esc(ok)}</button></div>`;
    el.querySelector('[data-x="no"]').onclick = () => { close(); resolve(false); };
    el.querySelector('[data-x="ok"]').onclick = () => { close(); resolve(true); };
  } }));
}

function connectingModal(label) {
  queueModal({ key: 'connecting', render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.link}</div><h2>Requesting access…</h2><p>Asking ${esc(label)} to let this PC connect.</p><div class="waiting-note"><span class="spin"></span>VELS Syndicate must be open on that PC</div>
      <div class="btns"><button class="btn">Close</button></div>`;
    el.querySelector('button').onclick = close;
  } });
}

function upsertModal(key, data, render) {
  if (activeModal && activeModal.m.key === key) { activeModal.m.data = data; activeModal.m.render(activeModal.el, () => closeModal()); addCloseX(activeModal.el); return; }
  const queued = modalQueue.find(m => m.key === key);
  if (queued) { queued.data = data; return; }
  const m = { key, data, render(el, close) { render(el, close, m.data); } };
  queueModal(m);
}

// Receiving PC: someone is asking for access — show the PIN they need to type.
function pairRequestModal(r) {
  upsertModal('pair:' + r.sid, r, (el, close, d) => {
    const digits = d.pin.split('').map(c => `<span>${c}</span>`).join('');
    el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>${esc(d.peerName)} is requesting access</h2>
      <p>From ${esc(d.host)}. To allow it, type this PIN on <b>${esc(d.peerName)}</b>.<br>If you didn't expect this, choose Deny.</p>
      <div class="code">${digits}</div>
      <div class="waiting-note">${d.wrong ? `<span style="color:#ff9f0a">A wrong PIN was entered, so this is a new PIN.</span> ` : '<span class="spin"></span>'}${d.triesLeft} ${d.triesLeft === 1 ? 'try' : 'tries'} left</div>
      <div class="btns"><button class="btn danger" data-x="deny">Deny</button></div>`;
    el.querySelector('[data-x="deny"]').onclick = () => { act(api.pairCancel(d.sid)); close(); };
  });
}

// Requesting PC: type the PIN shown on the other computer.
function pinEntryModal(p) {
  if (activeModal && activeModal.m.key === 'connecting') closeModal('connecting');
  dropQueued('connecting');
  upsertModal('pair:' + p.sid, p, (el, close, d) => {
    el.innerHTML = `<div class="m-ico">${I.lock}</div><h2>Enter the PIN</h2>
      <p>Look at <b>${esc(d.peerName)}</b> — it's showing a 6-digit PIN. Type it here.</p>
      <div class="code pin-in">${[0, 1, 2, 3, 4, 5].map(i => `<input inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i + 1}">`).join('')}</div>
      <div class="pin-err" ${d.error ? '' : 'style="display:none"'}>${esc(d.error || '')} ${d.error ? `${d.triesLeft} ${d.triesLeft === 1 ? 'try' : 'tries'} left.` : ''}</div>
      <div class="waiting-note" id="pinWait" style="display:none"><span class="spin"></span>Checking…</div>
      <div class="btns"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="go" disabled>Connect</button></div>`;
    const boxes = [...el.querySelectorAll('.pin-in input')];
    const go = el.querySelector('[data-x="go"]');
    const value = () => boxes.map(b => b.value).join('');
    const sync = () => { go.disabled = !/^\d{6}$/.test(value()); };
    const submit = () => {
      if (go.disabled) return;
      go.disabled = true; boxes.forEach(b => b.disabled = true);
      el.querySelector('#pinWait').style.display = 'flex';
      el.querySelector('.pin-err').style.display = 'none';
      api.pairPin(d.sid, value()).catch(e => { toast(e.message, 'err'); close(); });
    };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        const digits = b.value.replace(/\D/g, '');
        if (digits.length > 1) { digits.slice(0, 6 - i).split('').forEach((c, k) => { boxes[i + k].value = c; }); }
        else b.value = digits;
        const next = boxes.find(x => !x.value);
        (next || boxes[5]).focus();
        sync();
        if (/^\d{6}$/.test(value())) submit();
      });
      b.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !b.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); sync(); }
        if (e.key === 'Enter') submit();
      });
      b.addEventListener('paste', e => { e.preventDefault(); const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6); t.split('').forEach((c, k) => { boxes[k].value = c; }); sync(); if (t.length === 6) submit(); else boxes[t.length].focus(); });
    });
    el.querySelector('[data-x="cancel"]').onclick = () => { api.pairCancel(d.sid); close(); };
    setTimeout(() => boxes[0].focus(), 60);
  });
}

function approvalModal(a) {
  queueModal({ key: 'task:' + a.taskId, render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.terminal}</div><h2>Run a task from ${esc(a.peerName)}?</h2>
      <p>${a.title ? `<b>${esc(a.title)}</b> · ` : ''}${SHELL_LABEL[a.shell] || a.shell} on this PC. Only allow commands you recognize.</p>
      <div class="cmdbox">${esc(a.cmd)}</div>
      <div class="btns"><button class="btn danger" data-x="deny">Don't allow</button><button class="btn primary" data-x="allow">Allow once</button></div>
      <div style="text-align:center;margin-top:12px"><button class="btn ghost sm" data-x="always">Always allow from ${esc(a.peerName)}</button></div>`;
    for (const d of ['deny', 'allow', 'always']) el.querySelector(`[data-x="${d}"]`).onclick = () => { act(api.approveTask(a.taskId, d)); close(); };
  } });
}

function fileOfferModal(o) {
  queueModal({ key: 'files:' + o.batchId, render(el, close) {
    el.innerHTML = `<div class="m-ico">${I.files}</div><h2>${esc(o.peerName)} wants to send ${o.count} file${o.count === 1 ? '' : 's'}</h2>
      <p>${fmtBytes(o.total)} total</p>
      <div class="group">${o.names.map(n => `<div class="row" style="min-height:40px;padding:8px 14px"><div class="main"><div class="d" style="margin:0;color:var(--text)">${esc(n)}</div></div></div>`).join('')}${o.count > o.names.length ? `<div class="row" style="min-height:36px;padding:8px 14px"><div class="d" style="margin:0">and ${o.count - o.names.length} more</div></div>` : ''}</div>
      <div class="btns"><button class="btn" data-x="no">Decline</button><button class="btn primary" data-x="yes">Accept</button></div>`;
    el.querySelector('[data-x="no"]').onclick = () => { api.answerFiles(o.batchId, false); close(); };
    el.querySelector('[data-x="yes"]').onclick = () => { api.answerFiles(o.batchId, true); close(); };
  } });
}

// ---------- drag & drop onto desks ----------
let dragDepth = 0;
function endDrag() { dragDepth = 0; document.body.classList.remove('dragging'); document.querySelectorAll('.desk.drop').forEach(x => x.classList.remove('drop')); }
function sendDropped(target, fileList) {
  const paths = [...fileList].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return toast('Could not read those files', 'err');
  act(api.sendFiles(target, paths)).then(r => { if (r) toast(`Offered ${paths.length} item${paths.length === 1 ? '' : 's'} to ${nameOf(target)}`, 'info'); });
}
document.addEventListener('dragenter', e => { if (![...e.dataTransfer.types].includes('Files')) return; dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) endDrag(); });
document.addEventListener('dragover', e => {
  e.preventDefault();
  const t = e.target.closest('[data-drop]');
  document.querySelectorAll('.desk.drop').forEach(x => { if (x !== t) x.classList.remove('drop'); });
  if (t && t.dataset.drop && t.classList.contains('desk')) t.classList.add('drop');
  e.dataTransfer.dropEffect = t && t.dataset.drop ? 'copy' : 'none';
});
document.addEventListener('drop', e => {
  e.preventDefault();
  const t = e.target.closest('[data-drop]');
  endDrag();
  if (!t || !t.dataset.drop) return;
  const d = S.devices.find(x => x.id === t.dataset.drop);
  if (!d || !d.connected) return toast('That computer is offline', 'warn');
  sendDropped(d.id, e.dataTransfer.files);
});

// ---------- actions ----------
const A = {
  'nav': ds => show(ds.view),
  'filter': ds => { officeFilter = officeFilter === ds.s ? null : ds.s; Views.office.update(); },
  'open-desk': ds => openSheet(ds.id),
  'close-sheet': () => closeSheet(),
  'pair': ds => { const d = S.devices.find(x => x.id === ds.id); connectingModal(d ? d.name : 'that PC'); act(api.pair({ id: ds.id })).then(r => { if (r === undefined) closeModal('connecting'); }); },
  'pair-ip': () => {
    const host = $('#ipHost').value.trim(), port = +$('#ipPort').value.trim() || 47821;
    if (!/^[\w.\-:]+$/.test(host)) return toast('Type an IP address like 192.168.1.25', 'warn');
    connectingModal(host);
    act(api.pair({ host, port })).then(r => { if (r === undefined) closeModal('connecting'); });
  },
  'perm': ds => guarded(() => api.setPerm(ds.id, ds.k, ds.v)),
  'unblock': ds => guarded(() => api.unblock(ds.key)),
  'clear-log': () => confirmBox({ title: 'Clear the security log?', text: 'All entries on this PC are deleted.', ok: 'Clear log', danger: true, icon: 'trash' }).then(y => { if (y) act(api.clearLog()); }),
  'unpair': ds => { const d = S.devices.find(x => x.id === ds.id); if (ds.id === S.self.main.mainId && !S.self.main.isMain) { askPasscode('Remove the main PC?', 'This also turns off activity sharing. Enter the main PC passcode.').then(pin => { if (pin != null) act(api.unpair(ds.id, pin)); }); return; } confirmBox({ title: `Remove access for ${d ? d.name : 'this PC'}?`, text: 'It is removed on both computers, and you\'ll need to request access again to reconnect.', ok: 'Remove access', danger: true, icon: 'trash' }).then(y => { if (y) guarded(() => api.unpair(ds.id)); }); },
  'set-status': ds => act(api.setStatus(ds.id === S.self.id ? null : ds.id, ds.s)),
  'sh-role': () => act(api.setStatus(sheet.id === S.self.id ? null : sheet.id, null, $('#shRole').value.trim()), 'Role updated'),
  'sh-shell': ds => { sheet.shell = ds.v; updateSheet(); },
  'sh-preset': ds => { const p = S.settings.presets[+ds.i]; if (p) { $('#shCmd').value = p.cmd; sheet.shell = p.shell; updateSheet(); $('#shCmd').focus(); } },
  'sh-run': () => {
    const cmd = $('#shCmd').value.trim(); if (!cmd) return;
    act(api.runTask({ target: sheet.id, cmd, shell: sheet.shell })).then(id => { if (id) { selTask = id; $('#shCmd').value = ''; toast('Task started — open Tasks to watch it', 'ok'); } });
  },
  't-target': ds => { tTarget = ds.id; tShell = shellsFor(platformOf(ds.id))[0]; Views.tasks.update(); },
  'shell': ds => { tShell = ds.v; Views.tasks.update(); },
  'preset': (ds, el, e) => { if (e.target.closest('[data-act="del-preset"]')) return; const p = S.settings.presets[+ds.i]; if (p) { $('#tCmd').value = p.cmd; $('#tTitle').value = p.name; tShell = p.shell; Views.tasks.update(); $('#tCmd').focus(); } },
  'del-preset': ds => { const presets = S.settings.presets.slice(); presets.splice(+ds.i, 1); act(api.settings({ presets })); },
  'save-preset': () => {
    const cmd = $('#tCmd').value.trim(); if (!cmd) return toast('Type a command first', 'warn');
    const name = $('#tTitle').value.trim() || cmd.slice(0, 24);
    act(api.settings({ presets: [...(S.settings.presets || []), { name, cmd, shell: tShell }] }), 'Preset saved');
  },
  'run': () => {
    const cmd = $('#tCmd').value.trim(); if (!cmd) return toast('Type a command first', 'warn');
    act(api.runTask({ target: tTarget, cmd, shell: tShell, title: $('#tTitle').value.trim() })).then(id => { if (id) { selTask = id; consoleFor = null; } });
  },
  'sel-task': ds => { selTask = ds.id; if (view !== 'tasks') { closeSheet(true); show('tasks'); } else { Views.tasks.update(); renderConsole(true); } },
  'cancel-task': ds => act(api.cancelTask(ds.id)),
  'rerun': ds => { const t = S.tasks.find(x => x.id === ds.id); if (t) act(api.runTask({ target: t.peerId, cmd: t.cmd, shell: t.shell, title: t.title })).then(id => { if (id) selTask = id; }); },
  'clear-tasks': () => { act(api.clearTasks()); },
  'f-target': ds => { fTarget = ds.id; Views.files.update(); },
  'pick-files': ds => { const t = ds.id || fTarget; if (!t) return toast('Pick a computer first', 'warn'); act(api.pickAndSend(t)); },
  'pick-folder': ds => { const t = ds.id || fTarget; if (!t) return toast('Pick a computer first', 'warn'); act(api.pickFolderAndSend(t)); },
  'cancel-transfer': ds => act(api.cancelTransfer(ds.id)),
  'clear-transfers': () => act(api.clearTransfers()),
  'open-received': () => act(api.openReceived()),
  'open-transfer': async ds => {
    // received programs and scripts can be dangerous: ask first
    if (ds.dir === 'in' && /\.(exe|msi|bat|cmd|ps1|vbs|vbe|js|jse|jar|scr|com|lnk|hta|reg|wsf|cpl|msc|pif)$/i.test(ds.name)
      && !(await confirmBox({ title: 'Open a program from another PC?', text: `"${ds.name}" is a program or script from another computer. Only open it if you trust it and were expecting it.`, ok: 'Open anyway', danger: true, icon: 'open' }))) return;
    act(api.openTransfer(ds.id, 'open'));
  },
  'show-transfer': ds => act(api.openTransfer(ds.id, 'show')),
  'plan-info': ds => planInfoModal(ds.tier),
  'pick-recv': () => act(api.pickReceiveDir()),
  'set': ds => guarded(() => api.settings({ [ds.k]: ds.v })),
  'set-toggle': ds => guarded(() => api.settings({ [ds.k]: ['allowPairing', 'lanOnly', 'describeSites'].includes(ds.k) ? S.settings[ds.k] === false : !S.settings[ds.k] })),
  'par': ds => act(api.settings({ maxParallel: Math.max(1, Math.min(8, (+S.settings.maxParallel || 2) + +ds.d)) })),
  'firewall': () => act(api.firewall()).then(r => { if (r && r.ok) toast('Firewall rules added', 'ok'); else if (r) toast(r.error, 'err', 6000); }),
  'quit': () => quitApp(),
  'monitor-setup': () => monitorSetup(),
  'enter-license': () => licenseModal(),
  'open-history-folder': async () => {
    const mm = S.self.main;
    const pin = await askPasscode('Main PC passcode', `The history folder is protected by ${mm.mainName || 'the main PC'}'s passcode, so it can't be deleted without it.`);
    if (pin == null) return;
    act(api.openHistoryFolder(pin));
  },
  'remove-license': () => confirmBox({ title: 'Remove the license from this PC?', text: 'You can then use the key on another PC. This PC (and PCs that get their plan from it) go back to Free.', ok: 'Remove license', danger: true, icon: 'trash' }).then(y => { if (y) guarded(() => api.removeLicense(), 'License removed from this PC'); }),
  'buy': (ds, el, e) => { e.stopPropagation(); buyPlan(ds.tier); },
  'become-main': () => becomeMainModal(),
  'change-pass': () => changePasscodeFlow(),
  'release-main': () => releaseMainFlow(),
  'lock-now': () => act(api.lockAdmin()),
  'unlock': () => askPasscode('Main PC passcode', 'Enter the passcode to unlock (stays unlocked for 10 minutes, or until you minimize the window).'),
  'history': ds => historyModal(ds.id),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.act];
  if (!fn) return;
  if (el.dataset.act === 'open-desk' && e.target.closest('button')) return;
  e.stopPropagation();
  fn(el.dataset, el, e);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (activeModal) { e.preventDefault(); dismissModal(); } else if (sheet) closeSheet();
});
$('#scrim').addEventListener('click', () => {
  if (activeModal) { if (!ASKS_FROM_OTHERS.test(activeModal.m.key)) dismissModal(); }
  else if (sheet) closeSheet();
});

async function quitApp() {
  if (S && S.self.monitor && S.self.monitor.enabled) {
    const pin = await askPasscode('Quit VELS Syndicate?', 'Activity sharing is on. Quitting needs the main PC passcode.');
    if (pin == null) return;
    return act(api.quit(pin));
  }
  api.quit();
}

// ---------- boot ----------
(async function boot() {
  morphable($('#nav')); morphable($('#meCard'));
  ENV = await api.env();
  applyTheme(ENV.dark);
  document.body.classList.add('blur-' + ENV.blur);
  api.on('theme', t => { ENV.dark = t.dark; applyTheme(t.dark); lastSettingsKey = ''; refresh(); });
  api.on('state', s => { S = s; refresh(); });
  api.on('toast', t => toast(t.text, t.kind));
  api.on('task-out', d => appendOut(d.taskId, d.data));
  api.on('pair-request', r => pairRequestModal(r));
  api.on('pair-pin-needed', p => pinEntryModal(p));
  api.on('pair-done', p => {
    closeModal('pair:' + p.sid); dropQueued('pair:' + p.sid); closeModal('connecting'); dropQueued('connecting');
    if (!p.ok && p.reason && !['Cancelled', 'Denied'].includes(p.reason)) toast(p.role === 'responder' ? `Request from ${p.peerName || 'a PC'} ended: ${p.reason}` : `Couldn't connect: ${p.reason}`, 'warn', 6000);
  });
  api.on('task-approval', a => approvalModal(a));
  api.on('file-offer', o => fileOfferModal(o));
  // a request from a PC that disconnected: close its pop-up (or drop it if it hasn't shown yet)
  api.on('request-gone', g => { if (!g || typeof g.key !== 'string') return; dropQueued(g.key); closeModal(g.key); });
  api.on('ask-quit', () => quitApp());
  api.on('choose-main', e => chooseMainModal(e));
  S = await api.state();
  applyAccent();
  show('office');
  requestAnimationFrame(() => document.body.classList.remove('booting'));
})();
