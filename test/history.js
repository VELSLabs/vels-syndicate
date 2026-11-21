// File history (Office → a PC → File history) and custom tab names. Run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-hist-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`); if (!ok) failures++; };
const err = async p => { try { await p; return ''; } catch (e) { return e.message; } };

const mk = name => { const dir = path.join(tmp, name); const n = new VelsNode({ dataDir: dir, tcpPort: 0, phonePort: 0, discovery: false }); n.updateSettings({ name, receiveDir: path.join(dir, 'recv') }); return n; };
async function pair(a, b) {
  let pin = null, done = 0;
  const onReq = r => { pin = r.pin; }, onNeed = p => setTimeout(() => a.pairPin(p.sid, pin), 30), onDone = () => done++;
  b.on('pair-request', onReq); a.on('pair-pin-needed', onNeed); a.on('pair-done', onDone); b.on('pair-done', onDone);
  await a.pair({ host: '127.0.0.1', port: b.tcpPort });
  await until(() => done >= 2 && a.conns[b.id] && b.conns[a.id]);
  b.off('pair-request', onReq); a.off('pair-pin-needed', onNeed); a.off('pair-done', onDone); b.off('pair-done', onDone);
}
const asks = node => { const list = []; node.on('ask', a => list.push(a)); return list; };

(async () => {
  const A = mk('Desk A'), B = mk('Desk B'), C = mk('Desk C');
  await A.start(); await B.start(); await C.start();
  await pair(A, B); await pair(C, B); await pair(A, C);
  check('three PCs paired', !!(A.conns[B.id] && B.conns[C.id] && A.conns[C.id]));
  for (const n of [A, B, C]) n.updateSettings({ filePolicy: 'auto' });
  const aAsks = asks(A), bAsks = asks(B);

  // files land on B from A and from C
  const fa = path.join(tmp, 'from-a.txt'); fs.writeFileSync(fa, 'hello from A');
  const fc = path.join(tmp, 'Family photo.jpg'); fs.writeFileSync(fc, crypto.randomBytes(40000));
  await A.sendFiles(B.id, [fa]); await C.sendFiles(B.id, [fc]);
  await until(() => [...B.transfers.values()].filter(t => t.state === 'done').length === 2);

  // ---- the list ----
  let list = await A.fileHistory(B.id);
  const rowA = list.find(r => r.name === 'from-a.txt'), rowC = list.find(r => r.name === 'Family photo.jpg');
  check('file history lists everything that PC received, from any PC', !!rowA && !!rowC && rowA.dir === 'in' && rowC.other === 'Desk C');
  check('…says the file is on that PC', rowC.where === 'here');
  check('…and knows which files are also on this PC', rowA.hereToo === true && rowA.otherIsMe === true && rowC.hereToo === false);

  // ---- get a copy (that PC asks first: its "Send files" setting is Ask) ----
  const copyP = A.fileHistoryAct(B.id, 'copy', [rowC.id]);
  check('getting a copy asks the other PC first', await until(() => bAsks.length === 1) && bAsks[0].kind === 'files' && bAsks[0].action === 'copy' && bAsks[0].peerName === 'Desk A');
  B.answerAsk(bAsks[0].reqId, 'files', true);
  check('…once allowed, it is sent', (await copyP).ok === true);
  const gotC = path.join(tmp, 'Desk A', 'recv', 'Family photo.jpg');
  check('…and arrives here without a second question', await until(() => fs.existsSync(gotC)) && fs.readFileSync(gotC).equals(fs.readFileSync(fc)));
  list = await A.fileHistory(B.id);
  check('after that, the history shows it\'s on this PC too', list.find(r => r.id === rowC.id).hereToo === false && [...A.transfers.values()].some(t => t.name === 'Family photo.jpg' && t.state === 'done'));

  // ---- deny / never ----
  const denyP = A.fileHistoryAct(B.id, 'delete', [rowA.id]);
  await until(() => bAsks.length === 2);
  B.answerAsk(bAsks[1].reqId, 'files', false);
  check('if that PC says no, nothing happens', /said no/.test(await err(denyP)) && fs.existsSync(path.join(tmp, 'Desk B', 'recv', 'from-a.txt')));
  B.setPerm(A.id, 'files', 'never');
  check('"Send files: Never" also blocks file history requests', /doesn't allow/.test(await err(A.fileHistoryAct(B.id, 'copy', [rowA.id]))));
  B.setPerm(A.id, 'files', 'ask');

  // ---- delete on that PC → Recycle Bin ----
  const delP = A.fileHistoryAct(B.id, 'delete', [rowA.id]);
  await until(() => bAsks.length === 3);
  check('deleting always asks that PC (even with Allow)', bAsks[2].action === 'delete');
  B.answerAsk(bAsks[2].reqId, 'files', true);
  check('…the file is moved to the Recycle Bin, not erased', (await delP).count === 1 && !fs.existsSync(path.join(tmp, 'Desk B', 'recv', 'from-a.txt')) && fs.readdirSync(path.join(tmp, 'Desk B', 'deleted-files')).includes('from-a.txt'));
  list = await A.fileHistory(B.id);
  check('…and the history says it was deleted', list.find(r => r.id === rowA.id).where === 'deleted');
  check('…which is written in that PC\'s security log', B.secLog.some(e => /Desk A deleted 1 received file/.test(e.text)));
  const fb = path.join(tmp, 'b-original.txt'); fs.writeFileSync(fb, 'B owns this'); await B.sendFiles(C.id, [fb]);
  await until(() => [...B.transfers.values()].some(t => t.name === 'b-original.txt' && t.state === 'done'));
  const own = (await A.fileHistory(B.id)).find(r => r.name === 'b-original.txt');
  check('a PC\'s own original files can never be deleted from another PC', own.where === 'original' && /Only files/.test(await err(A.fileHistoryAct(B.id, 'delete', [own.id]))) && fs.existsSync(fb));

  // ---- send again from that PC to another PC ----
  B.setPerm(A.id, 'files', 'allow');
  const before = [...C.transfers.values()].filter(t => t.direction === 'in').length;
  const sent = await A.fileHistoryAct(B.id, 'send', [rowC.id], C.id);
  check('"Send again" makes that PC send it to another PC (Allow = no question)', sent.ok && await until(() => [...C.transfers.values()].filter(t => t.direction === 'in').length > before));
  check('re-sending a file that\'s on this PC works too', !!(await A.resendLocal([rowA.id].concat([...A.transfers.values()].filter(t => t.name === 'Family photo.jpg').map(t => t.id)), C.id)));

  // ---- family: passcode needed ----
  A.becomeMain('246810');
  await until(() => B.main.mainId === A.id && C.main.mainId === A.id);
  A.lockAdmin();
  check('family setup: the main PC must be unlocked to open file history', /Locked/.test(await err(A.fileHistory(B.id))));
  A.unlockAdmin('246810');
  check('…and works once unlocked', (await A.fileHistory(B.id)).length > 0);
  check('family setup: another PC needs the passcode', /passcode/i.test(await err(C.fileHistory(B.id))));
  check('…a wrong passcode is refused', /Wrong/.test(await err(C.fileHistory(B.id, '111111'))));
  check('…the right passcode works (checked by the main PC)', (await C.fileHistory(B.id, '246810')).length > 0);
  const callBefore = bAsks.length;
  const famCopy = await A.fileHistoryAct(B.id, 'copy', [own.id]);
  check('the main PC acts without a question on the other PC', famCopy.ok && bAsks.length === callBefore);

  // ---- tab names ----
  await A.setTabNames({ office: 'Home base', files: '  Sharing  ', bogus: 'x', settings: 'A really long tab name here' });
  check('tab names: saved for this PC, cleaned, max 16 characters', A.settings.tabNames.office === 'Home base' && A.settings.tabNames.files === 'Sharing' && !('bogus' in A.settings.tabNames) && A.settings.tabNames.settings.length <= 16);
  await A.setTabNames({});
  check('tab names: reset to default', Object.keys(A.settings.tabNames).length === 0);
  check('normal settings can\'t change tab names behind your back', (A.updateSettings({ tabNames: { office: 'x' } }), !A.settings.tabNames.office));
  // a kid PC asks the main PC
  B.monitor.enabled = true; B.monitor.parentId = A.id;
  const r = await B.setTabNames({ office: 'My Desk' });
  check('a kid PC\'s new tab names are sent to the main PC', r.asked === true && !B.settings.tabNames.office && await until(() => aAsks.some(a => a.kind === 'tabs')));
  const ask = aAsks.find(a => a.kind === 'tabs');
  check('…which sees exactly what changes', ask.names.office === 'My Desk' && ask.peerName === 'Desk B');
  A.answerAsk(ask.reqId, 'tabs', true);
  check('…and once allowed, the kid PC uses them', await until(() => B.settings.tabNames.office === 'My Desk'));
  await B.setTabNames({ office: 'Gaming' });
  await until(() => aAsks.filter(a => a.kind === 'tabs').length === 2);
  A.answerAsk(aAsks.filter(a => a.kind === 'tabs')[1].reqId, 'tabs', false);
  await wait(300);
  check('…if denied, the kid PC keeps its names', B.settings.tabNames.office === 'My Desk');
  A.settings.tabNames = { phoneSend: 'Send to PC' };
  check('the phone page gets the PC\'s phone tab names', A.phones._tabs().send === 'Send to PC' && A.phones._tabs().get === '');

  for (const n of [A, B, C]) n.stop();
  console.log(failures ? `\n${failures} history/tab check(s) FAILED` : '\nAll file history and tab name checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
