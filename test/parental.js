// Parental monitoring tests: run with  npm test
const { VelsNode } = require('../src/core/node');
const { classify } = require('../src/core/activity');
const EventEmitter = require('events');
const fs = require('fs'), os = require('os'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-par-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(40); } return true; };
let failures = 0, port = 56000 + Math.floor(Math.random() * 4000);
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const mk = (name, extra = {}) => { const n = new VelsNode(Object.assign({ dataDir: path.join(tmp, name), tcpPort: 0, udpPort: port++, discovery: false }, extra)); n.updateSettings({ name }); return n; };
const pairUp = async (A, B) => {
  let pin = null, done = 0;
  const r = x => { pin = x.pin; }, n = p => setTimeout(() => A.pairPin(p.sid, pin), 30), d = () => done++;
  B.on('pair-request', r); A.on('pair-pin-needed', n); A.on('pair-done', d); B.on('pair-done', d);
  await A.pair({ host: '127.0.0.1', port: B.tcpPort });
  await until(() => done >= 2);
  B.off('pair-request', r); A.off('pair-pin-needed', n); A.off('pair-done', d); B.off('pair-done', d);
  return until(() => A.conns[B.id] && B.conns[A.id]);
};

(async () => {
  // classification
  const mc = classify({ title: 'Minecraft 1.21.4 - Multiplayer (3rd-party Server)', path: 'C:\\Java\\bin\\javaw.exe', idle: 1 });
  check('Minecraft + game mode detected', mc.kind === 'game' && mc.app === 'Minecraft' && mc.detail === 'Multiplayer (3rd-party Server)');
  const st = classify({ title: 'Terraria', path: 'D:\\SteamLibrary\\steamapps\\common\\Terraria\\Terraria.exe', idle: 0 });
  check('Steam games are named from their folder', st.kind === 'game' && st.app === 'Terraria');
  const yt = classify({ title: 'Funny cats - YouTube - Google Chrome', path: 'C:\\Chrome\\chrome.exe', idle: 0, url: 'https://www.youtube.com/watch?v=1' });
  check('websites are detected from the address bar', yt.kind === 'browser' && yt.site === 'YouTube' && yt.detail === 'Funny cats - YouTube');

  // ---------- first connection: choose the main PC ----------
  const src = new EventEmitter();
  const kid = mk('Kid-PC', { activitySource: src }), parent = mk('Parent-PC'), other = mk('Other-PC');
  await kid.start(); await parent.start(); await other.start();
  let asked = null;
  kid.on('choose-main', e => { asked = e; });
  check('kid PC connects to the parent PC', await pairUp(kid, parent));
  check('the requesting PC is asked which PC is the main one', await until(() => asked && asked.peerId === parent.id));
  let threw = false;
  try { await kid.chooseMain(parent.id, 'peer', '1234'); } catch (e) { threw = /too easy/.test(e.message); }
  check('easy passcodes like 1234 are refused', threw);
  await kid.chooseMain(parent.id, 'peer', '482915');
  check('the other PC becomes the main PC (passcode set from the requesting PC)', parent.isMain && kid.main.mainId === parent.id);
  check('the passcode is stored only as a hash on the main PC', !fs.readFileSync(parent.settingsFile, 'utf8').includes('482915') && !fs.readFileSync(kid.settingsFile, 'utf8').includes('482915'));
  let other_asked = false;
  other.on('choose-main', () => { other_asked = true; });
  check('another PC connects to the kid PC', await pairUp(other, kid));
  await wait(500);
  check('no main-PC question when the network already has a main PC', !other_asked);
  // a later PC can't hijack the main role
  let hijack = '';
  try { await other.chooseMain(kid.id, 'peer', '777111'); } catch (e) { hijack = e.message; }
  check('a PC that already has a main PC cannot be made main by someone else', /cannot be made the main/.test(hijack) && !kid.isMain);

  // ---------- main PC is locked ----------
  check('main PC starts locked', parent.adminLocked());
  threw = false; try { await parent.requestHistory(kid.id, 0); } catch (e) { threw = /Locked/.test(e.message); }
  check('Family history needs the passcode on the main PC', threw);
  threw = false; try { parent.updateSettings({ lanOnly: false }); } catch (e) { threw = /Locked/.test(e.message); }
  check('security settings need the passcode on the main PC', threw && parent.settings.lanOnly === true);
  threw = false; try { parent.unlockAdmin('000001'); } catch (e) { threw = /Wrong/.test(e.message); }
  check('a wrong passcode does not unlock the main PC', threw && parent.adminLocked());
  parent.unlockAdmin('482915');
  check('the right passcode unlocks the main PC', !parent.adminLocked());
  parent.lockAdmin();

  // ---------- turning on sharing on the kid PC ----------
  threw = false; try { await kid.configureMonitor({ urls: true, keepDays: 30, pin: '111222' }); } catch (e) { threw = /Wrong/.test(e.message); }
  check('turning on sharing needs the main PC passcode (checked by the main PC)', threw && !kid.monitor.enabled);
  await kid.configureMonitor({ urls: true, keepDays: 30, pin: '482915' });
  check('sharing turns on and forces "start with computer"', kid.monitor.enabled && kid.monitor.parentId === parent.id && kid.settings.startWithWindows);
  check('parent PC learns the kid PC shares with it', await until(() => parent.getState().devices.find(d => d.id === kid.id).monitored));
  check('the kid PC gets a backup check for when the main PC is off (6 digits)', await until(() => !!kid.main.fallback));

  const t0 = Date.now();
  kid.activity.feed({ title: 'Minecraft 1.21.4 - Singleplayer', path: 'C:\\Java\\bin\\javaw.exe', idle: 0 }, t0 - 60000);
  kid.activity.feed({ title: 'Funny cats - YouTube - Google Chrome', path: 'C:\\Chrome\\chrome.exe', idle: 0, url: 'youtube.com' }, t0 - 30000);
  check('parent sees live status (Discord-style)', await until(() => { const d = parent.getState().devices.find(x => x.id === kid.id); return d.activity && d.activity.kind === 'browser' && d.activity.site === 'YouTube'; }));
  check('other paired PCs do NOT see the activity', !other.getState().devices.find(x => x.id === kid.id).activity);
  parent.unlockAdmin('482915');
  const h = await parent.requestHistory(kid.id, 0);
  check('parent can read today\'s history once unlocked', h.entries.some(e => e.app === 'Minecraft' && e.detail === 'Singleplayer') && h.entries.some(e => e.live && e.site === 'YouTube'));
  let denied = false;
  try { await other.requestHistory(kid.id, 0); } catch (e) { denied = /does not share/.test(e.message); }
  check('a non-parent PC is refused the history', denied);

  // ---------- exact pages, storage, deleting ----------
  kid.activity.feed({ title: 'Cat video 2 - YouTube - Google Chrome', path: 'C:\\Chrome\\chrome.exe', idle: 0, url: 'youtube.com/watch?v=two' }, t0 - 15000);
  kid.activity.feed({ title: 'Cat video 3 - YouTube - Google Chrome', path: 'C:\\Chrome\\chrome.exe', idle: 0, url: 'youtube.com/watch?v=three#t=20' }, t0);
  const h2 = await parent.requestHistory(kid.id, 0);
  check('each page is its own entry, with its exact address', h2.entries.some(e => e.url === 'https://youtube.com/watch?v=two' && e.host === 'youtube.com') && h2.entries.some(e => e.live && e.url === 'https://youtube.com/watch?v=three'));
  check('the parent sees how much history is saved on the kid PC', h2.storage && h2.storage.days >= 1 && h2.storage.bytes > 0 && h2.storage.keepDays === 30);
  check('the kid PC shows its own history size too', kid.getState().self.historyStorage && kid.getState().self.historyStorage.bytes > 0);
  denied = false;
  try { await kid.openHistoryFolderCheck('000000'); } catch (e) { denied = /Wrong/.test(e.message); }
  check("opening the kid PC's history folder needs the main PC passcode", denied);
  check('…and works with it', (await kid.openHistoryFolderCheck('482915')) === kid.activity.dir);
  denied = false;
  try { await other.deleteKidHistory(kid.id); } catch (e) { denied = /does not share|Locked/.test(e.message); }
  check('a non-parent PC cannot delete the history', denied && fs.readdirSync(path.join(kid.dataDir, 'activity')).some(f => f.endsWith('.jsonl')));
  await parent.deleteKidHistory(kid.id);
  check('the main PC can delete the history saved on the kid PC', !fs.readdirSync(path.join(kid.dataDir, 'activity')).some(f => f.endsWith('.jsonl')));
  check('history keeps working after deleting', (await parent.requestHistory(kid.id, 0)).entries.some(e => e.live));

  // ---------- the kid tries to get out ----------
  threw = false; try { await kid.configureMonitor({ enabled: false, pin: '999888' }); } catch (e) { threw = /Wrong/.test(e.message); }
  check('turning off needs the main PC passcode', threw && kid.monitor.enabled);
  threw = false; try { await kid.unpair(parent.id, '999888'); } catch (e) { threw = true; }
  check('removing the main PC needs the passcode', threw && !!kid.peers[parent.id]);
  kid.updateSettings({ startWithWindows: false, keepInTray: false });
  check('"start with computer" cannot be switched off while shared', kid.settings.startWithWindows && kid.settings.keepInTray);
  for (let i = 0; i < 4; i++) { try { await kid.verifyMainPasscode('10000' + i); } catch {} }
  threw = false; try { await kid.verifyMainPasscode('482915'); } catch (e) { threw = /Too many/.test(e.message); }
  check('5 wrong passcodes lock the passcode for 5 minutes', threw);
  check('the main PC is alerted', await until(() => parent.secLog.some(e => e.level === 'alert')));
  parent.pinFails.clear();

  // main PC off: backup check still works on the kid PC
  parent.stop();
  await until(() => !kid.conns[parent.id]);
  threw = false; try { await kid.verifyMainPasscode('121212'); } catch (e) { threw = /Wrong/.test(e.message); }
  check('with the main PC off, a wrong passcode is still refused', threw);
  check('with the main PC off, the right passcode still works (backup check)', await kid.verifyMainPasscode('482915'));
  await kid.configureMonitor({ enabled: false, pin: '482915' });
  check('the right passcode turns sharing off and deletes the history', !kid.monitor.enabled && !fs.readdirSync(path.join(kid.dataDir, 'activity')).some(f => f.endsWith('.jsonl')));

  // 4-digit passcode: no offline backup
  const p4 = mk('Parent4'), k4 = mk('Kid4', { activitySource: new EventEmitter() });
  await p4.start(); await k4.start();
  await pairUp(k4, p4);
  await k4.chooseMain(p4.id, 'self', '8264');
  check('choosing "this PC" makes the requesting PC the main PC', k4.isMain && await until(() => p4.main.mainId === k4.id));
  const p4b = mk('Kid4b', { activitySource: new EventEmitter() });
  await p4b.start(); await pairUp(p4b, k4);
  await until(() => p4b.main.mainId === k4.id);
  await p4b.configureMonitor({ pin: '8264' });
  await wait(400);
  check('4-digit passcodes are never stored on kid PCs', !p4b.main.fallback);
  k4.stop(); await until(() => !p4b.conns[k4.id]);
  threw = false; try { await p4b.verifyMainPasscode('8264'); } catch (e) { threw = /Turn on the main PC/.test(e.message); }
  check('with 4 digits, changes need the main PC to be on', threw);
  p4.stop(); p4b.stop();

  kid.stop(); other.stop();
  console.log(failures ? `\n${failures} parental check(s) FAILED` : '\nAll parental control checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
