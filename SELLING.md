# Selling licenses (Family, Pro, Team, Business)

VELS Syndicate sells one-time licenses through **Polar** (polar.sh). Polar is the "merchant of record": it takes the payment, handles sales tax and VAT, emails the buyer a license key, and checks keys for the app. You don't need a server.

The app only needs four public values, all in `src/config/store.js`. None of them are secrets.

## 1. Create the store (start in test mode)

1. Sign up at **sandbox.polar.sh** (Polar's test site, where no real money moves). When everything works, repeat the same steps on **polar.sh**.
2. Create an organization for VELS Syndicate.

## 2. Create the products

Create four products, each with a **one-time price** (not a subscription). Suggested prices:

| Product | Suggested price | Benefit settings |
|---|---|---|
| VELS Syndicate Family | $5 | Add a **License Keys** benefit · activation limit **3** (main PC plus a couple of reinstalls) · no expiry |
| VELS Syndicate Pro | $15 | Its own **License Keys** benefit · activation limit **3** · no expiry |
| VELS Syndicate Team | $69 | Its own **License Keys** benefit · activation limit **3** · no expiry |
| VELS Syndicate Business | $199 | Its own **License Keys** benefit · activation limit **3** · no expiry |

Each product needs its **own** License Keys benefit. The app tells the plans apart by which benefit a key belongs to.

Team and Business are the plans that allow use in a business (see `NOTICE.md`). Family and Pro are for personal and family use.

## 3. Copy the IDs into the app

Open `src/config/store.js` and fill in:

```js
apiBase: 'https://sandbox-api.polar.sh/v1',  // test mode; use https://api.polar.sh/v1 for real sales
organizationId: 'your organization ID',
benefits: {
  family: ['the Family product's License Keys benefit ID'],
  pro: ['the Pro product's License Keys benefit ID'],
  team: ['the Team product's License Keys benefit ID'],
  business: ['the Business product's License Keys benefit ID'],
},
price: {
  family: '$5 one-time',        // any text, shown next to the plan in the app
  pro: '$15 one-time',
  team: '$69 one-time',
  business: '$199 one-time',
},
checkoutUrl: {
  family: 'the Family product's checkout link',
  pro: 'the Pro product's checkout link',
  team: 'the Team product's checkout link',
  business: 'the Business product's checkout link',
},
```

You'll find the organization ID in your organization settings, the benefit IDs on each benefit, and the checkout links on each product. The prices are only display text, so make them match what you set in Polar.

A plan whose checkout link is empty still shows in the app. Its **Get** button explains that purchases aren't set up yet.

## 4. Test a purchase

1. Build the app (`BUILD.bat`) and open **Settings → Plan → Get Family**. The test checkout opens in your browser.
2. Pay with Polar's test card. The license key arrives by email and in Polar's customer portal.
3. On the **main PC**, open **Settings → Plan → Enter license key…** and paste the key. The plan changes to Family on the main PC and on every PC connected to it.
4. Try **Remove from this PC…**. The key's activation is freed, so it can be used on another PC.

## 5. Go live (done)

The app now uses the **live** VELS Labs store on polar.sh (`src/config/store.js`):

- Four License Keys benefits: prefix `VELS`, no expiry, 3 activations, customers can free activations themselves.
- Four one-time products: VELS Syndicate Family $5, Pro $15, Team $69, Business $199, each granting its own key.
- Four checkout links (`https://buy.polar.sh/...`), one per product.

Keys from the test store do **not** work in the live build, and live keys don't work against the test store.

**Updates keep keys working.** Buyers' keys are saved on their PCs and survive every update. Keys only stop working if you delete or replace a License Keys benefit in Polar, or change `organizationId` / `benefits` in `store.js`. To add a new plan later, add a new benefit; never swap out an existing one.

### Test store values (for testing without paying)

To test a build without real money, swap these into `store.js` temporarily, and put the live values back before publishing:

```js
apiBase: 'https://sandbox-api.polar.sh/v1',
organizationId: 'd964dd1f-c1ab-49a1-8481-e06c652783ab',
benefits: {
  family: ['1cb892d7-2682-4be5-a906-90ba9c96c07c'],
  pro: ['d2288d0f-21f2-46da-b57f-6d4fec5cda5b'],
  team: ['01c46708-06b4-4189-aab7-37600d2ffc07'],
  business: ['c3ae4801-45a9-48cc-939c-9a8fc7df2515'],
},
checkoutUrl: {
  family: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_3j3C1s8uhaimiBJxxuZb8JhUXKSBnC7rUSgve3KHx22/redirect',
  pro: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_1kjlTOXMbWr05SfYk3OErI7V76QdYRFnIlzLc4Z2erA/redirect',
  team: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_PfEx4z1C6NONmPoywmM1RZZXico7HKu3hEnOx0UovFR/redirect',
  business: 'https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_tnGJiFEkJ7ukMeUfbYthxSbTSJTdtmOtQuRFW4ISxTG/redirect',
},
```

## How the app uses the key

- The key is entered on the **main PC**. Every PC connected to it gets the same plan, so one purchase covers the whole household.
- Activating needs the internet once. After that the app works fully offline.
- The key is re-checked about once a day when online. If the store can't be reached, the plan keeps working for **30 days**, then falls back to Free until it can check again.
- A **revoked** key falls back to Free at the next check. Refunding alone does **not** revoke the key (see below).
- The key is stored encrypted with the Windows account (DPAPI), like the pairing keys.
- The plan limits are in `src/core/plans.js`:

| Plan | Other PCs you can link | File transfers | Business use |
|---|---|---|---|
| Free | 3 | up to 1 GB per file | — |
| Family | 6 | up to 5 GB per file | — |
| Pro | 15 | up to 20 GB per file | — |
| Team | 25 | up to 100 GB per file | ✓ |
| Business | 100 | any size | ✓ |

"Linked PCs" are the other PCs this one is paired with; the PC itself doesn't count. A main PC plus 3 kids' PCs fits Free. Every kid PC is also a linked PC, so the same number limits the Family page.

When a plan is downgraded, PCs that are already linked or sharing keep working. Only new ones are blocked.

## Refunds

1. In Polar, open the order and choose **Refund order**. You decide the refund policy; Polar works out the tax part.
2. **Turn on "revoke benefits"** in the refund dialog (it is off by default). If you forget, the key keeps working. You can still turn it off later: open the License Keys benefit, find the key and set it to revoked or disabled.
3. The buyer's app notices at its next check (within about a day when online) and goes back to Free. Nothing on their PCs is deleted.

## Good to know

- The code is public, so someone skilled could remove the plan checks in their own copy. The license (see `NOTICE.md`) doesn't allow that for commercial use, and most people simply buy. The checks are enforced on both PCs, so one modified PC isn't enough.
- Polar's fees, payout schedule and the countries it supports can change. Check polar.sh/pricing before you set your prices. At the time of writing, a new store pays 5% + 50¢ per sale, so a $5 sale leaves about $4.25.
- Monitoring staff PCs (Team, Business) can come with notice or consent rules where the business is. The app always shows on the monitored PC that sharing is on, but the business should also tell its staff.
- This guide isn't legal or tax advice.
