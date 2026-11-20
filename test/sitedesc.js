// Website descriptions for the Family history: run with  npm test
const { SiteInfo, extractDescription, isPublicIp } = require('../src/core/sitedesc');
const { pageUrl } = require('../src/core/activity');
const fs = require('fs'), os = require('os'), path = require('path');
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-site-'));

const PAGES = {
  'https://kidsite.example.org/': { type: 'text/html', body: '<html><head><title>x</title><meta name="description" content="Fun science experiments for kids &amp; parents. Lots more here."></head></html>' },
  'https://ogonly.example.com/': { type: 'text/html; charset=utf-8', body: '<meta property="og:description" content="A place to share recipes">' },
  'https://moved.example.com/': { status: 301, location: 'https://www.moved.example.com/home' },
  'https://www.moved.example.com/home': { type: 'text/html', body: '<meta name=description content="Moved site">' },
  'https://sneaky.example.com/': { status: 302, location: 'http://intranet.example.com/' },
  'https://image.example.com/': { type: 'image/png', body: 'PNG' },
};
const DNS = { 'kidsite.example.org': '93.184.216.34', 'ogonly.example.com': '93.184.216.35', 'moved.example.com': '93.184.216.36', 'www.moved.example.com': '93.184.216.37', // privacy-check: ignore (made-up test values)
  'sneaky.example.com': '93.184.216.38', 'intranet.example.com': '192.168.1.10', 'router.example.net': '10.0.0.1', 'image.example.com': '93.184.216.39' }; // privacy-check: ignore (made-up test values)
let fetched = [];
const fetchImpl = async (url) => {
  fetched.push(url);
  const p = PAGES[url];
  if (!p) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  const status = p.status || 200;
  return { ok: status < 300, status, headers: { get: k => (k === 'location' ? p.location : k === 'content-type' ? p.type : null) }, text: async () => p.body };
};
const lookup = async host => { if (!DNS[host]) throw new Error('ENOTFOUND'); return [{ address: DNS[host], family: 4 }]; };

(async () => {
  const si = new SiteInfo({ file: path.join(tmp, 'site-info.json'), fetchImpl, lookup });
  let r = await si.describe(['youtube.com', 'm.youtube.com', 'kidsite.example.org', 'ogonly.example.com', 'moved.example.com', 'router.example.net', 'sneaky.example.com', 'image.example.com', '192.168.1.1', 'bad host']);
  check('popular sites come from the built-in list (no internet)', r['youtube.com'] === 'Video sharing site' && r['m.youtube.com'] === 'Video sharing site' && !fetched.some(u => u.includes('youtube')));
  check("other sites use the site's own one-line description", r['kidsite.example.org'] === 'Fun science experiments for kids & parents.');
  check('og:description works too', r['ogonly.example.com'] === 'A place to share recipes');
  check('redirects to public sites are followed', r['moved.example.com'] === 'Moved site');
  check('a site on the home network is never contacted', !r['router.example.net'] && !fetched.some(u => u.includes('router.example.net')));
  check('a redirect into the home network is refused', !r['sneaky.example.com'] && !fetched.some(u => u.includes('intranet')));
  check('non-web pages and raw IP addresses are skipped', !r['image.example.com'] && !r['192.168.1.1'] && !r['bad host']);
  const n = fetched.length;
  r = await si.describe(['kidsite.example.org', 'router.example.net']);
  check('descriptions are remembered (no second lookup)', fetched.length === n && r['kidsite.example.org']);
  await new Promise(res => setTimeout(res, 700));
  const si2 = new SiteInfo({ file: path.join(tmp, 'site-info.json'), fetchImpl, lookup });
  r = await si2.describe(['kidsite.example.org'], { lookup: false });
  check('…and survive a restart', r['kidsite.example.org'] === 'Fun science experiments for kids & parents.');
  check('public vs private addresses', isPublicIp('8.8.8.8') && !isPublicIp('127.0.0.1') && !isPublicIp('192.168.0.5') && !isPublicIp('169.254.1.1') && !isPublicIp('0.0.0.0') && !isPublicIp('::1') && !isPublicIp('fd00::1')); // privacy-check: ignore (made-up test values)
  check('long descriptions are shortened to one line', extractDescription('<meta name="description" content="' + 'word '.repeat(60) + '">').length <= 110);
  check('exact page addresses are cleaned', pageUrl('youtube.com/watch?v=abc#t=5') === 'https://youtube.com/watch?v=abc' && pageUrl('https://user:pw@site.com/x') === 'https://site.com/x' && pageUrl('chrome://settings') === '' && pageUrl('file:///C:/x') === ''); // privacy-check: ignore (made-up test values)
  // the real downloader also refuses local addresses at the moment it connects (DNS rebinding)
  const real = new SiteInfo({});
  const refused = await Promise.allSettled(['http://127.0.0.1:9/', 'http://[::1]:9/', 'http://localhost:9/'].map(u => real.fetch(u)));
  check('the downloader itself refuses local addresses', refused.every(r => r.status === 'rejected' && /public address/.test(r.reason.message)));
  console.log(failures ? `\n${failures} site check(s) FAILED` : '\nAll site description checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
