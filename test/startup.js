// Starting up the way the app does on a real PC (network discovery on). Run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
let crashed = '';
process.on('uncaughtException', e => { crashed = e.message; });
(async () => {
  let ok = true;
  for (let i = 0; i < 5; i++) {
    const n = new VelsNode({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vels-start-')), tcpPort: 0, phonePort: 0, udpPort: 0 });
    await n.start();
    await new Promise(r => setTimeout(r, 250));
    if (crashed || !Array.isArray(n.timers) || n.timers.length < 6) ok = false;
    n.stop();
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  starts with network discovery on, 5 times in a row${crashed ? ' (crash: ' + crashed + ')' : ''}`);
  console.log(ok ? '\nAll startup checks passed' : '\nStartup check FAILED');
  process.exit(ok ? 0 : 1);
})();
