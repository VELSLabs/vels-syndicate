#!/usr/bin/env node
// Scans the project before you upload it to GitHub and stops if it finds personal information:
// your user folder paths, email addresses, public IP addresses, keys/tokens, app data files,
// plus any words you list in a local ".privacy-words" file (one per line — your name, PC name, city…).
// ".privacy-words" itself is in .gitignore, so it never gets uploaded.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'USB-Ready', '.git', 'out']);
const SKIP_FILES = new Set(['.privacy-words', 'package-lock.json']);
const TEXT_EXT = /\.(js|json|md|txt|bat|sh|yml|yaml|html|css|cjs|mjs)$|^\.[\w-]+$/i;
const APP_DATA_FILES = ['identity.json', 'peers.json', 'security-log.jsonl', 'settings.json', 'license.json', 'transfers.json', 'site-info.json'];

const isPrivateIp = ip => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a === 255 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
};

const rules = [
  { name: 'Windows user folder path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}(?!%|Public\b|Default\b|<|\$)[^\\\s"'`]+/g },
  { name: 'Linux/Mac home folder path', re: /\/(?:home|Users)\/(?!runner\b|user\b|\$)[a-z_][\w.-]*/g },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/g, allow: m => /@(example\.(com|org|invalid)|users\.noreply\.github\.com|noreply)/i.test(m) },
  { name: 'public IP address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, allow: m => isPrivateIp(m) || m.split('.').some(x => +x > 255) },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'access token', re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
];

let words = [];
try {
  words = fs.readFileSync(path.join(ROOT, '.privacy-words'), 'utf8').split(/\r?\n/).map(w => w.trim()).filter(w => w && !w.startsWith('#'));
} catch { /* optional */ }

const findings = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
    const rel = path.relative(ROOT, path.join(dir, e.name));
    if (APP_DATA_FILES.includes(e.name)) { findings.push(`${rel}: app data file (contains pairing keys or logs) — delete it, it must not be uploaded`); continue; }
    if (SKIP_FILES.has(e.name) || !TEXT_EXT.test(e.name)) continue;
    const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
    if (rel === path.join('scripts', 'privacy-check.js')) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('privacy-check: ignore')) return;
      for (const r of rules) {
        for (const m of line.match(r.re) || []) if (!(r.allow && r.allow(m))) findings.push(`${rel}:${i + 1}: ${r.name}: ${m}`);
      }
      for (const w of words) if (line.toLowerCase().includes(w.toLowerCase())) findings.push(`${rel}:${i + 1}: personal word from .privacy-words: "${w}"`);
    });
  }
}
walk(ROOT);

if (findings.length) {
  console.error('Privacy check FAILED — fix these before uploading:\n');
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log(`Privacy check passed (${words.length} personal word${words.length === 1 ? '' : 's'} checked).`);
