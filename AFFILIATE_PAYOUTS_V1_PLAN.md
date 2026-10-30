# Affiliate Payouts v1 — know when to pay, and that you've paid

Scope locked 2026-08-30. Affiliates are now making real sales; the program's
tracking + crediting side is solid, but the payout side can't answer "which
commissions are actually due?" or "did I already pay this?" cleanly. Four
decisions locked with Ben:

1. **Eligibility**: payouts queue splits **Due now** (sale ≥ 60 days old) vs
   **Maturing** (with eligible-on date). Derived at read time — no schema
   field, no cron.
2. **Voiding**: refunds + chargebacks auto-void pending referrals; a manual
   Void button covers edge cases. Paid-then-refunded referrals get flagged
   for manual clawback, never silently adjusted.
3. **Payout method**: affiliate self-service card on their dashboard
   (PayPal / bank / other + details), surfaced to the owner in the queue.
4. **Batch pay**: one "Mark N paid" button per affiliate group with a single
   note dialog; per-referral button stays.

Everything stays behind `LANDING_VARIANT === "leadstack"` like the rest of
the affiliate program.

---

## What already exists (do not rebuild)

- **Crediting** — [src/lib/affiliate/referrals.ts](src/lib/affiliate/referrals.ts)
  `createReferral()` from the Stripe webhook. Doc id = checkout session id
  (idempotent), self-referral blocked, 40% computed at credit time, affiliate
  running totals bumped atomically.
- **Types** — [src/types/affiliate.ts](src/types/affiliate.ts): `Referral.status:
  "pending" | "paid" | "voided"`, `paidOutAt`, `paidOutNote`;
  `Affiliate.pendingCommissionCents` / `paidCommissionCents`.
- **Admin** — `/agency/affiliates` (table + "Payouts queue $X owed" button),
  `/agency/affiliates/payouts` (pending referrals grouped by affiliate,
  per-referral MarkPaidButton), `/agency/affiliates/[id]` (detail + referral
  list + mark-paid).
- **Mark-paid route** — [src/app/api/agency/affiliates/payouts/mark-paid/route.ts](src/app/api/agency/affiliates/payouts/mark-paid/route.ts):
  transaction moves pending → paid on both docs, refuses double-pay + voided.
- **Affiliate-facing** — `/affiliate/dashboard` (stats + 60-day policy copy)
  and `/affiliate/dashboard/conversions` (per-referral status badges incl.
  a Voided badge that already renders).

## Gaps this plan closes

- `voided` has **zero writers** — [src/lib/stripe/dispute.ts](src/lib/stripe/dispute.ts)
  never touches referrals and there is no `charge.refunded` handler at all,
  so a refunded sale sits in the queue as money owed forever.
- No eligibility clock — the stated 60-day policy exists only as dashboard copy.
- No payout method on file ("reply to your welcome email" is the current flow).
- No batch pay; note capture is a `window.prompt`.
- `paidOutAt` / `paidOutNote` are stored but displayed nowhere.

---

## 1. Schema (additive, no migration)

**`Referral`** ([src/types/affiliate.ts](src/types/affiliate.ts)):
- `voidedAt: Timestamp | null`
- `voidReason: "refund" | "dispute" | "manual" | null`
- `paidThenRefunded?: boolean` — set when a refund/dispute lands on an
  already-**paid** referral. Paid totals are NOT adjusted (the money left the
  building); this flag drives a clawback alert instead.

**`Affiliate`**:
- `payoutMethod: "paypal" | "bank" | "other" | null`
- `payoutDetails: string | null` (≤500 chars, free text — PayPal email, BSB/acct, etc.)
- `payoutDetailsUpdatedAt: Timestamp | null`

Legacy docs read all of these as absent/null — every read site must tolerate
`undefined` (same convention as the feature gates).

No stored `eligibleAt` — derived at read time from `createdAt`.

## 2. Eligibility — Due now vs Maturing

New shared helper (server-only, next to `dashboard-data.ts`):

```ts
export const PAYOUT_MATURITY_DAYS = 60;
export function referralEligibleAt(createdAt: Timestamp): Date; // +60d
export function referralIsDue(referral): boolean;
```

**Payouts queue** ([payouts/page.tsx](src/app/(dashboard)/agency/affiliates/payouts/page.tsx)):
- Per affiliate group, split rows: **Due now** on top; **Maturing** below
  (muted, each row shows "eligible <date>").
- Header strip: **"Due now $X"** as the primary number; "Total pending $Y"
  secondary. Group headers show both.
- Mark-paid remains allowed on maturing rows (paying early is the owner's
  call) — the row just carries the eligible-on hint.
- Affiliates list page badge switches from total-pending to due-now amount
  (rollup needs the referral dates, so compute due-now in the payouts data
  helper and pass it up — or keep the badge as total pending and add a second
  "due now" stat card; implementer's pick, keep it one extra query max).

**Affiliate-facing**: conversions rows gain "matures <date>" on pending rows
so the 60-day policy is visible, not just prose.

## 3. Voiding — auto on refund/dispute + manual

New server lib `src/lib/affiliate/void.ts`:

```ts
voidReferralBySessionId(sessionId, reason): Promise<VoidOutcome>
voidReferral(referralId, reason): Promise<VoidOutcome>
```

Transaction semantics:
- `pending` → `voided`: stamp `voidedAt` + `voidReason`, decrement the
  affiliate's `pendingCommissionCents` by `commissionCents`. Keep
  `referralCount` as-is (lifetime attribution stat, not money).
- `paid` → set `paidThenRefunded: true` + `voidReason` (status stays `paid`;
  paid totals untouched). Surfaces as a clawback alert (see below).
- `voided` → no-op (idempotent — a refund following a dispute, retried
  webhooks, or manual-then-auto all collapse).
- Missing referral → no-op (most purchases have no referral; this is the
  common path and must be silent).

Wire-in points:
- **[dispute.ts](src/lib/stripe/dispute.ts)** `handleChargeDispute()` — it
  already resolves the checkout session id from the charge; referral doc id
  IS the session id, so it's one best-effort call (`reason: "dispute"`),
  swallow-and-log like the other side effects there.
- **New `charge.refunded` case** in
  [src/app/api/webhooks/stripe/route.ts](src/app/api/webhooks/stripe/route.ts)
  → thin handler that resolves the session from the charge (reuse the same
  lookup pattern dispute.ts uses: charge → payment_intent → session list)
  → `voidReferralBySessionId(sessionId, "refund")`. Only acts on full
  refunds of founders purchases; partial refunds log + skip (manual call).
- **Manual Void button** — on pending rows in the payouts queue + admin
  detail page. Confirm dialog with optional reason note (stored in
  `voidReason: "manual"` + reuse `paidOutNote`? No — add nothing; the reason
  enum is enough for v1). Route:
  `POST /api/agency/affiliates/payouts/void` (owner-only, mirrors mark-paid).

**Clawback alert**: payouts queue renders a red "Paid but refunded" section
listing `paidThenRefunded` referrals (query: `where("paidThenRefunded", "==", true)`
— single-field, no index) with a Dismiss action (`clawbackResolvedAt`
timestamp) once Ben has recovered/absorbed the money.

**⚠ Stripe dashboard step (deploy checklist):** add `charge.refunded` to the
webhook endpoint's subscribed events. (`charge.dispute.created` is already on
the chargeback-activation TODO list — do both at once.)

## 4. Payout method — affiliate self-service ✅ BUILT 2026-08-30

> Shipped ahead of the rest (Ben asked for it first). Delta vs the spec
> below: the owner-side is display-only for now (queue group headers +
> detail page via `PayoutDetailsBadge` with copy-to-clipboard, amber
> "No payout method on file" when missing) — the owner-entered edit form
> is deferred until needed. Route: `POST /api/affiliate/payout-method`.
> Stub twins added for all three new files.

- **Affiliate dashboard**: "How you get paid" card (method select +
  details input + save). New route `POST /api/affiliate/payout-method` —
  authed by the existing affiliate session cookie (`getCurrentAffiliate()`),
  validates method enum + 500-char cap. Replaces the "reply to your welcome
  email" prose (keep a fallback line for bank-transfer specifics).
- **Owner surfaces**: payouts queue group header shows method + details
  inline (e.g. "PayPal · ben@x.com"), amber "No payout method on file" when
  missing. Admin detail page shows it too, owner-editable (small inline form
  posting to an owner route `PATCH /api/agency/affiliates/[id]/payout-method`)
  for details collected out-of-band.

## 5. Batch mark-paid

- Extend the mark-paid route to accept `{ referralIds: string[], note }`
  (keep single `referralId` working). One transaction: read all, skip
  already-paid/voided, flip the rest, single aggregate increment per
  affiliate. Cap at 200 ids (well under txn limits; queue caps at 500 rows
  total anyway). Response reports `{ paid, skipped }`.
- Queue group header: **"Mark N due paid — $X"** button (due-now rows only;
  maturing rows are per-referral only). Proper shadcn dialog with the note
  field — and upgrade the per-referral `window.prompt`/`alert` to the same
  dialog while in there.

## 6. Paid visibility ("did I pay this?") ✅ BUILT 2026-08-30

> Shipped: admin detail paid rows show paid date + note; affiliate
> conversions paid rows show paid date (note deliberately NOT shown to
> affiliates — it can carry private remarks); payouts queue gained a
> "Recently paid" section (last 20, affiliate email + buyer + note +
> date + amount). `referrals(status, paidOutAt)` composite added to
> firestore.indexes.json — **needs `firebase deploy --only
> firestore:rules,firestore:indexes` before the queue page loads in prod.**

- Admin detail + queue paid rows: show `paidOutAt` date and `paidOutNote`
  (subline or title tooltip).
- Affiliate conversions: paid rows show the paid date.
- Payouts queue: collapsed **"Recently paid"** section at the bottom — last
  ~20 paid referrals (`where("status","==","paid").orderBy("paidOutAt","desc")`
  — needs a composite index? status equality + paidOutAt order →
  **yes, add `referrals(status, paidOutAt)` to firestore.indexes.json** and
  deploy) so a payout session ends with visible confirmation.

## Build order

1. Voiding lib + webhook wiring + manual button (money correctness first).
2. Eligibility split in the queue (+ affiliate-side maturity dates).
3. Batch mark-paid + dialog UX upgrade.
4. Payout method (affiliate card + owner surfaces).
5. Paid-visibility polish (notes, dates, recently-paid section).

## Deploy checklist

- Stripe dashboard: subscribe the webhook endpoint to `charge.refunded`
  (and `charge.dispute.created` if not already done per the chargeback TODO).
- `firebase deploy --only firestore:rules,firestore:indexes` — new
  `referrals(status, paidOutAt)` composite index. No rules changes
  (affiliate collections are admin-SDK-only / default-deny already).
- Publish pipeline: any NEW leadstack-only files under `src/` need
  publish/stubs twins (precedent: `publish/stubs/src/components/affiliate/affiliates-table.tsx`).

## Not in v1

- Automated payouts (PayPal Payouts API / Stripe transfers) — manual send +
  mark-paid stays the rail.
- Partial-refund proration — log + manual void.
- Referral-level currency — everything is USD cents like today.
- Affiliate notification emails on payout — the dashboard status flip is the
  signal; add email later if affiliates ask.
