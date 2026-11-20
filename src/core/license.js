'use strict';
// Pro / Business license keys, sold through Polar (see SELLING.md and src/config/store.js).
// - Activating a key needs the internet once; after that the app works offline.
// - The key is re-checked about once a day when online. If the store can't be reached the
//   plan keeps working for 30 days, then falls back to Free until it can check again.
// - A revoked key (revoke it in Polar when refunding) falls back to Free at the next check.
// - The key is stored encrypted with the system keychain, like the pairing keys.
const fs = require('fs');
const STORE = require('../config/store');
const Plans = require('./plans');

const GRACE_MS = 30 * 86400000;
const RECHECK_MS = 24 * 3600000;
const KEY_RE = /^[A-Za-z0-9_-]{8,120}$/; // Polar keys: a UUID, optionally with a prefix like "VELS_"

class License {
  constructor({ file, secretStore, store = STORE, fetchImpl, now = () => Date.now() }) {
    this.file = file;
    this.secretStore = secretStore || { kind: 'none' };
    this.store = store;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now;
    this.state = null; // { key, activationId, tier, status, checkedAt, activatedAt, label, displayKey }
    this._load();
  }

  _list(field, tier) { const o = this.store[field] || {}; return Array.isArray(o[tier]) ? o[tier] : []; }
  _text(field, tier) { const o = this.store[field] || {}; return typeof o[tier] === 'string' ? o[tier] : ''; }
  get configured() { return !!(this.store.organizationId && Plans.PAID.some(t => this._list('benefits', t).length)); }

  // the plan this PC has bought (or 'free')
  tier() {
    const s = this.state;
    if (!s || s.status !== 'granted') return 'free';
    if (this.now() - (s.checkedAt || 0) > GRACE_MS) return 'free';
    return Plans.norm(s.tier);
  }

  info() {
    const s = this.state;
    return {
      configured: this.configured, tier: this.tier(), hasKey: !!s, status: s ? s.status : null,
      displayKey: s ? s.displayKey : '', checkedAt: s ? s.checkedAt : null,
      stale: !!s && s.status === 'granted' && this.now() - (s.checkedAt || 0) > GRACE_MS,
      checkout: Object.fromEntries(Plans.PAID.map(t => [t, this._text('checkoutUrl', t)])),
      price: Object.fromEntries(Plans.PAID.map(t => [t, this._text('price', t)])),
    };
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let key = null;
      if (raw.keyEnc && this.secretStore.decrypt) key = this.secretStore.decrypt(raw.keyEnc);
      else if (typeof raw.key === 'string') key = raw.key;
      if (!key || !KEY_RE.test(key)) return;
      this.state = { key, activationId: raw.activationId || null, tier: Plans.norm(raw.tier), status: raw.status === 'revoked' ? 'revoked' : 'granted', checkedAt: +raw.checkedAt || 0, triedAt: +raw.triedAt || 0, activatedAt: +raw.activatedAt || 0, displayKey: String(raw.displayKey || '').slice(0, 40) };
    } catch { this.state = null; }
  }

  _save() {
    if (!this.state) { try { fs.unlinkSync(this.file); } catch {} return; }
    const { key, ...rest } = this.state;
    const out = Object.assign({}, rest, this.secretStore.encrypt ? { keyEnc: this.secretStore.encrypt(key) } : { key });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  _tierForBenefit(benefitId) {
    // highest plan first, in case one benefit is (wrongly) listed under two plans
    for (const t of [...Plans.PAID].reverse()) if (this._list('benefits', t).includes(benefitId)) return t;
    return null;
  }

  async _post(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(this.store.apiBase + path, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, network: true, error: e.name === 'AbortError' ? 'The store did not answer' : 'No internet connection' };
    } finally { clearTimeout(timer); }
  }

  _errorText(r) {
    if (r.network) return r.error + ' — activating a key needs the internet once.';
    const d = r.data && (r.data.detail || r.data.error || r.data.message);
    const msg = Array.isArray(d) ? d.map(x => x.msg || '').join(' ') : String(d || '');
    if (r.status === 404) return "That license key wasn't found. Check it for typos.";
    if (/activation/i.test(msg) && /limit/i.test(msg)) return 'This key is already active on the maximum number of PCs. Remove it from the old PC first (Settings → Plan → Remove).';
    if (r.status === 403 || /revoked|disabled/i.test(msg)) return 'This license key is no longer valid (refunded or turned off).';
    return msg ? 'The store said: ' + msg.slice(0, 160) : `The store returned an error (${r.status}).`;
  }

  async activate(rawKey, label) {
    if (!this.configured) throw new Error("This copy of VELS Syndicate isn't connected to a store yet (see SELLING.md).");
    const key = String(rawKey || '').trim();
    if (!KEY_RE.test(key)) throw new Error("That doesn't look like a license key.");
    const r = await this._post('/customer-portal/license-keys/activate', { key, organization_id: this.store.organizationId, label: String(label || 'VELS Syndicate').slice(0, 60) });
    if (!r.ok || !r.data) throw new Error(this._errorText(r));
    const lk = r.data.license_key || {};
    const tier = this._tierForBenefit(lk.benefit_id);
    if (!tier) throw new Error("This license key is for a different product.");
    if (lk.status && lk.status !== 'granted') throw new Error('This license key is no longer valid (refunded or turned off).');
    this.state = { key, activationId: r.data.id || null, tier, status: 'granted', checkedAt: this.now(), activatedAt: this.now(), displayKey: lk.display_key || ('****-' + key.slice(-4)) };
    this._save();
    return this.info();
  }

  // Returns 'ok' | 'revoked' | 'offline' | 'none'
  async validate() {
    const s = this.state;
    if (!s) return 'none';
    if (!this.configured) return 'offline';
    const body = { key: s.key, organization_id: this.store.organizationId };
    if (s.activationId) body.activation_id = s.activationId;
    const r = await this._post('/customer-portal/license-keys/validate', body);
    s.triedAt = this.now();
    // Only a clear answer takes a plan away: the key no longer exists (404), or the store says it's revoked.
    // Anything else (outage, rate limit, an unexpected error) counts as "couldn't check": the 30-day grace applies.
    if (r.network || r.status >= 500 || r.status === 429) { this._save(); return 'offline'; }
    if (r.status === 404) { s.status = 'revoked'; this._save(); return 'revoked'; }
    if (!r.ok || !r.data) { this._save(); return 'offline'; }
    const tier = this._tierForBenefit(r.data.benefit_id);
    if (!tier || (r.data.status && r.data.status !== 'granted')) { s.status = 'revoked'; this._save(); return 'revoked'; }
    s.tier = tier; s.status = 'granted'; s.checkedAt = this.now();
    this._save();
    return 'ok';
  }

  needsCheck() {
    const s = this.state;
    if (!s) return false;
    // a revoked key is re-checked once a day too, so a mistake on the store's side fixes itself
    if (s.status === 'revoked') return this.now() - (s.triedAt || 0) > RECHECK_MS;
    return this.now() - (s.checkedAt || 0) > RECHECK_MS;
  }

  // Frees this PC's activation so the key can be used on another PC.
  async remove() {
    const s = this.state;
    if (!s) return;
    if (this.configured && s.activationId) {
      await this._post('/customer-portal/license-keys/deactivate', { key: s.key, organization_id: this.store.organizationId, activation_id: s.activationId });
    }
    this.state = null;
    this._save();
  }
}

module.exports = { License, GRACE_MS, RECHECK_MS };
