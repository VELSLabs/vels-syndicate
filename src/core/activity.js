'use strict';
// Lightweight activity tracker for parental monitoring (Windows).
// One small background PowerShell helper checks the foreground window every 5 seconds
// (window title, program path, seconds since last keyboard/mouse input, and — for Chromium
// browsers, only when the tab changes — the address bar). Nothing else is watched:
// no keystrokes, no screenshots, no microphone/camera.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const POLL_SECONDS = 5;
const IDLE_AFTER = 300;          // 5 min without input = Away
const MIN_SESSION_MS = 10000;    // don't log blips shorter than 10 s

// ---------- the Windows helper ----------
const HELPER_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Windows.Automation;
public static class VelsFg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder s, ref int size);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  public static IntPtr Hwnd() { return GetForegroundWindow(); }
  public static uint Idle() { LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return 0; return unchecked((uint)Environment.TickCount - i.dwTime) / 1000; }
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static string ExePath(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid); if (pid == 0) return "";
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024); int n = 1024;
    string r = QueryFullProcessImageNameW(p, 0, sb, ref n) ? sb.ToString() : ""; CloseHandle(p); return r;
  }
  public static string Url(IntPtr h) {
    try {
      AutomationElement el = AutomationElement.FromHandle(h); if (el == null) return "";
      AutomationElement e = el.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
      if (e == null) return "";
      object vp; if (e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) return ((ValuePattern)vp).Current.Value;
    } catch {}
    return "";
  }
}
'@
$urlKey = ''; $url = ''
while ($true) {
  $h = [VelsFg]::Hwnd()
  $t = [VelsFg]::Title($h); $p = [VelsFg]::ExePath($h); $i = [VelsFg]::Idle()
  if ($env:VELS_URLS -eq '1' -and $p -match '\\(chrome|msedge|brave|vivaldi|opera|opera_gx)\.exe$') {
    $k = "$h|$t"; if ($k -ne $urlKey) { $urlKey = $k; $url = [VelsFg]::Url($h) }
  } else { $url = ''; $urlKey = '' }
  [Console]::Out.WriteLine((@{ title = $t; path = $p; idle = $i; url = $url } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${POLL_SECONDS}
}
`;

// ---------- recognizing games, browsers and apps ----------
const KNOWN_GAMES = {
  'minecraft.windows.exe': 'Minecraft', 'minecraftlauncher.exe': 'Minecraft Launcher',
  'robloxplayerbeta.exe': 'Roblox', 'fortniteclient-win64-shipping.exe': 'Fortnite', 'valorant-win64-shipping.exe': 'VALORANT',
  'league of legends.exe': 'League of Legends', 'cs2.exe': 'Counter-Strike 2', 'gta5.exe': 'Grand Theft Auto V', 'gta5_enhanced.exe': 'Grand Theft Auto V',
  'overwatch.exe': 'Overwatch 2', 'rocketleague.exe': 'Rocket League', 'r5apex.exe': 'Apex Legends', 'r5apex_dx12.exe': 'Apex Legends',
  'cod.exe': 'Call of Duty', 'destiny2.exe': 'Destiny 2', 'eldenring.exe': 'Elden Ring', 'genshinimpact.exe': 'Genshin Impact',
  'terraria.exe': 'Terraria', 'stardew valley.exe': 'Stardew Valley', 'among us.exe': 'Among Us', 'fallguys_client_game.exe': 'Fall Guys',
  'dota2.exe': 'Dota 2', 'rainbowsix.exe': 'Rainbow Six Siege', 'pubg.exe': 'PUBG', 'tslgame.exe': 'PUBG', 'starrail.exe': 'Honkai: Star Rail',
  'marvel-win64-shipping.exe': 'Marvel Rivals', 'deadlock.exe': 'Deadlock', 'helldivers2.exe': 'Helldivers 2', 'palworld-win64-shipping.exe': 'Palworld',
  'sims4.exe': 'The Sims 4', 'ts4_x64.exe': 'The Sims 4', 'witcher3.exe': 'The Witcher 3', 'cyberpunk2077.exe': 'Cyberpunk 2077', 'bg3.exe': "Baldur's Gate 3", 'bg3_dx11.exe': "Baldur's Gate 3",
};
const BROWSERS = { 'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'firefox.exe': 'Firefox', 'brave.exe': 'Brave', 'opera.exe': 'Opera', 'opera_gx.exe': 'Opera GX', 'vivaldi.exe': 'Vivaldi' };
const KNOWN_APPS = {
  'discord.exe': 'Discord', 'spotify.exe': 'Spotify', 'steam.exe': 'Steam', 'steamwebhelper.exe': 'Steam', 'epicgameslauncher.exe': 'Epic Games Launcher',
  'code.exe': 'Visual Studio Code', 'explorer.exe': 'File Explorer', 'winword.exe': 'Word', 'excel.exe': 'Excel', 'powerpnt.exe': 'PowerPoint',
  'notepad.exe': 'Notepad', 'teams.exe': 'Teams', 'ms-teams.exe': 'Teams', 'zoom.exe': 'Zoom', 'obs64.exe': 'OBS Studio', 'vlc.exe': 'VLC',
  'whatsapp.exe': 'WhatsApp', 'telegram.exe': 'Telegram', 'tiktok.exe': 'TikTok', 'netflix.exe': 'Netflix', 'xboxpcapp.exe': 'Xbox app',
  'battle.net.exe': 'Battle.net', 'riotclientux.exe': 'Riot Client', 'windowsterminal.exe': 'Terminal', 'cmd.exe': 'Command Prompt', 'powershell.exe': 'PowerShell',
  'applicationframehost.exe': '', 'vels syndicate.exe': 'VELS Syndicate',
};
const IGNORE_EXE = new Set(['lockapp.exe', 'searchhost.exe', 'searchapp.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe']);
// websites that mean something on their own (shown nicely)
const SITE_NAMES = { 'youtube.com': 'YouTube', 'twitch.tv': 'Twitch', 'tiktok.com': 'TikTok', 'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'x.com': 'X', 'twitter.com': 'X', 'facebook.com': 'Facebook', 'discord.com': 'Discord', 'roblox.com': 'Roblox', 'netflix.com': 'Netflix', 'google.com': 'Google', 'wikipedia.org': 'Wikipedia', 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'github.com': 'GitHub', 'spotify.com': 'Spotify', 'amazon.com': 'Amazon', 'pinterest.com': 'Pinterest', 'snapchat.com': 'Snapchat', 'crazygames.com': 'CrazyGames', 'poki.com': 'Poki', 'coolmathgames.com': 'Coolmath Games' };

function siteFromUrl(u) {
  if (!u || typeof u !== 'string') return '';
  let s = u.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  try {
    const h = new URL(s).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    if (!h || !h.includes('.') || /\s/.test(h)) return '';
    return h;
  } catch { return ''; }
}
// The exact page address, cleaned: only http(s), no saved passwords or #fragments, at most 600 characters.
function pageUrl(u) {
  if (!u || typeof u !== 'string') return '';
  let s = u.trim();
  if (!s || /\s/.test(s)) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const x = new URL(s);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return '';
    if (!x.hostname.includes('.')) return '';
    x.username = ''; x.password = ''; x.hash = '';
    let out = x.toString();
    if (out.length > 600) out = x.origin + x.pathname.slice(0, 400);
    return out;
  } catch { return ''; }
}
function siteLabel(host) {
  if (!host) return '';
  for (const [d, n] of Object.entries(SITE_NAMES)) if (host === d || host.endsWith('.' + d)) return n;
  return host;
}
function titleCase(s) { return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(); }

// Turns one sample from the helper into "what is the kid doing".
function classify(sample) {
  const title = String(sample.title || '').trim().slice(0, 300);
  const p = String(sample.path || '');
  const idle = +sample.idle || 0;
  const exe = p.split(/[\\/]/).pop().toLowerCase();
  if (!p && !title) return { kind: 'locked', app: 'Locked or signed out', detail: '', site: '' };
  if (IGNORE_EXE.has(exe)) return { kind: exe === 'lockapp.exe' ? 'locked' : 'app', app: exe === 'lockapp.exe' ? 'Locked or signed out' : 'Windows', detail: '', site: '' };
  let r;
  // games installed through stores — the folder name is the game's name
  const store = p.match(/[\\/](?:steamapps[\\/]common|Epic Games|XboxGames|Riot Games|GOG Galaxy[\\/]Games|EA Games|Ubisoft Game Launcher[\\/]games)[\\/]([^\\/]+)[\\/]/i);
  if (KNOWN_GAMES[exe]) r = { kind: 'game', app: KNOWN_GAMES[exe] };
  else if ((exe === 'javaw.exe' || exe === 'java.exe') && /^minecraft/i.test(title)) r = { kind: 'game', app: 'Minecraft' };
  else if (/[\\/]Roblox[\\/]Versions[\\/]/i.test(p)) r = { kind: 'game', app: 'Roblox' };
  else if (store && !/launcher|crashreport|unins/i.test(exe)) r = { kind: 'game', app: store[1].replace(/\s+/g, ' ').trim() };
  if (r) {
    // game mode, when the game puts it in its window title (e.g. "Minecraft 1.21 - Multiplayer (3rd-party Server)")
    let detail = '';
    const m = title.match(/^\s*Minecraft[^-]*-\s*(.+)$/i);
    if (r.app === 'Minecraft' && m) detail = m[1];
    else if (title && title.toLowerCase() !== r.app.toLowerCase() && title.length < 80 && !/^(unity|unreal|d3d|directx|window)/i.test(title)) detail = title;
    return Object.assign(r, { detail, site: '', idle: idle >= IDLE_AFTER });
  }
  if (BROWSERS[exe]) {
    const pageTitle = title.replace(/\s*[-—–]\s*(Google Chrome|Microsoft\u200b? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Personal|Work)(\s*[-—–]\s*.*)?$/i, '').replace(/\s*and \d+ more pages?$/i, '').trim();
    const host = siteFromUrl(sample.url);
    return { kind: 'browser', app: BROWSERS[exe], detail: pageTitle, site: host ? siteLabel(host) : '', host, url: host ? pageUrl(sample.url) : '', idle: idle >= IDLE_AFTER };
  }
  const name = KNOWN_APPS[exe] !== undefined ? (KNOWN_APPS[exe] || title.slice(0, 60) || 'App') : titleCase(exe.replace(/\.exe$/, '')) || 'App';
  return { kind: 'app', app: name, detail: '', site: '', idle: idle >= IDLE_AFTER };
}

// ---------- history storage: one small file per day ----------
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

class ActivityMonitor extends EventEmitter {
  constructor({ dir, includeUrls = true, keepDays = 30, source = null }) {
    super();
    this.dir = dir;
    this.includeUrls = includeUrls;
    this.keepDays = keepDays;
    this.source = source;            // tests can feed samples instead of the Windows helper
    this.current = null;             // {kind, app, detail, site, since}
    this.proc = null;
    this.running = false;
    this.restarts = 0;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get supported() { return process.platform === 'win32' || !!this.source; }

  start() {
    if (this.running) return;
    this.running = true;
    this._prune();
    this.pruneTimer = setInterval(() => this._prune(), 6 * 3600 * 1000);
    if (this.source) { this.source.on('sample', s => this.feed(s)); return; }
    if (process.platform !== 'win32') return;
    this._spawn();
  }

  _spawn() {
    const encoded = Buffer.from(HELPER_PS, 'utf16le').toString('base64');
    const env = Object.assign({}, process.env, { VELS_URLS: this.includeUrls ? '1' : '0' });
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      buf += d;
      if (buf.length > 65536) buf = buf.slice(-8192);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { this.feed(JSON.parse(line)); this.restarts = 0; } catch {}
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      if (!this.running) return;
      this.restarts++;
      setTimeout(() => { if (this.running) this._spawn(); }, Math.min(60000, 2000 * this.restarts));
    });
  }

  setIncludeUrls(v) {
    this.includeUrls = !!v;
    if (this.proc) { try { this.proc.kill(); } catch {} } // restarts with the new setting
  }

  stop() {
    this.running = false;
    clearInterval(this.pruneTimer);
    this._close(Date.now());
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  feed(sample, now = Date.now()) {
    const c = classify(sample);
    if (!this.includeUrls) { c.site = ''; c.host = ''; c.url = ''; }
    let next;
    if (c.idle) next = { kind: 'away', app: 'Away', detail: this.current && this.current.kind !== 'away' ? this.current.app : (this.current ? this.current.detail : ''), site: '' };
    else next = { kind: c.kind, app: c.app, detail: c.detail || '', site: c.site || '', url: c.url || '' };
    const cur = this.current;
    // browsers: a new session per page (per website when the address isn't known); games/apps: per program
    const samePage = next.url ? cur && cur.url === next.url : cur && cur.site === next.site;
    const same = cur && cur.kind === next.kind && cur.app === next.app && (next.kind !== 'browser' || samePage) && (next.kind !== 'game' || cur.detail === next.detail || !next.detail);
    if (same) {
      if (next.kind === 'browser' && next.detail && next.detail !== cur.detail) { cur.detail = next.detail; this.emit('change', this.status(now)); }
      return;
    }
    const start = cur && next.kind === 'away' ? now - (+sample.idle || 0) * 1000 : now;
    this._close(start);
    this.current = Object.assign(next, { since: start });
    this.emit('change', this.status(now));
  }

  _close(end) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    if (end - cur.since < MIN_SESSION_MS) return;
    this._append(Object.assign({ start: cur.since, end, kind: cur.kind, app: cur.app, detail: cur.detail, site: cur.site }, cur.url ? { url: cur.url } : {}));
  }

  _append(entry) {
    try {
      // sessions that cross midnight are split so each day file is complete
      let s = entry.start;
      while (dayKey(s) !== dayKey(entry.end)) {
        const d = new Date(s); const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        fs.appendFileSync(path.join(this.dir, dayKey(s) + '.jsonl'), JSON.stringify(Object.assign({}, entry, { start: s, end: midnight })) + '\n', { mode: 0o600 });
        s = midnight;
      }
      fs.appendFileSync(path.join(this.dir, dayKey(s) + '.jsonl'), JSON.stringify(Object.assign({}, entry, { start: s })) + '\n', { mode: 0o600 });
    } catch {}
  }

  status(now = Date.now()) {
    if (!this.current) return null;
    const c = this.current;
    return { kind: c.kind, app: c.app, detail: c.detail, site: c.site, since: c.since, now };
  }

  history(daysAgo = 0, now = Date.now()) {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - Math.max(0, Math.min(400, daysAgo | 0)));
    const key = dayKey(d.getTime());
    let entries = [];
    try {
      entries = fs.readFileSync(path.join(this.dir, key + '.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    if (daysAgo === 0 && this.current) entries.push(Object.assign({ start: this.current.since, end: now, kind: this.current.kind, app: this.current.app, detail: this.current.detail, site: this.current.site, live: true }, this.current.url ? { url: this.current.url } : {}));
    if (entries.length > 5000) entries = entries.slice(-5000);
    return { day: key, entries };
  }

  _prune() {
    const cutoff = Date.now() - this.keepDays * 86400000;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
        if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) fs.unlinkSync(path.join(this.dir, f));
      }
    } catch {}
  }

  // how much history is saved on this PC (for the "manage storage" rows)
  storage() {
    let bytes = 0, days = 0, oldest = '';
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        try { bytes += fs.statSync(path.join(this.dir, f)).size; days++; if (!oldest || f < oldest) oldest = f.slice(0, 10); } catch {}
      }
    } catch {}
    return { bytes, days, oldest, keepDays: this.keepDays };
  }

  wipe() { try { for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.jsonl')) fs.unlinkSync(path.join(this.dir, f)); } catch {} }
}

module.exports = { ActivityMonitor, classify, siteFromUrl, pageUrl, siteLabel, dayKey, HELPER_PS };
