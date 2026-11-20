'use strict';
// Plan limits. Change the numbers here; everything else reads from this file.
//   pcs           how many OTHER PCs this PC can link to (your own PC doesn't count)
//   kids          how many of those can share activity with the main PC (Family page)
//   maxFileBytes  largest single file that can be sent
const GB = 1024 ** 3;

const PLANS = {
  free: { name: 'Free', pcs: 3, kids: 3, maxFileBytes: 1 * GB },
  family: { name: 'Family', pcs: 6, kids: 6, maxFileBytes: 5 * GB },
  pro: { name: 'Pro', pcs: 15, kids: 15, maxFileBytes: 20 * GB },
  team: { name: 'Team', pcs: 25, kids: 25, maxFileBytes: 100 * GB, commercial: true },
  business: { name: 'Business', pcs: 100, kids: 100, maxFileBytes: Infinity, commercial: true },
};
const ORDER = ['free', 'family', 'pro', 'team', 'business'];
const PAID = ORDER.slice(1);

const isTier = t => ORDER.includes(t);
const plan = t => PLANS[isTier(t) ? t : 'free'];
const norm = t => (isTier(t) ? t : 'free');
// the better of two plans (used when two PCs with different plans talk to each other)
const best = (a, b) => (ORDER.indexOf(norm(a)) >= ORDER.indexOf(norm(b)) ? norm(a) : norm(b));
// the next plan up, or null on the top plan
const next = t => ORDER[ORDER.indexOf(norm(t)) + 1] || null;

module.exports = { PLANS, ORDER, PAID, isTier, norm, plan, best, next };
