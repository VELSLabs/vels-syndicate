'use strict';
// Short "what is this website?" lines for the Family history.
// 1) A built-in list for popular sites (instant, no internet).
// 2) For other sites, the MAIN PC reads the site's own one-line description from its home page once,
//    then remembers it (site-info.json). Only the home page is read, never the page the kid visited.
// Lookups only go to public websites: local/private network addresses are refused, also after redirects.
const fs = require('fs');
const dns = require('dns');
const http = require('http');
const https = require('https');
const V = require('./validate');

const BUILTIN = {
  'youtube.com': 'Video sharing site', 'youtu.be': 'Video sharing site', 'twitch.tv': 'Live game streaming', 'kick.com': 'Live streaming site',
  'tiktok.com': 'Short video social app', 'instagram.com': 'Photo and video social network', 'facebook.com': 'Social network',
  'x.com': 'Social network (formerly Twitter)', 'twitter.com': 'Social network (now X)', 'threads.net': 'Text social network by Instagram',
  'reddit.com': 'Discussion forums on every topic', 'discord.com': 'Chat and voice app for communities', 'snapchat.com': 'Photo messaging app',
  'pinterest.com': 'Image ideas and inspiration boards', 'tumblr.com': 'Blogging and social site', 'bsky.app': 'Social network (Bluesky)',
  'whatsapp.com': 'Messaging app', 'web.whatsapp.com': 'Messaging app (web)', 'telegram.org': 'Messaging app', 'messenger.com': 'Facebook chat',
  'netflix.com': 'Movies and TV streaming', 'disneyplus.com': 'Disney movies and shows', 'hulu.com': 'TV and movie streaming', 'max.com': 'HBO movies and shows',
  'primevideo.com': 'Amazon movies and shows', 'crunchyroll.com': 'Anime streaming', 'peacocktv.com': 'TV and movie streaming', 'paramountplus.com': 'TV and movie streaming',
  'tubitv.com': 'Free movies and TV', 'pluto.tv': 'Free live TV', 'vimeo.com': 'Video sharing site', 'dailymotion.com': 'Video sharing site',
  'spotify.com': 'Music streaming', 'music.youtube.com': 'Music streaming', 'soundcloud.com': 'Music sharing', 'pandora.com': 'Music streaming', 'music.apple.com': 'Music streaming',
  'roblox.com': 'Online game platform', 'minecraft.net': 'Official Minecraft site', 'epicgames.com': 'Game store (Fortnite)', 'fortnite.com': 'Official Fortnite site',
  'steampowered.com': 'Game store (Steam)', 'store.steampowered.com': 'Game store (Steam)', 'steamcommunity.com': 'Steam gamer community', 'ea.com': 'Video game publisher',
  'xbox.com': 'Xbox games and accounts', 'playstation.com': 'PlayStation games and accounts', 'nintendo.com': 'Nintendo games', 'itch.io': 'Indie game store',
  'crazygames.com': 'Free browser games', 'poki.com': 'Free browser games', 'coolmathgames.com': 'Free browser games for kids', 'miniclip.com': 'Free browser games',
  'friv.com': 'Free browser games', 'y8.com': 'Free browser games', 'kongregate.com': 'Free browser games', 'agame.com': 'Free browser games', 'armorgames.com': 'Free browser games',
  'chess.com': 'Play chess online', 'lichess.org': 'Play chess online', 'geoguessr.com': 'Geography guessing game', 'krunker.io': 'Browser shooter game', 'slither.io': 'Browser snake game',
  'agar.io': 'Browser multiplayer game', 'shellshock.io': 'Browser shooter game', 'smashkarts.io': 'Browser kart game', 'curseforge.com': 'Game mods and add-ons',
  'modrinth.com': 'Minecraft mods', 'planetminecraft.com': 'Minecraft community and maps', 'fandom.com': 'Fan wikis for games and shows', 'ign.com': 'Game news and reviews',
  'gamespot.com': 'Game news and reviews', 'speedrun.com': 'Game speedrun records',
  'google.com': 'Search engine', 'bing.com': 'Search engine', 'duckduckgo.com': 'Private search engine', 'yahoo.com': 'Search, news and email',
  'wikipedia.org': 'Free online encyclopedia', 'britannica.com': 'Online encyclopedia', 'dictionary.com': 'Online dictionary', 'merriam-webster.com': 'Online dictionary',
  'khanacademy.org': 'Free school lessons and practice', 'quizlet.com': 'Study flashcards', 'kahoot.it': 'Classroom quiz game', 'kahoot.com': 'Classroom quiz games',
  'duolingo.com': 'Language learning', 'brainpop.com': 'Educational videos for kids', 'ixl.com': 'School practice exercises', 'prodigygame.com': 'Math learning game',
  'code.org': 'Learn to code', 'scratch.mit.edu': 'Kids coding projects', 'desmos.com': 'Online graphing calculator', 'mathway.com': 'Math problem solver',
  'photomath.com': 'Math homework helper', 'chegg.com': 'Homework help', 'coursehero.com': 'Homework help', 'brainly.com': 'Homework questions and answers',
  'classroom.google.com': 'Google Classroom (school)', 'docs.google.com': 'Google Docs, Sheets and Slides', 'drive.google.com': 'Google Drive files',
  'canvas.instructure.com': 'School course website', 'instructure.com': 'School course website (Canvas)', 'schoology.com': 'School course website', 'clever.com': 'School app login',
  'edpuzzle.com': 'School video lessons', 'nearpod.com': 'School lessons', 'blooket.com': 'Classroom quiz games', 'gimkit.com': 'Classroom quiz games', 'quizizz.com': 'Classroom quizzes',
  'grammarly.com': 'Writing checker', 'canva.com': 'Design and graphics maker', 'office.com': 'Microsoft Office online', 'microsoft.com': 'Microsoft',
  'outlook.com': 'Email', 'outlook.live.com': 'Email', 'mail.google.com': 'Email (Gmail)', 'icloud.com': 'Apple account and files', 'apple.com': 'Apple',
  'chatgpt.com': 'AI chatbot', 'openai.com': 'AI company (ChatGPT)', 'claude.ai': 'AI assistant', 'gemini.google.com': 'AI chatbot by Google', 'copilot.microsoft.com': 'AI chatbot by Microsoft',
  'character.ai': 'AI character chat', 'perplexity.ai': 'AI search engine', 'github.com': 'Code sharing for programmers', 'stackoverflow.com': 'Programming questions and answers',
  'amazon.com': 'Online shopping', 'ebay.com': 'Online shopping and auctions', 'walmart.com': 'Online shopping', 'target.com': 'Online shopping', 'etsy.com': 'Handmade goods shop',
  'temu.com': 'Online discount shopping', 'shein.com': 'Online clothing shop', 'aliexpress.com': 'Online shopping', 'bestbuy.com': 'Electronics store',
  'paypal.com': 'Online payments', 'cash.app': 'Money transfer app', 'venmo.com': 'Money transfer app',
  'cnn.com': 'News', 'foxnews.com': 'News', 'nytimes.com': 'News', 'bbc.com': 'News', 'bbc.co.uk': 'News', 'apnews.com': 'News', 'reuters.com': 'News', 'espn.com': 'Sports news and scores',
  'weather.com': 'Weather forecasts', 'maps.google.com': 'Maps and directions', 'imdb.com': 'Movie and TV info', 'rottentomatoes.com': 'Movie reviews',
  'zoom.us': 'Video calls', 'meet.google.com': 'Video calls', 'teams.microsoft.com': 'Chat and video calls', 'linkedin.com': 'Professional social network',
  'quora.com': 'Questions and answers', 'medium.com': 'Articles and blogs', 'archive.org': 'Internet archive and old websites', 'imgur.com': 'Image sharing',
  'giphy.com': 'Animated GIFs', 'deviantart.com': 'Art sharing community', 'artstation.com': 'Art portfolios', 'wattpad.com': 'Online stories and books',
  'webtoons.com': 'Online comics', 'omegle.com': 'Random video chat with strangers', 'ome.tv': 'Random video chat with strangers', 'chatroulette.com': 'Random video chat with strangers',
};

const OK_DAYS = 90, BAD_DAYS = 7, MAX_BODY = 256 * 1024, TIMEOUT_MS = 5000;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function builtin(host) {
  for (let h = host; h && h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (BUILTIN[h]) return BUILTIN[h];
  return '';
}

// public internet addresses only (no home/office network, no loopback, no multicast, no reserved)
function isPublicIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  if (V.isLocalAddress(ip)) return false;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) { const a = +m[1]; return a !== 0 && a < 224; }
  return ip.includes(':') && ip !== '::' && !/^(ff|fe8|fe9|fea|feb|fc|fd)/i.test(ip);
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'nbsp') return ' ';
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}

// <meta name="description" content="..."> or og:description, from the first part of the page
function extractDescription(html) {
  const head = html.slice(0, MAX_BODY);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  let best = '';
  for (const tag of metas) {
    const name = (tag.match(/\b(?:name|property)\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (!/^(description|og:description|twitter:description)$/i.test(name)) continue;
    const content = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1] || '';
    if (content && (!best || /^description$/i.test(name))) best = content;
    if (best && /^description$/i.test(name)) break;
  }
  let d = V.cleanText(decodeEntities(best).replace(/\s+/g, ' ').trim(), 400);
  if (!d) return '';
  // one short line: first sentence, at most ~110 characters
  const first = d.split(/(?<=[.!?])\s/)[0];
  if (first.length >= 12) d = first;
  if (d.length > 110) d = d.slice(0, 107).replace(/\s+\S*$/, '') + '…';
  return d;
}

// A small GET that checks the address at the moment it connects (so a site can't pass the check with a
// public address and then switch to a home-network one: "DNS rebinding"). Returns a fetch-like answer.
function safeGet(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error('Only web addresses'));
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (require('net').isIP(bare) && !isPublicIp(bare)) return reject(new Error('Not a public address'));
    const lookup = (host, opts, cb) => dns.lookup(host, Object.assign({}, opts, { all: true }), (err, list) => {
      if (err) return cb(err);
      const ok = (list || []).filter(a => isPublicIp(a.address));
      if (!ok.length || ok.length !== list.length) return cb(new Error('Not a public address'));
      if (opts && opts.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
    const req = mod.get(u, { headers, lookup, timeout: TIMEOUT_MS }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { if (size < MAX_BODY) { chunks.push(c); size += c.length; } if (size >= MAX_BODY) res.destroy(); });
      const done = () => {
        const body = Buffer.concat(chunks).subarray(0, MAX_BODY).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: { get: k => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : v || null; } }, text: async () => body });
      };
      res.on('end', done); res.on('close', done); res.on('error', done);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
  });
}

class SiteInfo {
  constructor({ file, fetchImpl, lookup, now = Date.now } = {}) {
    this.file = file;
    this.fetch = fetchImpl || safeGet;
    this.lookup = lookup || ((host) => dns.promises.lookup(host, { all: true }));
    this.now = now;
    this.cache = {};
    this.inflight = new Map();
    try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (raw && typeof raw === 'object') this.cache = raw; } catch {}
  }

  _save() {
    if (!this.file) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      const keys = Object.keys(this.cache);
      if (keys.length > 3000) for (const k of keys.sort((a, b) => this.cache[a].at - this.cache[b].at).slice(0, keys.length - 3000)) delete this.cache[k];
      try { fs.writeFileSync(this.file, JSON.stringify(this.cache), { mode: 0o600 }); } catch {}
    }, 500);
    if (this._t.unref) this._t.unref();
  }

  // { host: description } for the hosts asked about. Built-in ones are instant; others are looked up (lookup=true).
  async describe(hosts, { lookup = true, max = 25 } = {}) {
    const out = {};
    const todo = [];
    for (const raw of [...new Set((hosts || []).slice(0, 500))]) {
      const host = String(raw || '').toLowerCase().replace(/^www\./, '');
      if (!HOST_RE.test(host)) continue;
      const b = builtin(host);
      if (b) { out[raw] = b; continue; }
      const c = this.cache[host];
      const fresh = c && this.now() - c.at < (c.d ? OK_DAYS : BAD_DAYS) * 86400000;
      if (fresh) { if (c.d) out[raw] = c.d; continue; }
      if (lookup && todo.length < max) todo.push([raw, host]);
    }
    // a few at a time, so opening history never floods the network
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async ([raw, host]) => {
        const d = await this._lookupOnce(host);
        if (d) out[raw] = d;
      }));
    }
    return out;
  }

  _lookupOnce(host) {
    if (this.inflight.has(host)) return this.inflight.get(host);
    const p = this._fetchDescription(host).catch(() => '').then(d => {
      this.cache[host] = { d: d || '', at: this.now() };
      this._save();
      this.inflight.delete(host);
      return d || '';
    });
    this.inflight.set(host, p);
    return p;
  }

  async _fetchDescription(host) {
    let url = `https://${host}/`;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return '';
      if (u.port && !['80', '443'].includes(u.port)) return '';
      const h = u.hostname.toLowerCase();
      if (!HOST_RE.test(h)) return '';
      const addrs = await this.lookup(h);
      const list = Array.isArray(addrs) ? addrs : [addrs];
      if (!list.length || !list.every(a => isPublicIp(a && a.address ? a.address : a))) return '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await this.fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (VELS Syndicate site description)' } });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
          if (!loc) return '';
          url = new URL(loc, url).toString();
          continue;
        }
        if (!res.ok) return '';
        const type = res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : 'text/html';
        if (!/html/i.test(type)) return '';
        const html = await readLimited(res, MAX_BODY);
        return extractDescription(html);
      } finally { clearTimeout(timer); }
    }
    return '';
  }
}

async function readLimited(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < max) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); size += value.length;
    }
    try { reader.cancel(); } catch {}
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
  }
  return String(await res.text()).slice(0, max);
}

module.exports = { SiteInfo, builtin, extractDescription, isPublicIp, BUILTIN };
