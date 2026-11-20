const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-'));
const A = new VelsNode({ dataDir: path.join(tmp, 'a'), tcpPort: 0, udpPort: 48820, discovery: false });
const B = new VelsNode({ dataDir: path.join(tmp, 'b'), tcpPort: 0, udpPort: 48830, discovery: false });
A.updateSettings({ name: 'Desktop 1' }); B.updateSettings({ name: 'Desktop 2', receiveDir: path.join(tmp, 'recv') });
const WIN = process.platform === 'win32';
const CMD1 = WIN ? 'echo hello from %COMPUTERNAME% & ping -n 2 127.0.0.1 >nul & echo done' : 'echo hello from $(hostname); sleep 1; echo done';
const CMD2 = WIN ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 30';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000, label='') => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout ' + label); await wait(50); } };
(async () => {
  await A.start(); await B.start();
  // B is the receiving PC: it shows a PIN. A is the requester and must type it.
  let shownPin = null, wrongOnce = false, done = 0;
  B.on('pair-request', r => { shownPin = r.pin; console.log('B shows PIN', r.pin, 'tries left', r.triesLeft, r.wrong ? '(new PIN after wrong try)' : ''); });
  A.on('pair-pin-needed', p => {
    if (p.error) console.log('A told:', p.error, 'tries left', p.triesLeft);
    setTimeout(() => {
      if (!wrongOnce) { wrongOnce = true; const bad = String((+shownPin + 1) % 1000000).padStart(6, '0'); console.log('A types wrong PIN', bad); A.pairPin(p.sid, bad); }
      else { console.log('A types correct PIN', shownPin); A.pairPin(p.sid, shownPin); }
    }, 100);
  });
  A.on('pair-done', e => { console.log('A pair-done', e.ok, e.reason); done++; });
  B.on('pair-done', e => { console.log('B pair-done', e.ok, e.reason); done++; });
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => done === 2, 8000, 'pair');
  if (!A.peers[B.id] || !B.peers[A.id] || A.peers[B.id].key !== B.peers[A.id].key) throw new Error('keys differ');
  console.log('paired, both PCs hold the same key');
  await until(() => A.conns[B.id] && B.conns[A.id], 10000, 'connect');
  console.log('connected both ways; A conns', Object.keys(A.conns).length, 'B conns', Object.keys(B.conns).length);
  await wait(2500);
  const sA = A.getState(); console.log('A sees', sA.devices.map(d => [d.name, d.status, d.connected, d.stats && d.stats.cpu]));
  // task needing approval
  B.on('task-approval', a => { console.log('B approval asked for:', a.cmd, 'from', a.peerName); B.approveTask(a.taskId, 'allow'); });
  const tid = A.runTask({ target: B.id, cmd: CMD1, shell: 'cmd' });
  await until(() => ['done','failed'].includes(A.tasks.get(tid).state), 8000, 'task');
  console.log('task state', A.tasks.get(tid).state, 'code', A.tasks.get(tid).code, 'out:', JSON.stringify(A.getTaskOutput(tid)));
  // cancel test
  const t2 = A.runTask({ target: B.id, cmd: CMD2, shell: 'cmd' });
  await until(() => A.tasks.get(t2).state === 'running', 5000, 'running');
  A.cancelTask(t2);
  await until(() => A.tasks.get(t2).state === 'cancelled', 5000, 'cancel');
  console.log('cancel ok');
  // status
  A.setStatus(B.id, 'Waiting', 'Render node'); await wait(300);
  console.log('B status now', B.effectiveStatus(), B.role);
  // files
  const src = path.join(tmp, 'src'); fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'big.bin'), require('crypto').randomBytes(5 * 1024 * 1024 + 123));
  fs.writeFileSync(path.join(src, 'sub', 'note.txt'), 'hi');
  fs.writeFileSync(path.join(src, 'empty.txt'), '');
  B.on('file-offer', o => { console.log('B offered', o.count, 'files', o.total, 'bytes'); B.answerFiles(o.batchId, true); });
  await A.sendFiles(B.id, [src]);
  await until(() => [...A.transfers.values()].every(t => ['done','failed'].includes(t.state)), 15000, 'files');
  console.log('transfers', [...A.transfers.values()].map(t => [t.name, t.state, t.error || '']));
  const r = path.join(tmp, 'recv', 'src');
  console.log('same bytes', Buffer.compare(fs.readFileSync(path.join(src, 'big.bin')), fs.readFileSync(path.join(r, 'big.bin'))) === 0, fs.readFileSync(path.join(r, 'sub', 'note.txt'), 'utf8'));
  const outBig = [...A.transfers.values()].find(t => t.name.endsWith('big.bin'));
  const inBig = [...B.transfers.values()].find(t => t.name.endsWith('big.bin'));
  console.log('sender can open the file it sent:', A.transferPath(outBig.id) === path.join(src, 'big.bin'), '| receiver can open its copy:', !!B.transferPath(inBig.id) && fs.existsSync(B.transferPath(inBig.id)));
  if (!A.transferPath(outBig.id) || !B.transferPath(inBig.id)) throw new Error('cannot open transferred files');
  await wait(1200);
  const histB = JSON.parse(require('fs').readFileSync(path.join(B.dataDir, 'transfers.json'), 'utf8'));
  console.log('transfer history saved on the receiving PC:', histB.length, 'files', histB.every(t => t.state === 'done' && t.peerName === 'Desktop 1'));
  // restart B -> reconnect with stored key
  const bPort = B.tcpPort; B.stop(); await wait(300);
  const B2 = new VelsNode({ dataDir: path.join(tmp, 'b'), tcpPort: bPort, udpPort: 48830, discovery: false });
  await B2.start();
  await until(() => A.conns[B2.id], 15000, 'reconnect');
  console.log('reconnected after restart, same id', B2.id === B.id);
  const kept = B2.getState().transfers;
  console.log('history still shown after restart:', kept.length === histB.length && kept.some(t => t.name.endsWith('big.bin')));
  if (kept.length !== histB.length) throw new Error('history lost');
  // tamper: unknown peer tries auth
  A.stop(); B2.stop(); console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
