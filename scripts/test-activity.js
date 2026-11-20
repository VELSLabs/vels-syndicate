#!/usr/bin/env node
// Windows check for parental controls: prints what the activity helper sees for 20 seconds.
// Switch between a game, a browser and other apps while it runs.
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const { ActivityMonitor, classify } = require('../src/core/activity');
if (process.platform !== 'win32') { console.log('This check is for Windows.'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-act-'));
const mon = new ActivityMonitor({ dir, includeUrls: true });
const origFeed = mon.feed.bind(mon);
let samples = 0;
mon.feed = (s, now) => { samples++; const c = classify(s); console.log(`[${new Date().toLocaleTimeString()}] ${c.kind.padEnd(7)} ${c.app}${c.site ? ' · ' + c.site : ''}${c.detail ? ' · ' + c.detail : ''}${c.idle ? ' (idle)' : ''}`); return origFeed(s, now); };
console.log('Watching the front window for 20 seconds (one check every 5 s)...\n');
mon.start();
setTimeout(() => {
  mon.stop();
  console.log(samples ? `\nOK — the helper works (${samples} checks).` : '\nNo data came back. PowerShell may be blocked on this PC (antivirus or company policy).');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(samples ? 0 : 1);
}, 21000);
