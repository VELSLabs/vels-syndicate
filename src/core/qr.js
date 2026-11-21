'use strict';
// Draws a QR code as an SVG image. The encoder in src/vendor/qrcode is
// "QRCode for JavaScript" by Kazuhiko Arase (MIT license, notice kept in the files).
const QRCode = require('../vendor/qrcode');
const QRErrorCorrectLevel = require('../vendor/qrcode/QRErrorCorrectLevel');

function matrix(text) {
  const q = new QRCode(-1, QRErrorCorrectLevel.M);
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(!!q.isDark(r, c)); rows.push(row); }
  return rows;
}

// One SVG <path> (small and crisp). quiet = white border in modules, as the QR standard asks for.
function svg(text, quiet = 3) {
  const m = matrix(text), n = m.length, size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { matrix, svg };
