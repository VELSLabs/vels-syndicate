// Plans & license tests (uses a fake store, no internet): run with  npm test
const { VelsNode } = require('../src/core/node');
const { License, GRACE_MS } = require('../src/core/license');
const EventEmitter = require('events');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-plan-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0, port = 61000 + Math.floor(Math.random() * 3000);
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const expectError = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

// ---------- a fake Polar store ----------
const store = { provider: 'polar', apiBase: 'https://fake.store/v1', organizationId: 'org-1', benefits: { family: ['b-fam'], pro: ['b-pro'], team: ['b-team'], business: ['b-biz'] }, checkoutUrl: { pro: 'https://fake.store/pro', business: '' } };
let revoked = new Set(), offline = false, weird = 0;
const KEYS = { 'VELS_3F2A9C1E-7B4D-4E8A-9F1C-2D5B6A7E8C90': 'b-fam', 'FAM-KEY-4321': 'b-fam', 'TEAM-KEY-8765': 'b-team', 'PRO-KEY-1234': 'b-pro', 'BIZ-KEY-5678': 'b-biz', 'OTHER-KEY-999': 'b-other' };
const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
const fakeFetch = async (url, opts) => {
  if (offline) throw new TypeError('fetch failed');
  const body = JSON.parse(opts.body);
  if (body.organization_id !== 'org-1') return reply(404, { detail: 'Not found' });
  if (url.endsWith('/activate')) {
    if (body.key === 'FULL-KEY-1111') return reply(403, { detail: 'License key activation limit reached' });
    if (!KEYS[body.key]) return reply(404, { detail: 'License key not found' });
    return reply(200, { id: 'act-' + Object.keys(KEYS).indexOf(body.key), license_key: { benefit_id: KEYS[body.key], status: 'granted', display_key: '****-' + body.key.slice(-4) } });
  }
  if (url.endsWith('/validate')) {
    if (weird) return reply(weird, { detail: 'Unexpected' });
    if (!KEYS[body.key] || revoked.has(body.key)) return reply(404, { detail: 'License key not found' });
    return reply(200, { benefit_id: KEYS[body.key], status: 'granted' });
  }
  if (url.endsWith('/deactivate')) return reply(204, null);
  return reply(404, {});
};
const fakeStore = { kind: 'os', encrypt: s => 'X' + Buffer.from(s).toString('hex'), decrypt: s => Buffer.from(s.slice(1), 'hex').toString() };

(async () => {
  // ---------- license on its own ----------
  let clock = Date.now();
  const lic = new License({ file: path.join(tmp, 'lic.json'), secretStore: fakeStore, store, fetchImpl: fakeFetch, now: () => clock });
  const unconfigured = new License({ file: path.join(tmp, 'lic0.json'), store: Object.assign({}, store, { organizationId: '' }), fetchImpl: fakeFetch });
  check('a build without store details refuses keys politely', await expectError(() => unconfigured.activate('PRO-KEY-1234'), /isn't connected to a store/));
  check('starts on Free', lic.tier() === 'free');
  check('a wrong key is refused', await expectError(() => lic.activate('BAD-KEY-0000'), /wasn't found/));
  check('a key for another product is refused', await expectError(() => lic.activate('OTHER-KEY-999'), /different product/));
  check('a key used on too many PCs is explained', await expectError(() => lic.activate('FULL-KEY-1111'), /maximum number of PCs/));
  for (const [k, t] of [['VELS_3F2A9C1E-7B4D-4E8A-9F1C-2D5B6A7E8C90', 'family'], ['FAM-KEY-4321', 'family'], ['TEAM-KEY-8765', 'team'], ['BIZ-KEY-5678', 'business']]) {
    await lic.activate(k, 'test');
    check(`a ${t} key unlocks ${t}`, lic.tier() === t);
    await lic.remove();
  }
  await lic.activate('PRO-KEY-1234', 'test');
  check('a Pro key unlocks Pro', lic.tier() === 'pro');
  check('the key is stored encrypted, not as text', !fs.readFileSync(path.join(tmp, 'lic.json'), 'utf8').includes('PRO-KEY-1234'));
  const lic2 = new License({ file: path.join(tmp, 'lic.json'), secretStore: fakeStore, store, fetchImpl: fakeFetch, now: () => clock });
  check('the license survives a restart', lic2.tier() === 'pro');
  offline = true;
  check('no internet: the plan keeps working', (await lic.validate()) === 'offline' && lic.tier() === 'pro');
  clock += GRACE_MS + 1000;
  check('offline for over 30 days: back to Free until it can check again', lic.tier() === 'free');
  offline = false;
  check('back online: Pro again', (await lic.validate()) === 'ok' && lic.tier() === 'pro');
  weird = 422;
  check('an unexpected store error does NOT take the plan away', (await lic.validate()) === 'offline' && lic.tier() === 'pro');
  weird = 0;
  revoked.add('PRO-KEY-1234');
  check('a refunded/revoked key falls back to Free', (await lic.validate()) === 'revoked' && lic.tier() === 'free');
  revoked.clear();
  check('a revoked key is not re-checked right away', !lic.needsCheck());
  clock += 24 * 3600 * 1000 + 1000;
  check('…but is re-checked a day later, and comes back if the store says it is fine', lic.needsCheck() && (await lic.validate()) === 'ok' && lic.tier() === 'pro');
  await lic.remove();
  check('removing the key frees it and returns to Free', lic.tier() === 'free' && !fs.existsSync(path.join(tmp, 'lic.json')));

  // ---------- plans across PCs ----------
  const limits = { free: { pcs: 2, kids: 1, maxFileBytes: 1000 }, pro: { kids: 3, maxFileBytes: 5000 } };
  const mk = (name, extra = {}) => { const n = new VelsNode(Object.assign({ dataDir: path.join(tmp, name), tcpPort: 0, udpPort: port++, discovery: false, store, fetchImpl: fakeFetch, planLimits: limits, secretStore: fakeStore }, extra)); n.updateSettings({ name, receiveDir: path.join(tmp, name + '-recv') }); return n; };
  const pairUp = async (A, B) => {
    let pin = null, done = 0;
    const r = x => { pin = x.pin; }, n = p => setTimeout(() => A.pairPin(p.sid, pin), 30), d = () => done++;
    B.on('pair-request', r); A.on('pair-pin-needed', n); A.on('pair-done', d); B.on('pair-done', d);
    await A.pair({ host: '127.0.0.1', port: B.tcpPort });
    await until(() => done >= 2);
    B.off('pair-request', r); A.off('pair-pin-needed', n); A.off('pair-done', d); B.off('pair-done', d);
    return until(() => A.conns[B.id] && B.conns[A.id]);
  };
  const main = mk('Main'), kid1 = mk('Kid1', { activitySource: new EventEmitter() }), kid2 = mk('Kid2', { activitySource: new EventEmitter() });
  await main.start(); await kid1.start(); await kid2.start();
  await pairUp(kid1, main);
  await kid1.chooseMain(main.id, 'peer', '482915');
  await pairUp(kid2, main);
  await until(() => kid2.main.mainId === main.id);
  await kid1.configureMonitor({ pin: '482915' });
  check('Free plan: the first kid PC can share', await until(() => main.kidCount() === 1));
  await until(() => kid2.remote[main.id] && kid2.remote[main.id].mainInfo && kid2.remote[main.id].mainInfo.kids === 1);
  check('Free plan: one more kid PC than allowed is refused (with the reason)', await expectError(() => kid2.configureMonitor({ pin: '482915' }), /allows 1 kid PCs/));
  // even if a modified app skips that check, the main PC refuses it
  kid2.monitor = Object.assign(kid2.monitor, { enabled: true, parentId: main.id });
  kid2._monitorHello(kid2.conns[main.id]);
  check('the main PC itself enforces the limit', await until(() => !kid2.monitor.enabled) && main.kidCount() === 1);

  check('activating a license on a locked main PC needs the passcode', await expectError(() => main.activateLicense('PRO-KEY-1234'), /Locked/));
  main.unlockAdmin('482915');
  await main.activateLicense('PRO-KEY-1234');
  check('main PC is on Pro after activating', main.tier() === 'pro');
  check('kid PCs get the main PC\'s plan (one purchase per household)', await until(() => kid1.tier() === 'pro' && kid2.tier() === 'pro'));
  await kid2.configureMonitor({ pin: '482915' });
  check('Pro plan: more kid PCs can share', await until(() => main.kidCount() === 2));

  // ---------- file size limits ----------
  const small = path.join(tmp, 'small.bin'), mid = path.join(tmp, 'mid.bin'), huge = path.join(tmp, 'huge.bin');
  fs.writeFileSync(small, Buffer.alloc(800)); fs.writeFileSync(mid, Buffer.alloc(3000)); fs.writeFileSync(huge, Buffer.alloc(9000));
  main.setPerm(kid1.id, 'files', 'allow');
  await kid1.sendFiles(main.id, [mid]);
  check('Pro: a 3000-byte file (over the Free limit) can be sent', await until(() => [...main.transfers.values()].some(t => t.name === 'mid.bin' && t.state === 'done')));
  check('Pro: files over the Pro limit are refused before sending', await expectError(() => kid1.sendFiles(main.id, [huge]), /plan sends files up to/));
  await main.removeLicense();
  check('after removing the license everyone is back on Free', await until(() => main.tier() === 'free' && kid1.tier() === 'free'));
  check('kid PCs announce the change right away', await until(() => main.remote[kid1.id].plan === 'free', 1500));
  check('Free: a file over the Free limit is refused', await expectError(() => kid1.sendFiles(main.id, [mid]), /Family sends up to 5 GB/));
  // a modified sender that skips the check: the receiver still declines
  const c = kid1.conns[main.id];
  c.send({ t: 'file-offer', batchId: 'batchXYZ123', files: [{ fileId: 'fileXYZ123', name: 'mid.bin', size: 3000 }] });
  check('the receiving PC also enforces the size limit', await until(() => main.transfers.get('fileXYZ123') && main.transfers.get('fileXYZ123').state === 'declined'));
  await kid1.sendFiles(main.id, [small]);
  check('Free: small files still send', await until(() => [...main.transfers.values()].some(t => t.name === 'small.bin' && t.state === 'done')));
  check('existing kid PCs keep sharing after a downgrade (only new ones are blocked)', kid2.monitor.enabled && main.kidCount() === 2);

  // ---------- linked-PC limit (Free is set to 2 other PCs in this test) ----------
  const extra = mk('Extra'); await extra.start();
  const attempt = A => new Promise(res => { const d = x => { A.off('pair-done', d); res(x); }; A.on('pair-done', d); });
  let done = attempt(extra);
  await extra.pair({ host: '127.0.0.1', port: main.tcpPort });
  let r = await done;
  check('a full PC refuses new access requests (with the reason)', !r.ok && /Free plan and already linked to 2 PCs/.test(r.reason));
  check('the refusal is in the security log', main.secLog.some(e => e.kind === 'plan' && /Refused an access request from Extra/.test(e.text)));
  done = attempt(main);
  await main.pair({ host: '127.0.0.1', port: extra.tcpPort });
  r = await done;
  check('a full PC can\'t request access to a new PC either', !r.ok && /links up to 2 other PCs — Family links up to 6/.test(r.reason));
  check('nothing was paired', !main.peers[extra.id] && !extra.peers[main.id] && main.pcCount() === 2);
  check('already-linked PCs still count as allowed (re-pairing is fine)', main.canLink(kid1.id) && !main.canLink(extra.id));
  check('the window shows how many PCs are linked', main.planInfo().pcCount === 2 && main.planInfo().pcs === 2);
  extra.stop();

  main.stop(); kid1.stop(); kid2.stop();
  console.log(failures ? `\n${failures} plan check(s) FAILED` : '\nAll plan checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
