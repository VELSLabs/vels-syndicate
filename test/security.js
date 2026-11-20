// Security tests: run with  npm test
// Each check prints PASS/FAIL; the process exits non-zero if anything fails.
const { VelsNode } = require('../src/core/node');
const C = require('../src/core/crypto');
const V = require('../src/core/validate');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-sec-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0, port = 51000 + Math.floor(Math.random() * 5000);
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
// a fake OS keychain so we can prove keys are not stored in plain text
const fakeStore = { kind: 'os', encrypt: s => 'X' + Buffer.from(s).toString('hex'), decrypt: s => Buffer.from(s.slice(1), 'hex').toString() };
const mk = (name, extra = {}) => {
  const n = new VelsNode(Object.assign({ dataDir: path.join(tmp, name + '-' + port), tcpPort: 0, udpPort: port++, discovery: false }, extra));
  n.updateSettings({ name, receiveDir: path.join(tmp, name + '-recv') });
  return n;
};
const pairUp = async (A, B) => {
  let pin = null, done = 0;
  const onReq = r => { pin = r.pin; };
  const onNeed = p => setTimeout(() => A.pairPin(p.sid, pin), 50);
  const onDone = () => done++;
  B.on('pair-request', onReq); A.on('pair-pin-needed', onNeed); A.on('pair-done', onDone); B.on('pair-done', onDone);
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => done >= 2);
  B.off('pair-request', onReq); A.off('pair-pin-needed', onNeed); A.off('pair-done', onDone); B.off('pair-done', onDone);
  return until(() => A.conns[B.id] && B.conns[A.id]);
};

(async () => {
  // ---------- input validation ----------
  check('path traversal "../../etc/passwd" stays inside the folder', V.safeRel('../../etc/passwd') === path.join('etc', 'passwd'));
  check('drive letters are removed', V.safeRel('C:\\Windows\\System32\\x.dll') === path.join('Windows', 'System32', 'x.dll'));
  check('Windows reserved names are renamed', V.safeRel('CON.txt') === '_CON.txt' && V.safeRel('nul') === '_nul');
  check('hidden right-to-left trick characters are stripped from names', V.cleanText('Desk\u202Etop', 64) === 'Desktop');
  check('junk stats from another PC are cleaned', (() => { const s = V.cleanStats({ cpu: 9999, cpuModel: '<img src=x>'.repeat(50), ips: ['192.0.2.4', '<script>'], platform: 'evil' }); return s.cpu === 100 && s.cpuModel.length <= 100 && s.ips.length === 1 && s.platform === 'unknown'; })());
  check('local network detection', V.isLocalAddress('192.168.1.5') && V.isLocalAddress('10.0.0.2') && V.isLocalAddress('::ffff:172.20.1.1') && V.isLocalAddress('100.101.5.5') && !V.isLocalAddress('8.8.8.8') && !V.isLocalAddress('172.32.0.1')); // privacy-check: ignore (example addresses)
  check('settings from the window are whitelisted', (() => { const s = V.cleanSettingsPatch({ maxParallel: 999, theme: 'hacker', evil: 1, receiveDir: 'relative/path' }); return s.maxParallel === 8 && !('theme' in s) && !('evil' in s) && !('receiveDir' in s); })());

  // ---------- pairing ----------
  const A = mk('Alpha', { secretStore: fakeStore }), B = mk('Bravo', { secretStore: fakeStore });
  await A.start(); await B.start();
  check('PIN pairing connects both PCs', await pairUp(A, B));
  const peersRaw = fs.readFileSync(B.peersFile, 'utf8');
  check('pairing keys are encrypted on disk (no plain key in peers.json)', !peersRaw.includes(B.peers[A.id].key) && peersRaw.includes('keyEnc'));
  if (process.platform !== 'win32') check('data files are private to this user (chmod 600)', (fs.statSync(B.peersFile).mode & 0o077) === 0);

  // attacker guesses wrong PINs
  const X = mk('Mallory'); await X.start();
  const xDone = [];
  X.on('pair-pin-needed', p => setTimeout(() => X.pairPin(p.sid, '000000'), 30));
  X.on('pair-done', e => xDone.push(e));
  let lucky = false; B.on('pair-request', r => { if (r.pin === '000000') lucky = true; });
  await X.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => xDone.length > 0);
  check('3 wrong PINs get the requester blocked', lucky || /Too many wrong PINs/.test(xDone[0] && xDone[0].reason));
  xDone.length = 0;
  await X.pair({ host: '127.0.0.1', port: B.tcpPort }).catch(() => {});
  await until(() => xDone.length > 0);
  check('a blocked PC is refused when it tries again', lucky || /blocked|Too many/i.test(xDone[0] && xDone[0].reason));
  check('the block shows in the security log', B.secLog.some(e => e.kind === 'block'));
  B.blocks.clear();

  // receiver turns off new requests
  B.updateSettings({ allowPairing: false });
  xDone.length = 0;
  await X.pair({ host: '127.0.0.1', port: B.tcpPort }).catch(() => {});
  await until(() => xDone.length > 0);
  check('"Accept new connection requests: off" refuses requests', /isn't accepting/.test(xDone[0] && xDone[0].reason));
  B.updateSettings({ allowPairing: true });

  // ---------- impostor with a stolen ID but no key ----------
  const impDir = path.join(tmp, 'impostor');
  fs.mkdirSync(impDir, { recursive: true });
  fs.writeFileSync(path.join(impDir, 'identity.json'), JSON.stringify({ id: A.id }));
  fs.writeFileSync(path.join(impDir, 'peers.json'), JSON.stringify({ [B.id]: { name: 'Bravo', key: C.nonce(32), lastHost: '127.0.0.1', lastPort: B.tcpPort } }));
  const I = new VelsNode({ dataDir: impDir, tcpPort: 0, udpPort: port++, discovery: false });
  await I._connectAuth(B.id, '127.0.0.1', B.tcpPort);
  check('a PC copying another PC\'s ID (without its key) cannot connect', !I.conns[B.id] && !!B.conns[A.id]);
  // a determined attacker answers the challenge with a forged proof
  const forge = () => new Promise(res => {
    const kp = C.genKeyPair();
    const sock = net.connect(B.tcpPort, '127.0.0.1');
    sock.on('error', () => res()); sock.on('close', () => res());
    let buf = '';
    sock.on('data', d => { buf += d; if (buf.includes('\n')) { sock.write(JSON.stringify({ t: 'auth-resp', mac: C.nonce(32) }) + '\n'); buf = ''; } });
    sock.on('connect', () => sock.write(JSON.stringify({ t: 'hello', v: 2, mode: 'auth', id: A.id, name: 'Alpha', port: 1, epk: kp.pub, nonce: C.nonce() }) + '\n'));
    setTimeout(() => { sock.destroy(); res(); }, 2000);
  });
  await forge();
  check('a forged sign-in is rejected and logged', B.secLog.some(e => /failed the key check/.test(e.text)));
  for (let i = 0; i < 5; i++) await forge();
  check('repeated failed sign-ins block that address', [...B.blocks.keys()].includes('ip:127.0.0.1'));
  B.blocks.clear();
  await until(() => A.conns[B.id] && B.conns[A.id], 12000);

  // ---------- encrypted link: tamper + replay ----------
  let conn = A.conns[B.id];
  const real = conn.socket.write.bind(conn.socket);
  let captured = null;
  conn.socket.write = line => { captured = line; return real(line); };
  conn.send({ t: 'ping', ts: Date.now() });
  conn.socket.write = real;
  real(captured); // send the exact same encrypted frame a second time
  check('a replayed message closes the connection', await until(() => B.secLog.some(e => /replayed/.test(e.text)), 3000));
  await until(() => A.conns[B.id] && B.conns[A.id] && A.conns[B.id] !== conn, 12000);
  conn = A.conns[B.id];
  const frame = JSON.parse(JSON.stringify({ c: C.seal(conn.sendKey, { q: conn.sendSeq, d: { t: 'ping', ts: 1 } }) }));
  frame.c = frame.c.slice(0, 40) + (frame.c[40] === 'A' ? 'B' : 'A') + frame.c.slice(41);
  conn.socket.write(JSON.stringify(frame) + '\n');
  check('a tampered message closes the connection', await until(() => B.secLog.some(e => /tampered/.test(e.text)), 3000));
  await until(() => A.conns[B.id] && B.conns[A.id], 12000);

  // ---------- oversized garbage before sign-in ----------
  const before = B.secLog.length;
  const s = net.connect(B.tcpPort, '127.0.0.1');
  s.on('error', () => {});
  s.on('connect', () => s.write('x'.repeat(64 * 1024)));
  check('oversized data before sign-in is dropped', await until(() => s.destroyed || s.readyState === 'closed', 3000) || B.secLog.slice(before).some(e => /oversized/.test(e.text)));

  // ---------- access control ----------
  B.setPerm(A.id, 'tasks', 'never');
  const tid = A.runTask({ target: B.id, cmd: 'echo should-not-run', shell: process.platform === 'win32' ? 'cmd' : 'bash' });
  await until(() => A.tasks.get(tid).state === 'rejected', 3000);
  check('"Run tasks: Never" rejects tasks', A.tasks.get(tid).state === 'rejected' && !B.getTaskOutput(tid));
  B.setPerm(A.id, 'files', 'never');
  const f = path.join(tmp, 'secret.txt'); fs.writeFileSync(f, 'hello');
  await A.sendFiles(B.id, [f]);
  await until(() => [...A.transfers.values()].some(t => t.state === 'declined'), 3000);
  check('"Send files: Never" declines files', [...A.transfers.values()].some(t => t.state === 'declined') && !fs.existsSync(path.join(tmp, 'Bravo-recv', 'secret.txt')));
  B.setPerm(A.id, 'status', 'never');
  B.setStatus(null, 'Idle');
  A.setStatus(B.id, 'Busy');
  await wait(300);
  check('"Change status: Never" ignores status changes', B.effectiveStatus() === 'Idle');
  const wrongShell = A.runTask({ target: B.id, cmd: 'whoami', shell: 'nonsense' });
  check('unknown shells are replaced with a valid one', V.shellsFor(process.platform).includes(A.tasks.get(wrongShell).shell));

  // ---------- revoking access ----------
  A.unpair(B.id);
  check('"Forget" on one PC removes access on the other PC too', await until(() => !B.peers[A.id], 3000));

  A.stop(); B.stop(); X.stop(); I.stop();
  console.log(failures ? `\n${failures} security check(s) FAILED` : '\nAll security checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
