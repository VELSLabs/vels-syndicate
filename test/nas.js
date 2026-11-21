// NAS (Pro and up): setup, access, Kids folder, recycle bin, uploads, downloads, moving. Run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-nas-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`); if (!ok) failures++; };
const err = async p => { try { await p; return ''; } catch (e) { return e.message; } };

const mk = name => { const dir = path.join(tmp, name); const n = new VelsNode({ dataDir: dir, tcpPort: 0, phonePort: 0, discovery: false }); n.updateSettings({ name, receiveDir: path.join(dir, 'recv'), filePolicy: 'ask' }); return n; };
async function pair(a, b) {
  let pin = null, done = 0;
  const onReq = r => { pin = r.pin; }, onNeed = p => setTimeout(() => a.pairPin(p.sid, pin), 30), onDone = () => done++;
  b.on('pair-request', onReq); a.on('pair-pin-needed', onNeed); a.on('pair-done', onDone); b.on('pair-done', onDone);
  await a.pair({ host: '127.0.0.1', port: b.tcpPort });
  await until(() => done >= 2 && a.conns[b.id] && b.conns[a.id]);
  b.off('pair-request', onReq); a.off('pair-pin-needed', onNeed); a.off('pair-done', onDone); b.off('pair-done', onDone);
}

(async () => {
  const H = mk('Media Server'), L = mk('Leo Laptop'), K = mk('Kid PC');
  await H.start(); await L.start(); await K.start();
  await pair(L, H); await pair(K, H);
  const asks = []; H.on('ask', a => asks.push(a));
  const awake = []; H.on('nas-awake', v => awake.push(v));
  const root = path.join(tmp, 'Family Files');

  // ---- plan ----
  check('Free plan: the NAS can\'t be set up', /Pro/.test(await err(H.nas.setup(root))));
  check('…and the window shows the preview', H.getState().nas.feature === false);
  H.license.tier = () => 'pro';
  check('the NAS can\'t be a whole drive', /whole drive/.test(await err(H.nas.setup(path.parse(root).root))));
  await H.nas.setup(root);
  check('Pro: this PC is now the NAS, with a Kids folder', H.nas.active() && fs.existsSync(path.join(root, 'Kids')) && H.getState().nas.host.label === 'Family Files');
  check('keep awake turns on with the NAS', awake.includes(true));
  check('other PCs learn where the NAS is', await until(() => L.nas.hostElsewhere() && L.nas.hostElsewhere().name === 'Media Server' && L.getState().nas.elsewhere.label === 'Family Files'));
  check('another PC can\'t set up a second NAS', (L.license.tier = () => 'pro', /already the NAS/.test(await err(L.nas.setup(path.join(tmp, 'other'))))));
  L.license.tier = () => 'free';

  // ---- the host itself ----
  fs.mkdirSync(path.join(root, 'Photos')); fs.writeFileSync(path.join(root, 'Photos', 'Beach day.jpg'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(root, 'School forms.pdf'), 'pdf');
  let l = await H.nasOp('list', { dir: '' });
  check('the NAS PC lists its folders first, then files', l.entries.map(e => e.name).join('|') === 'Kids|Photos|School forms.pdf' && l.entries[1].count === 1);
  check('…paths can\'t leave the NAS', /Bad folder/.test(await err(H.nasOp('list', { dir: '../' }))) && /Bad folder/.test(await err(H.nasOp('list', { dir: 'Photos/../../x' }))));

  // ---- a new PC asks first ----
  const openP = L.nasOp('open');
  check('a new PC opening the NAS asks the NAS PC', await until(() => asks.length === 1) && asks[0].kind === 'nas' && asks[0].peerName === 'Leo Laptop');
  H.answerAsk(asks[0].reqId, 'nas', true, { level: 'view' });
  const o = await openP;
  check('…"View only" is remembered', o.level === 'view' && H.nas.cfg.access[L.id].level === 'view');
  l = await L.nasOp('list', { dir: 'Photos' });
  check('view only: can browse', l.entries.length === 1 && l.entries[0].name === 'Beach day.jpg');
  check('view only: can\'t make folders or delete', /only view/.test(await err(L.nasOp('mkdir', { dir: '', name: 'X' }))) && /only view/.test(await err(L.nasOp('delete', { paths: ['School forms.pdf'] }))));
  await L.nasOp('get', { paths: ['Photos/Beach day.jpg'] });
  const got = path.join(tmp, 'Leo Laptop', 'recv', 'Beach day.jpg');
  check('"Get" downloads it here without a second question', await until(() => fs.existsSync(got)) && fs.readFileSync(got).equals(fs.readFileSync(path.join(root, 'Photos', 'Beach day.jpg'))));
  const up = path.join(tmp, 'notes.txt'); fs.writeFileSync(up, 'my notes');
  await L.nasUpload([up], 'Photos'); await wait(600);
  check('view only: uploads are refused', !fs.existsSync(path.join(root, 'Photos', 'notes.txt')));

  // ---- full access ----
  H.nas.setAccess(L.id, 'full', false);
  await L.nasUpload([up], 'Photos');
  check('full: upload lands in the chosen NAS folder', await until(() => fs.existsSync(path.join(root, 'Photos', 'notes.txt'))));
  check('…not in the NAS PC\'s Downloads', !fs.existsSync(path.join(tmp, 'Media Server', 'recv', 'notes.txt')));
  await L.nasUpload([up], 'Photos');
  check('…uploading the same name again never overwrites', await until(() => fs.readdirSync(path.join(root, 'Photos')).filter(n => n.startsWith('notes')).length === 2));
  await L.nasOp('mkdir', { dir: '', name: 'Birthdays' });
  await L.nasOp('rename', { path: 'Birthdays', name: 'Birthdays 2026' });
  check('full: new folder and rename work', fs.existsSync(path.join(root, 'Birthdays 2026')));
  check('bad names are refused', /different name/.test(await err(L.nasOp('mkdir', { dir: '', name: '..' }))) && /different name/.test(await err(L.nasOp('mkdir', { dir: '', name: '.vels-recycle' }))));
  check('the Kids folder can\'t be renamed or deleted', /can't be renamed/.test(await err(L.nasOp('rename', { path: 'Kids', name: 'X' }))) && (await L.nasOp('delete', { paths: ['Kids'] })).count === 0);
  const s = await L.nasOp('search', { q: 'beach' });
  check('search finds files in any folder', s.results.length === 1 && s.results[0].path === 'Photos/Beach day.jpg');

  // ---- recycle bin ----
  await L.nasOp('delete', { paths: ['School forms.pdf'] });
  check('delete moves it to the NAS recycle bin', !fs.existsSync(path.join(root, 'School forms.pdf')) && (await L.nasOp('bin')).items.length === 1);
  check('…the bin is hidden from the list', !(await L.nasOp('list', { dir: '' })).entries.some(e => e.name === '.vels-recycle'));
  check('…and logged on the NAS PC', H.secLog.some(e => /Leo Laptop deleted 1 item/.test(e.text)));
  const binId = (await L.nasOp('bin')).items[0].id;
  await L.nasOp('restore', { ids: [binId] });
  check('restore puts it back where it was', fs.existsSync(path.join(root, 'School forms.pdf')) && (await L.nasOp('bin')).items.length === 0);
  await L.nasOp('delete', { paths: ['School forms.pdf'] });
  const idx = H.nas._bin(); idx[0].at = Date.now() - 31 * 86400000; H.nas._saveBin(idx);
  await H.nas.cleanBin();
  check('after 30 days the bin empties itself', H.nas._bin().length === 0 && fs.readdirSync(path.join(root, '.vels-recycle')).length === 1);
  H.nas.update({ recycle: false });
  await L.nasOp('delete', { paths: ['Photos/notes.txt'] });
  check('with the NAS bin off, deletes go to the NAS PC\'s Recycle Bin', fs.readdirSync(path.join(tmp, 'Media Server', 'deleted-files')).includes('notes.txt'));
  H.nas.update({ recycle: true });

  // ---- kids ----
  K.monitor.enabled = true; K.monitor.parentId = H.id;
  const ko = await K.nasOp('open');
  check('a kid\'s PC opens the Kids folder without asking anyone', ko.kids === true && ko.level === 'full' && asks.length === 1);
  await K.nasUpload([up], '');
  check('…saves go into Kids', await until(() => fs.existsSync(path.join(root, 'Kids', 'notes.txt'))));
  check('…and it can\'t see the rest of the NAS', (await K.nasOp('list', { dir: '' })).entries.every(e => e.name !== 'Photos') && /Bad folder/.test(await err(K.nasOp('list', { dir: '../Photos' }))));
  check('…search stays inside Kids', (await K.nasOp('search', { q: 'beach' })).results.length === 0);
  H.nas.setAccess(L.id, 'full', true);
  check('a regular PC can also be limited to the Kids folder', (await L.nasOp('list', { dir: '' })).entries.some(e => e.name === 'notes.txt'));
  H.nas.setAccess(L.id, 'none', false);
  check('"No access" blocks everything', /access/.test(await err(L.nasOp('list', { dir: '' }))));

  // ---- move the NAS on this PC ----
  const root2 = path.join(tmp, 'Bigger Drive', 'Family Files');
  await H.nas.move(root2, 'copy');
  check('move to another folder, copying everything', H.nas.cfg.root === root2 && fs.existsSync(path.join(root2, 'Photos', 'Beach day.jpg')) && fs.existsSync(path.join(root2, 'Kids', 'notes.txt')));
  check('…the old folder is left as it was', fs.existsSync(path.join(root, 'Photos', 'Beach day.jpg')));
  check('…can\'t move into itself', /not inside/.test(await err(H.nas.move(path.join(root2, 'sub'), 'empty'))));

  // ---- move the NAS to another PC ----
  H.nas.setAccess(L.id, 'full', false);
  L.license.tier = () => 'pro';
  const root3 = path.join(tmp, 'Leo NAS');
  const moveP = L.nas.takeOver(root3, 'copy');
  check('moving the NAS to another PC asks the NAS PC', await until(() => asks.some(a => a.kind === 'files' && a.action === 'nasmove')));
  H.answerAsk(asks.find(a => a.action === 'nasmove').reqId, 'files', true);
  await moveP;
  check('…the new PC is the NAS', L.nas.active() && L.nas.cfg.root === root3 && !H.nas.cfg.root);
  check('…and every file is copied over, folders and all', await until(() => fs.existsSync(path.join(root3, 'Photos', 'Beach day.jpg')) && fs.existsSync(path.join(root3, 'Kids', 'notes.txt'))));
  check('…the old PC now uses the new NAS', await until(() => H.nas.hostElsewhere() && H.nas.hostElsewhere().id === L.id));
  check('…the old PC keeps its copy too', fs.existsSync(path.join(root2, 'Photos', 'Beach day.jpg')));
  L.nas.stop();
  check('stop being the NAS: files stay', !L.nas.cfg.root && fs.existsSync(path.join(root3, 'Photos')));

  for (const n of [H, L, K]) n.stop();
  console.log(failures ? `\n${failures} NAS check(s) FAILED` : '\nAll NAS checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
