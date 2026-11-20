'use strict';
// Live machine stats with no extra packages: CPU from os.cpus() deltas,
// RAM from os, disk from fs.statfs, NVIDIA GPU from nvidia-smi when present.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

let lastCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  let pct = 0;
  if (lastCpu) {
    const di = idle - lastCpu.idle, dt = total - lastCpu.total;
    pct = dt > 0 ? Math.max(0, Math.min(100, 100 - (di / dt) * 100)) : 0;
  }
  lastCpu = { idle, total };
  return Math.round(pct);
}

let gpuCache = null, gpuAt = 0, gpuBroken = false, gpuBusy = false;
function refreshGpu() {
  if (gpuBroken || gpuBusy || Date.now() - gpuAt < 6000) return;
  gpuBusy = true;
  execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
    { timeout: 4000, windowsHide: true }, (err, out) => {
      gpuBusy = false; gpuAt = Date.now();
      if (err) { gpuBroken = true; gpuCache = null; return; }
      const line = String(out).trim().split(/\r?\n/)[0] || '';
      const [name, util, used, total, temp] = line.split(',').map(s => s.trim());
      gpuCache = name ? { name, util: +util || 0, vramUsed: +used || 0, vramTotal: +total || 0, temp: +temp || null } : null;
    });
}

function diskInfo() {
  try {
    const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
    const s = fs.statfsSync(root);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { root, total, free };
  } catch { return null; }
}

function localIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

let osNameCache = null;
function osName() {
  if (osNameCache) return osNameCache;
  try {
    if (process.platform === 'win32') {
      const build = parseInt(os.release().split('.')[2] || '0', 10);
      osNameCache = `Windows ${build >= 22000 ? '11' : '10'} (build ${build})`;
    } else if (process.platform === 'linux') {
      const txt = fs.readFileSync('/etc/os-release', 'utf8');
      const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      osNameCache = m ? m[1] : 'Linux ' + os.release();
    } else osNameCache = os.type() + ' ' + os.release();
  } catch { osNameCache = os.type() + ' ' + os.release(); }
  return osNameCache;
}

function snapshot() {
  refreshGpu();
  const total = os.totalmem(), free = os.freemem();
  const cpus = os.cpus();
  return {
    cpu: cpuPercent(),
    cpuModel: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    ramTotal: total,
    ramUsed: total - free,
    gpu: gpuCache,
    disk: diskInfo(),
    uptime: Math.round(os.uptime()),
    platform: process.platform,
    osName: osName(),
    release: os.release(),
    hostname: os.hostname(),
    ips: localIPs().map(i => i.address),
  };
}

module.exports = { snapshot, localIPs };
