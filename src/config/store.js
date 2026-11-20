'use strict';
// Where paid licenses are sold. See SELLING.md for how to fill this in.
// Everything here is PUBLIC information (it ships inside the app), never put secrets or API tokens here.
//
// LIVE store: VELS Labs on polar.sh. Real money moves.
// To test without paying, use the test store values in SELLING.md → "Test store" instead.
module.exports = {
  provider: 'polar',
  // Live store: https://api.polar.sh/v1   ·   Test store: https://sandbox-api.polar.sh/v1
  apiBase: 'https://api.polar.sh/v1',
  // Polar → Settings → your organization ID (VELS Labs)
  organizationId: '4d402013-02c3-4c1a-9948-de44f2a079e2',
  // Polar → Products → Benefits → License Keys benefit ID, one or more per plan
  benefits: {
    family: ['5a1cd0bc-8fe4-49f1-86aa-668b642785ff'],
    pro: ['a0cbf975-654b-4a60-a133-06e9337f1c4f'],
    team: ['8903ccaf-7a60-4cb7-ab62-f140f3c7b0d4'],
    business: ['e55c0c58-ecd9-4519-aa4e-ad143d2e73f5'],
  },
  // Shown in the app next to each plan (any text, e.g. '$5 one-time'). Leave empty to hide.
  price: {
    family: '$5 one-time',
    pro: '$15 one-time',
    team: '$69 one-time',
    business: '$199 one-time',
  },
  // Polar → Products → Checkout Links
  checkoutUrl: {
    family: 'https://buy.polar.sh/polar_cl_hCelRBlCSN3LcnagsHGQg4C58O3grYvoxWnvs2Abuyg',
    pro: 'https://buy.polar.sh/polar_cl_NTXU5QMr3OtjgwNf7moTeGKKxHZrxOLorEhqE0nwZ5G',
    team: 'https://buy.polar.sh/polar_cl_CfiYPCWwNJ6JzOd3lCxnOD3BjwSDGINUZRTZG084PGp',
    business: 'https://buy.polar.sh/polar_cl_JcWDH7ypIhkaKwiYKAwSllzkNAwqSPASbz5NQ1occ8x',
  },
};
