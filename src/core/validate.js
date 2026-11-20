'use strict';
// Input validation and sanitizing for everything that arrives from another computer
// (and for settings coming from the window). Nothing from the network is trusted as-is.
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
// control characters + bidi overrides that could be used to fake names on screen
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

const isId = v => typeof v === 'string' && ID_RE.test(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const num = (v, min, max, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt);

function cleanText(v, max = 64, fallback = '') {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(BAD_CHARS, '').trim().slice(0, max);
  return s || fallback;
}

function isB64(v, maxLen) {
  return typeof v === 'string' && v.length <= maxLen && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
}

// Stats come from other PCs and end up on screen: keep only known fields with sane values.
function cleanStats(s) {
  if (!s || typeof s !== 'object') return null;
  const gpu = s.gpu && typeof s.gpu === 'object' ? {
    name: cleanText(s.gpu.name, 80, 'GPU'), util: num(s.gpu.util, 0, 100), vramUsed: num(s.gpu.vramUsed, 0, 1e7),
    vramTotal: num(s.gpu.vramTotal, 0, 1e7), temp: s.gpu.temp == null ? null : num(s.gpu.temp, -50, 200),
  } : null;
  const disk = s.disk && typeof s.disk === 'object' ? { root: cleanText(s.disk.root, 16, '/'), total: num(s.disk.total, 0, 1e18), free: num(s.disk.free, 0, 1e18) } : null;
  return {
    cpu: num(s.cpu, 0, 100), cpuModel: cleanText(s.cpuModel, 100), cores: num(s.cores, 0, 4096),
    ramTotal: num(s.ramTotal, 0, 1e15), ramUsed: num(s.ramUsed, 0, 1e15), gpu, disk,
    uptime: num(s.uptime, 0, 1e10), platform: ['win32', 'linux', 'darwin'].includes(s.platform) ? s.platform : 'unknown',
    osName: cleanText(s.osName, 80), release: cleanText(s.release, 40), hostname: cleanText(s.hostname, 64),
    ips: Array.isArray(s.ips) ? s.ips.slice(0, 8).filter(ip => isStr(ip, 45) && /^[0-9a-fA-F:.]+$/.test(ip)) : [],
  };
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Turn a name sent by another PC into a safe relative path (no "..", no drive letters, no odd characters).
function safeRel(rel) {
  const parts = String(rel).replace(BAD_CHARS, '').split(/[\\/]+/)
    .filter(p => p && p !== '.' && p !== '..' && !/^[a-zA-Z]:$/.test(p))
    .slice(0, 32)
    .map(p => {
      let q = p.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
      if (!q) q = '_';
      if (WIN_RESERVED.test(q)) q = '_' + q;
      return q;
    });
  return parts.join(path.sep) || 'file';
}

// Private / local network ranges (incl. 100.64/10 used by VPNs such as Tailscale).
function isLocalAddress(ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  if (ip === '::1' || /^fe[89ab][0-9a-f]:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const SHELLS = { win32: ['powershell', 'cmd'], linux: ['bash', 'sh'], darwin: ['bash', 'sh'] };
function shellsFor(platform) { return SHELLS[platform] || SHELLS.linux; }

const STATUSES = ['Idle', 'Waiting', 'Working', 'Busy'];
const PERM_VALUES = { tasks: ['ask', 'allow', 'never'], files: ['ask', 'allow', 'never'], status: ['allow', 'never'] };
function cleanPerms(p) {
  const out = { tasks: 'ask', files: 'ask', status: 'allow' };
  if (p && typeof p === 'object') for (const k of Object.keys(PERM_VALUES)) if (PERM_VALUES[k].includes(p[k])) out[k] = p[k];
  return out;
}

const ACCENTS = ['blue', 'purple', 'hotpink', 'pink', 'crimson', 'orange', 'green', 'teal', 'graphite'];
// Settings coming from the window: whitelist keys, check types, clamp values.
function cleanSettingsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const bool = k => { if (typeof patch[k] === 'boolean') out[k] = patch[k]; };
  if ('name' in patch) out.name = cleanText(patch.name, 40);
  if (['system', 'light', 'dark'].includes(patch.theme)) out.theme = patch.theme;
  if (ACCENTS.includes(patch.accent)) out.accent = patch.accent;
  if (['ask', 'deny'].includes(patch.taskPolicy)) out.taskPolicy = patch.taskPolicy;
  if (['ask', 'auto'].includes(patch.filePolicy)) out.filePolicy = patch.filePolicy;
  if (typeof patch.receiveDir === 'string' && path.isAbsolute(patch.receiveDir) && patch.receiveDir.length < 1024) out.receiveDir = patch.receiveDir;
  if (Number.isInteger(patch.maxParallel)) out.maxParallel = Math.min(8, Math.max(1, patch.maxParallel));
  ['keepInTray', 'startWithWindows', 'allowPairing', 'lanOnly', 'describeSites'].forEach(bool);
  if (Array.isArray(patch.presets)) {
    out.presets = patch.presets.slice(0, 50).filter(p => p && typeof p === 'object' && isStr(p.cmd, 8000) && p.cmd.trim())
      .map(p => ({ name: cleanText(p.name, 40, 'Preset'), cmd: p.cmd, shell: ['powershell', 'cmd', 'bash', 'sh'].includes(p.shell) ? p.shell : 'powershell' }));
  }
  return out;
}

module.exports = { isId, isStr, num, cleanText, isB64, cleanStats, safeRel, isLocalAddress, shellsFor, STATUSES, cleanPerms, cleanSettingsPatch };
