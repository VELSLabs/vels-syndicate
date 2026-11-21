// Phones and tablets: pairing by QR code, encrypted upload/download, resume, and refusing strangers.
// Run with  npm test
const { VelsNode } = require('../src/core/node');
const P = require('../src/core/phones');
const nacl = require('../src/vendor/nacl-fast');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-phone-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined && !ok ? ' ' + JSON.stringify(extra) : ''}`); if (!ok) failures++; };

// ---- a pretend phone: does exactly what src/phone/phone.js does ----
function req(port, pathname, body, headers = {}, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: (typeof port === 'number' ? port : port),  path: pathname, method: body == null ? 'GET' : 'POST', headers: Object.assign({ Host: `${host}:${port}`, 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' }, headers) }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    r.on('error', reject);
    if (body != null) r.end(body); else r.end();
  });
}
class Phone {
  constructor(port, name) { this.port = port; this.name = name; }
  async pair(code) {
    const { token, key } = P.deriveFromCode(code);
    this.tok = token; this.pk = key; this.rid = crypto.randomBytes(12).toString('hex');
    const box = P.seal(key, P.frame({ rid: this.rid, ts: Date.now(), name: this.name })).toString('base64');
    const r = await req(this.port, '/api/pair', JSON.stringify({ tok: token, box }), { 'Content-Type': 'application/json' });
    return { status: r.status, json: JSON.parse(r.body.toString() || '{}') };
  }
  async waitOnce() {
    const box = P.seal(this.pk, P.frame({ rid: this.rid, ts: Date.now() })).toString('base64');
    const r = await req(this.port, '/api/pair-wait', JSON.stringify({ tok: this.tok, box }), { 'Content-Type': 'application/json' });
    const j = JSON.parse(r.body.toString());
    if (j.state === 'approved') { const u = P.unframe(P.open(this.pk, Buffer.from(j.box, 'base64'))); this.id = u.obj.phoneId; this.key = new Uint8Array(Buffer.from(u.obj.key, 'base64')); this.pcName = u.obj.pcName; }
    return j.state;
  }
  async api(op, obj = {}, data, opts = {}) {
    const m = Object.assign({ op, ts: opts.ts || Date.now(), n: opts.n || crypto.randomBytes(12).toString('hex') }, obj);
    const body = opts.raw || P.seal(opts.key || this.key, P.frame(m, data));
    const r = await req(this.port, '/api/x', body, { 'X-Vels-Id': opts.id || this.id, 'Content-Type': 'application/octet-stream' });
    if (r.status !== 200) return { status: r.status };
    const u = P.unframe(P.open(this.key, r.body));
    return Object.assign({ status: 200, data: u.data }, u.obj);
  }
  async upload(buf, name, opts = {}) {
    const s = await this.api('up-start', Object.assign({ name, size: buf.length, to: opts.to }, opts.nasDir != null ? { nasDir: opts.nasDir } : {}));
    if (s.error) return s;
    let off = s.have;
    const stopAt = opts.stopAt == null ? Infinity : opts.stopAt;
    while (off < buf.length) {
      if (off >= stopAt) return { fid: s.fid, stopped: off };
      const r = await this.api('up-chunk', { fid: s.fid, off }, buf.subarray(off, off + (opts.chunk || 65536)));
      if (r.error) return r;
      off = r.have;
    }
    return Object.assign({ fid: s.fid, resumedFrom: s.have }, await this.api('up-end', { fid: s.fid }));
  }
  async download(fid, size) {
    const parts = []; let off = 0;
    while (off < size) { const r = await this.api('dl-chunk', { fid, off, len: 65536 }); if (r.error) return r; parts.push(r.data); off += r.data.length; if (!r.data.length) break; }
    await this.api('dl-done', { fid });
    return { buf: Buffer.concat(parts) };
  }
}

(async () => {
  const dataDir = path.join(tmp, 'pc'), recv = path.join(tmp, 'recv');
  const store = { kind: 'os', encrypt: s => 'K:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
  let pc = new VelsNode({ dataDir, tcpPort: 0, phonePort: 0, discovery: false, secretStore: store });
  pc.updateSettings({ name: 'Desktop 1', receiveDir: recv });
  await pc.start();
  const asks = []; pc.on('phone-request', r => asks.push(r));

  // ---- the page and its safety headers ----
  let pair = await pc.phoneConnect();
  const port = pc.phones.port;
  check('the QR code is a link to this PC with the code after #', /^http:\/\/[\d.]+:\d+\/#[0-9A-Z]{20}$/.test(pair.url) && pair.qr.startsWith('<svg'));
  const page = await req(port, '/');
  check('the phone page loads', page.status === 200 && /VELS/.test(page.body.toString()));
  check('the page is locked down (no outside scripts, no framing)', /script-src 'self'/.test(page.headers['content-security-policy'] || '') && page.headers['x-frame-options'] === 'DENY');
  check('a page asked for under a website name is refused (stops DNS rebinding)', (await req(port, '/', null, {}, 'evil.example')).status === 421);
  check('unknown pages are not served', (await req(port, '/../package.json')).status === 404 && (await req(port, '/src/core/node.js')).status === 404);

  // ---- pairing ----
  const bad = new Phone(port, 'Nope');
  check('a wrong code is refused', (await bad.pair('AAAA-BBBB-CCCC-DDDD-EEEE')).status === 404);
  const phone = new Phone(port, 'Mom’s iPhone');
  const hello = await phone.pair(pair.code);
  check('scanning the code asks the PC', hello.status === 200 && await until(() => asks.length === 1));
  check('…and says what kind of device it is', asks[0] && asks[0].kind === 'iPhone' && asks[0].name === 'Mom’s iPhone');
  check('the phone waits until the PC answers', (await phone.waitOnce()) === 'waiting');
  const thief = new Phone(port, 'Thief');
  check('a second device can\'t use the same code', (await thief.pair(pair.code)).status === 409);
  pc.phoneAnswer(asks[0].sid, true, 'Mom’s iPhone', true);
  check('once allowed, the phone gets its own key', (await phone.waitOnce()) === 'approved' && phone.key && phone.key.length === 32 && phone.pcName === 'Desktop 1');
  check('the code can\'t be used again', (await new Phone(port, 'x').pair(pair.code)).status === 404);
  check('the PC lists the phone', pc.getState().phones.some(p => p.name === 'Mom’s iPhone' && p.online));

  // denied
  pair = await pc.phoneConnect();
  const kid = new Phone(port, 'Kid phone');
  await kid.pair(pair.code); await until(() => asks.length === 2);
  pc.phoneAnswer(asks[1].sid, false);
  check('a phone the PC denies gets nothing', (await kid.waitOnce()) === 'denied' && !kid.key);
  pc.phoneCancel(pair.sid);

  // ---- encrypted requests ----
  const hi = await phone.api('hi');
  check('the phone can talk to the PC', hi.status === 200 && hi.pcName === 'Desktop 1' && hi.plan === 'Free');
  check('a request with a made-up key is refused', (await phone.api('hi', {}, null, { key: new Uint8Array(32) })).status === 401);
  check('a request from an unknown phone is refused', (await phone.api('hi', {}, null, { id: 'unknownphone123' })).status === 401);
  const n = 'samenonce1234567';
  await phone.api('hi', {}, null, { n });
  check('a copied (replayed) request is refused', (await phone.api('hi', {}, null, { n })).status === 401);
  check('an old request is refused', (await phone.api('hi', {}, null, { ts: Date.now() - 60 * 60000 })).status === 401);

  // ---- phone → PC ----
  const photo = crypto.randomBytes(300 * 1024);
  const up = await phone.upload(photo, 'IMG_4021.JPG');
  const got = path.join(recv, 'IMG_4021.JPG');
  check('a photo from the phone arrives on the PC', up.ok === true && fs.existsSync(got) && fs.readFileSync(got).equals(photo), up);
  const trIn = [...pc.transfers.values()].find(t => t.id === up.fid);
  check('…and shows in Transfers as from the phone', trIn && trIn.state === 'done' && trIn.peerName === 'Mom’s iPhone');
  check('a sneaky file name stays in the received folder', (await phone.upload(Buffer.from('x'), '../../evil.bat')).ok && fs.existsSync(path.join(recv, 'evil.bat')) && !fs.existsSync(path.join(tmp, 'evil.bat')));
  // resume
  const video = crypto.randomBytes(700 * 1024);
  const half = await phone.upload(video, 'Birthday.mov', { stopAt: 300 * 1024 });
  const resumed = await phone.upload(video, 'Birthday.mov');
  check('a big video that stopped halfway continues where it left off', resumed.ok && resumed.resumedFrom === half.stopped && fs.readFileSync(path.join(recv, 'Birthday.mov')).equals(video), { half, resumed: resumed.resumedFrom });
  // plan limit
  pc.planOverrides = { free: { maxFileBytes: 1000 } };
  const tooBig = await phone.api('up-start', { name: 'huge.mov', size: 5000 });
  check('files over the plan limit are refused before sending', /too big/.test(tooBig.error || ''));
  pc.planOverrides = {};

  // ---- odd files ----
  const empty = await phone.upload(Buffer.alloc(0), 'empty.txt');
  check('an empty file arrives', empty.ok && fs.existsSync(path.join(recv, 'empty.txt')) && fs.statSync(path.join(recv, 'empty.txt')).size === 0);
  const emoji = await phone.upload(Buffer.from('hi'), '🎂 Birthday – día.jpg');
  check('names with emoji and accents arrive intact', emoji.ok && fs.existsSync(path.join(recv, '🎂 Birthday – día.jpg')));
  const reserved = await phone.upload(Buffer.from('x'), 'CON.txt');
  check('Windows-reserved names are renamed safely', reserved.ok && fs.existsSync(path.join(recv, '_CON.txt')));
  const longName = 'a'.repeat(400) + '.mov';
  const lng = await phone.upload(Buffer.from('x'), longName);
  check('very long names are shortened, not refused', lng.ok && fs.readdirSync(recv).some(f => f.startsWith('aaaa') && f.length <= 204));
  await phone.upload(Buffer.from('one'), 'same.jpg'); await phone.upload(Buffer.from('two'), 'same.jpg');
  check('two files with the same name are both kept', fs.existsSync(path.join(recv, 'same.jpg')) && fs.existsSync(path.join(recv, 'same (2).jpg')));

  // ---- junk and attacks don't crash it ----
  const junk = [Buffer.alloc(0), Buffer.from('{}'), Buffer.from('not json'), crypto.randomBytes(5000), Buffer.from(JSON.stringify({ tok: 'x'.repeat(32), box: 'A'.repeat(3000) }))];
  for (const j of junk) { await req(port, '/api/pair', j, { 'Content-Type': 'application/json' }); await req(port, '/api/x', j, { 'X-Vels-Id': phone.id }); }
  check('lots of junk gets that address blocked for a while', (await req(port, '/')).status === 429);
  pc.phones.fails.clear();
  const huge = await req(port, '/api/x', crypto.randomBytes(3 * 1024 * 1024), { 'X-Vels-Id': phone.id }).catch(() => ({ status: 'closed' }));
  check('an oversized request is refused', huge.status === 413 || huge.status === 'closed');
  check('a request from another website is refused', (await req(port, '/api/pair', '{}', { Origin: 'https://evil.example', 'Content-Type': 'application/json' })).status === 403);
  pc.phones.fails.clear(); // the junk above counts as bad requests; start the next part clean
  check('after all that junk, the phone still works', (await phone.api('hi')).status === 200);

  // ---- PC → phone ----
  const song = path.join(tmp, 'Road trip mix.mp3'); fs.writeFileSync(song, crypto.randomBytes(200 * 1024));
  await pc.sendFiles(phone.id, [song]);
  const waiting = [...pc.transfers.values()].find(t => t.phone && t.direction === 'out');
  check('a file sent to the phone waits for it', waiting && waiting.state === 'waiting');
  const inbox = await phone.api('inbox');
  check('the phone sees it in Get from PC', inbox.files.length === 1 && inbox.files[0].name === 'Road trip mix.mp3');
  const dl = await phone.download(inbox.files[0].fid, inbox.files[0].size);
  check('the phone downloads it, byte for byte', dl.buf && dl.buf.equals(fs.readFileSync(song)));
  check('…and the PC marks it done', waiting.state === 'done' && (await phone.api('inbox')).files.length === 0);
  await pc.sendFiles(phone.id, [song]);
  const c2 = [...pc.transfers.values()].find(t => t.phone && t.direction === 'out' && t.state === 'waiting');
  pc.cancelTransfer(c2.id);
  check('a file the PC cancels can\'t be downloaded', !!(await phone.api('dl-chunk', { fid: c2.id, off: 0, len: 100 })).error);

  // ---- phone → phone (through the PC) ----
  pair = await pc.phoneConnect();
  const tablet = new Phone(port, 'Leo’s iPad');
  await tablet.pair(pair.code); await until(() => asks.length === 3);
  pc.phoneAnswer(asks[2].sid, true, 'Leo’s iPad', false);
  await tablet.waitOnce();
  const pic = crypto.randomBytes(50 * 1024);
  const rel = await phone.upload(pic, 'Family photo.jpg', { to: tablet.id });
  const tIn = await tablet.api('inbox');
  check('phone to phone: the file waits for the other phone', rel.ok && tIn.files.length === 1 && tIn.files[0].from === 'Mom’s iPhone');
  const tdl = await tablet.download(tIn.files[0].fid, tIn.files[0].size);
  check('…and arrives intact', tdl.buf && tdl.buf.equals(pic));
  check('…and the PC doesn\'t keep a copy afterwards', !fs.readdirSync(path.join(dataDir, 'phone-relay')).length);

  // ---- a connected phone scanning the QR just opens its page ----
  const reopened = []; pc.on('phone-reopened', r => reopened.push(r));
  pair = await pc.phoneConnect();
  const tokenOf = c => P.deriveFromCode(c).token;
  const phonesBefore = pc.getState().phones.length;
  const re = await phone.api('hi', { scan: tokenOf(pair.code) });
  check('a connected phone that scans the QR just opens (no new Allow, no duplicate)', re.status === 200 && reopened.length === 1 && reopened[0].sid === pair.sid && pc.getState().phones.length === phonesBefore);
  check('…and that QR code is used up', (await new Phone(port, 'x').pair(pair.code)).status === 404);

  // ---- the same phone connecting again (it lost its login) replaces its old entry ----
  await pc.sendFiles(phone.id, [song]);
  pair = await pc.phoneConnect();
  const again = new Phone(port, 'Mom’s iPhone');
  await again.pair(pair.code); await until(() => asks.length === 4);
  pc.phoneAnswer(asks[3].sid, true, 'mom’s iphone', true);
  await again.waitOnce();
  const listed = pc.getState().phones.filter(p => p.name.toLowerCase() === 'mom’s iphone');
  check('reconnecting with the same name replaces the old entry (not listed twice)', listed.length === 1 && listed[0].id === again.id);
  check('…the old login stops working', (await phone.api('hi')).status === 401);
  check('…and files waiting for the old entry move to the new one', (await again.api('inbox')).files.length === 1);
  phone.id = again.id; phone.key = again.key; // carry on with the new login

  // ---- the NAS on this PC ----
  check('no NAS: the phone page has no NAS tab', (await phone.api('hi')).nas === null);
  check('…and NAS requests are refused', /isn’t on this PC/.test((await phone.api('nas-list', { dir: '' })).error || ''));
  pc.license.tier = () => 'pro';
  const nasRoot = path.join(tmp, 'Family Files');
  await pc.nas.setup(nasRoot);
  fs.mkdirSync(path.join(nasRoot, 'Photos')); fs.writeFileSync(path.join(nasRoot, 'Photos', 'Beach.jpg'), pic);
  const nh = await phone.api('hi');
  check('NAS on this PC: the phone page shows a NAS tab', nh.nas && nh.nas.here === true && nh.nas.label === 'Family Files');
  const nl = await phone.api('nas-list', { dir: '' });
  check('the phone browses the NAS folders', nl.entries.map(e => e.name).join('|') === 'Kids|Photos' && nl.level === 'full' && nl.total > 0);
  check('…and can\'t leave the NAS', /Bad folder/.test((await phone.api('nas-list', { dir: '../' })).error || ''));
  const songBuf = fs.readFileSync(song);
  const nup = await phone.upload(songBuf, 'Road trip.mp3', { nasDir: 'Photos' });
  check('"Save to NAS" puts the file in the open NAS folder', nup.ok && fs.readFileSync(path.join(nasRoot, 'Photos', 'Road trip.mp3')).equals(songBuf));
  check('…not in the PC\'s received files', !fs.existsSync(path.join(recv, 'Road trip.mp3')));
  check('…bad NAS folders are refused', /Bad folder/.test((await phone.upload(songBuf, 'x.mp3', { nasDir: '../../' })).error || ''));
  await phone.api('nas-mkdir', { dir: 'Photos', name: 'Summer' });
  check('the phone can make a folder', fs.existsSync(path.join(nasRoot, 'Photos', 'Summer')));
  const ng = await phone.api('nas-get', { paths: ['Photos/Beach.jpg'] });
  const ngd = ng.files && await phone.download(ng.files[0].fid, ng.files[0].size);
  check('"Get" downloads a NAS file to the phone intact', ngd && ngd.buf && ngd.buf.equals(pic));
  pc.nas.stop();
  check('NAS stopped: NAS requests are refused again', !!(await phone.api('nas-list', { dir: '' })).error);
  pc.license.tier = () => 'free';

  // ---- remembered after a restart, forgettable ----
  await pc.sendFiles(phone.id, [song]);
  pc.stop(); await wait(200);
  pc = new VelsNode({ dataDir, tcpPort: 0, phonePort: port, discovery: false, secretStore: store });
  await pc.start();
  check('after a restart the phone is still connected (no new code)', (await phone.api('hi')).status === 200);
  const waitingNow = (await phone.api('inbox')).files; console.log('   waiting after restart:', waitingNow.map(f => f.name).join(', '));
  check('…files waiting for it are still there', waitingNow.length === 2);
  check('a phone that wasn\'t remembered is gone after a restart', (await tablet.api('hi')).status === 401);
  const saved = fs.readFileSync(path.join(dataDir, 'phones.json'), 'utf8');
  check('the phone\'s key is stored encrypted, not as text', !saved.includes(Buffer.from(phone.key).toString('base64')) && saved.includes('keyEnc'));
  pc.phoneForget(phone.id);
  check('with no phones left, the phone server shuts down completely', !pc.phones.server && await req(port, '/').then(() => false, () => true));
  pair = await pc.phoneConnect(); // a QR on screen starts it again
  check('a forgotten phone is refused', (await phone.api('hi')).status === 401);

  // ---- lots of bad requests get the address blocked ----
  for (let i = 0; i < 16; i++) await phone.api('hi');
  check('repeated bad requests block that address for a while', (await req(port, '/')).status === 429);

  pc.stop();

  // ---- the phone port is busy: use the next one and remember it ----
  const net = require('net');
  const blocker = net.createServer(); const busy = await new Promise(r => blocker.listen(0, '0.0.0.0', () => r(blocker.address().port)));
  const dir2 = path.join(tmp, 'pc2');
  const pc2 = new VelsNode({ dataDir: dir2, tcpPort: 0, phonePort: busy, discovery: false });
  pc2.phones.fixedPort = false; // the real app may move to another port; tests normally pin it
  await pc2.start();
  const p2 = await pc2.phoneConnect();
  check('if another program uses the phone port, the next free one is used', pc2.phones.port !== busy && p2.url.includes(':' + pc2.phones.port + '/'));
  check('…and remembered for next time', JSON.parse(fs.readFileSync(path.join(dir2, 'phones.json'), 'utf8')).port === pc2.phones.port);
  pc2.stop(); blocker.close();

  console.log(failures ? `\n${failures} phone check(s) FAILED` : '\nAll phone checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
