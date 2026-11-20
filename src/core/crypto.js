'use strict';
// Small crypto helpers for VELS Syndicate.
// Pairing: X25519 key exchange; the requesting PC proves it knows the PIN shown on the other PC.
// Sessions: X25519 per connection + long-term paired key -> AES-256-GCM, one key per direction.
const crypto = require('crypto');

function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}

function dh(privateKey, pubB64) {
  const publicKey = crypto.createPublicKey({ key: Buffer.from(String(pubB64), 'base64'), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey, publicKey });
}

function hkdf(ikm, salt, info, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(salt), Buffer.from(info), len));
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p)).update('\u0000');
  return h.digest();
}

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(String(p)).update('\u0000');
  return h.digest('base64');
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

function nonce(n = 16) { return crypto.randomBytes(n).toString('base64'); }
function randomId() { return crypto.randomBytes(9).toString('base64url'); }

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 29) throw new Error('short frame');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { genKeyPair, dh, hkdf, sha256, hmac, safeEqual, nonce, randomId, seal, open };
