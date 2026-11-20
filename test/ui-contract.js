// Checks that every piece of data the window reads (S.something.other in app.js)
// really exists in the state the app sends. Catches "blank page" bugs. Run with  npm test
const { VelsNode } = require('../src/core/node');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vels-ui-'));
(async () => {
  const n = new VelsNode({ dataDir: tmp, tcpPort: 0, udpPort: 0, discovery: false });
  const S = JSON.parse(JSON.stringify(n.getState()));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const paths = new Set();
  for (const m of src.matchAll(/\bS\.((?:[a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*){0,2})/g)) paths.add(m[1]);
  const skipLeaf = new Set(['length', 'some', 'find', 'filter', 'map', 'forEach', 'reduce', 'slice', 'includes', 'every', 'indexOf']);
  const missing = [];
  for (const p of paths) {
    const parts = p.split('.').filter(x => !skipLeaf.has(x));
    let cur = S, ok = true;
    for (const k of parts) {
      if (cur === null || cur === undefined) break;          // optional value further down is fine
      if (Array.isArray(cur)) break;                          // list items are checked elsewhere
      if (typeof cur === 'object' && !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (!ok) missing.push('S.' + p);
  }
  if (missing.length) { console.log('FAIL  the window reads data the app never sends:\n  ' + missing.join('\n  ')); process.exit(1); }
  console.log(`PASS  every piece of data the window reads exists (${paths.size} checked)`);
  process.exit(0);
})().catch(e => { console.error('FAIL (crash)', e); process.exit(1); });
