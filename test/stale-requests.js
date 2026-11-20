// A request from a PC that disconnects must not be acted on afterwards: run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-stale-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0, port = 58000 + Math.floor(Math.random() * 3000);
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const shell = process.platform === 'win32' ? 'powershell' : 'sh';
const mk = name => { const n = new VelsNode({ dataDir: path.join(tmp, name), tcpPort: 0, udpPort: port++, discovery: false }); n.updateSettings({ name, receiveDir: path.join(tmp, name + '-recv') }); return n; };

(async () => {
  const A = mk('A'), B = mk('B');
  await A.start(); await B.start();
  let pin = null, done = 0;
  B.on('pair-request', r => { pin = r.pin; }); A.on('pair-pin-needed', p => setTimeout(() => A.pairPin(p.sid, pin), 30));
  A.on('pair-done', () => done++); B.on('pair-done', () => done++);
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => done >= 2 && A.conns[B.id] && B.conns[A.id]);

  // a task that waits for "Allow?" on B
  const gone = [];
  B.on('request-gone', g => gone.push(g.key));
  let asked = null; B.on('task-approval', a => { asked = a; });
  const marker = path.join(tmp, 'ran.txt');
  A.runTask({ target: B.id, cmd: process.platform === 'win32' ? `New-Item -ItemType File "${marker}"` : `touch "${marker}"`, shell });
  check('B is asked to allow the task', await until(() => asked));
  // a file offer that waits for Accept on B
  const f = path.join(tmp, 'x.txt'); fs.writeFileSync(f, 'hello');
  let offer = null; B.on('file-offer', o => { offer = o; });
  await A.sendFiles(B.id, [f]);
  check('B is asked to accept the files', await until(() => offer));

  // A goes away before B answers
  A.stop();
  const noticed = await until(() => !B.conns[A.id], 12000);
  if (!noticed) { const c = B.conns[A.id]; console.log('  (B still linked to A:', c && c.socket ? `${c.socket.remoteAddress}:${c.socket.remotePort} closed=${c.closed}` : '?', ')'); }
  check('B notices the disconnect', noticed);
  // a stopped PC never comes back on its own
  await wait(3500);
  check('a stopped PC does not reconnect', !B.conns[A.id] && !A.conns[B.id]);
  check('the waiting task is cancelled', B.tasks.get(asked.taskId).state === 'rejected');
  check('both pop-ups are told to close', gone.includes('task:' + asked.taskId) && gone.includes('files:' + offer.batchId));
  B.approveTask(asked.taskId, 'allow');
  await wait(800);
  check('clicking Allow afterwards does NOT run the command', !fs.existsSync(marker));
  B.answerFiles(offer.batchId, true);
  const tr = [...B.transfers.values()].find(t => t.batchId === offer.batchId);
  check('accepting the files afterwards leaves nothing stuck as queued', tr && tr.state === 'failed');

  B.stop();
  console.log(failures ? `\n${failures} stale-request check(s) FAILED` : '\nAll stale-request checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
