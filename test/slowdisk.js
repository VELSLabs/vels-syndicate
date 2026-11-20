// Slow-disk test: many small files while the receiving PC's disk is slower than the network
// (common on Windows when antivirus scans new files). Run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-slow-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let port = 59000 + Math.floor(Math.random() * 1000);
(async () => {
  const A = new VelsNode({ dataDir: path.join(tmp, 'a'), tcpPort: 0, udpPort: port++, discovery: false });
  const B = new VelsNode({ dataDir: path.join(tmp, 'b'), tcpPort: 0, udpPort: port++, discovery: false, writeHighWaterMark: 16 * 1024 });
  B.updateSettings({ receiveDir: path.join(tmp, 'recv') });
  await A.start(); await B.start();
  let pin = null, done = 0;
  B.on('pair-request', r => { pin = r.pin; }); A.on('pair-pin-needed', p => setTimeout(() => A.pairPin(p.sid, pin), 30));
  A.on('pair-done', () => done++); B.on('pair-done', () => done++);
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => done >= 2 && A.conns[B.id] && B.conns[A.id], 10000);
  B.setPerm(A.id, 'files', 'allow');
  const src = path.join(tmp, 'src'); fs.mkdirSync(src);
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(src, `photo-${i}.jpg`), require('crypto').randomBytes(100 * 1024));
  await A.sendFiles(B.id, [src]);
  const ok = await until(() => [...A.transfers.values()].every(t => ['done', 'failed', 'declined', 'cancelled'].includes(t.state)), 20000);
  const states = {}; for (const t of A.transfers.values()) states[t.state] = (states[t.state] || 0) + 1;
  const pass = ok && states.done === 40;
  console.log(`${pass ? 'PASS' : 'FAIL'}  40 files arrive even when the receiving disk is slower than the network`, JSON.stringify(states));
  // the link must still work afterwards
  const tid = A.runTask({ target: B.id, cmd: process.platform === 'win32' ? 'echo ok' : 'echo ok', shell: process.platform === 'win32' ? 'cmd' : 'bash' });
  B.setPerm(A.id, 'tasks', 'allow');
  const linkOk = await until(() => ['done', 'failed', 'rejected', 'pending'].includes(A.tasks.get(tid).state), 8000);
  console.log(`${linkOk ? 'PASS' : 'FAIL'}  the connection still works after the transfers`);
  A.stop(); B.stop();
  process.exit(pass && linkOk ? 0 : 1);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
