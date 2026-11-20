// Updating or restarting must never cost anyone their pairings: run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-upd-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };

// stand-in for Windows' key protection; "broken" acts like it isn't ready yet
const keychain = { broken: false };
const store = {
  kind: 'os',
  encrypt: s => 'K:' + Buffer.from(s).toString('base64'),
  decrypt: s => { if (keychain.broken) throw new Error('not ready'); return Buffer.from(s.slice(2), 'base64').toString(); },
};
const dirA = path.join(tmp, 'A'), dirB = path.join(tmp, 'B');
const mk = (dir, name, port = 0) => { const n = new VelsNode({ dataDir: dir, tcpPort: port, discovery: false, secretStore: store }); n.updateSettings({ name, receiveDir: dir + '-recv' }); return n; };
const peersOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'peers.json'), 'utf8'));

(async () => {
  // ---------- pair once ----------
  let A = mk(dirA, 'Desk A'), B = mk(dirB, 'Desk B');
  await A.start(); await B.start();
  let pin = null, done = 0;
  B.on('pair-request', r => { pin = r.pin; }); A.on('pair-pin-needed', p => setTimeout(() => A.pairPin(p.sid, pin), 30));
  A.on('pair-done', () => done++); B.on('pair-done', () => done++);
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  check('the two PCs pair', await until(() => done >= 2 && A.conns[B.id] && B.conns[A.id]));
  const idA = A.id, idB = B.id, portA = A.tcpPort, portB = B.tcpPort;
  A.stop(); B.stop(); await wait(300);

  // ---------- normal update: same data folder, new program ----------
  A = mk(dirA, 'Desk A', portA); B = mk(dirB, 'Desk B', portB);
  await A.start(); await B.start();
  check('after an update each PC keeps its own ID', A.id === idA && B.id === idB);
  check('after an update the pairing is still there', !!A.peers[idB] && !!B.peers[idA]);
  check('…and they reconnect by themselves, no new PIN', await until(() => A.conns[idB] && B.conns[idA], 15000));
  check('settings survive the update', B.settings.name === 'Desk B');
  B.stop(); await wait(300);

  // ---------- key can't be unlocked at start (Windows still starting up) ----------
  keychain.broken = true;
  B = mk(dirB, 'Desk B', portB);
  check('a pairing whose key can\'t be unlocked yet is not loaded…', !B.peers[idA]);
  B.updateSettings({ name: 'Desk B' }); B._savePeers(); // anything that saves must not drop it
  check('…but it is NOT deleted from disk', !!peersOf(dirB)[idA]);
  keychain.broken = false;
  B._retryLockedPeers();
  check('when the key can be unlocked again, the pairing comes back', !!B.peers[idA]);
  await B.start();
  check('…and the PCs reconnect', await until(() => A.conns[idB] && B.conns[idA], 15000));
  B.stop(); await wait(300);

  // still broken at the next start: kept until a later start
  keychain.broken = true;
  B = mk(dirB, 'Desk B', portB); B._savePeers();
  keychain.broken = false;
  B = mk(dirB, 'Desk B', portB);
  check('a pairing that stays locked for a whole run is still there next time', !!B.peers[idA]);

  // ---------- damaged pairing list ----------
  fs.writeFileSync(path.join(dirB, 'peers.json'), '{ broken');
  B = mk(dirB, 'Desk B', portB);
  check('a damaged list of paired PCs is restored from the backup', !!B.peers[idA]);

  // ---------- damaged ID file ----------
  fs.writeFileSync(path.join(dirB, 'identity.json'), '');
  B = mk(dirB, 'Desk B', portB);
  check('a damaged ID file is restored from the backup (same ID)', B.id === idB);

  // ---------- damaged settings ----------
  fs.writeFileSync(path.join(dirB, 'settings.json'), 'nope');
  B = mk(dirB, 'Desk B', portB);
  check('damaged settings are restored from the backup', B.settings.name === 'Desk B');

  // ---------- no backup either: nothing is thrown away ----------
  const dirC = path.join(tmp, 'C');
  let C = mk(dirC, 'Desk C');
  fs.writeFileSync(path.join(dirC, 'peers.json'), '{ broken'); fs.rmSync(path.join(dirC, 'peers.json.bak'), { force: true });
  C = mk(dirC, 'Desk C');
  check('a damaged file with no backup is kept aside, not overwritten', fs.readdirSync(dirC).some(f => f.startsWith('peers.json.unreadable-')));

  A.stop();
  console.log(failures ? `\n${failures} update check(s) FAILED` : '\nAll update checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
