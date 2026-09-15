# SP13 (e) — Reselling overview, E2E evidence notes

Spec: `e2e/specs/reselling-table.spec.ts`. **Not run in this session** — worktree
rules for this task forbid Playwright and live Firestore writes. This file
records what the spec does and what it proves so a run can be verified
against it directly, without re-deriving intent from the code.

## Scope decision — no "Your price / Your profit" columns

GHL's Reselling table shows Your price / Customer's price / Your profit
because GHL agencies buy sub-accounts wholesale from GHL and mark them up.
This deployment has no such field: `BillingPlanDoc` carries one price
(`priceMonthlyCents` / `priceAnnualCents`) — what the client pays through the
agency's own Stripe account — and there is no wholesale-cost concept
anywhere in `src/types/billing.ts` to subtract from it. Inventing a "your
price" would mean fabricating a number the system doesn't track, which the
task explicitly rules out (DISPLAY-ONLY, no billing changes, no new fields).
The table instead shows price + subscriber counts + MRR per plan, plus a
second table comparing plan features side by side (the GHL parity piece that
*does* map cleanly: comparing what each plan includes).

## Production mutations per assertion

All writes are scoped to the fixture PRIMARY sub-account
(`E2E_SUBACCOUNT_ID`, name-asserted via `assertFixtureSubAccount` before any
write) and to a plan doc this spec creates itself under the fixture agency
(`agencies/{E2E_AGENCY_ID}/plans/e2e-resell-<Date.now()>`).

| Step | Mutation | Assertion it supports |
|---|---|---|
| `beforeAll` | Reads `subAccounts/{primary}.billing` and holds it (`priorBilling`) — not yet written | Nothing; this is the restore snapshot |
| `beforeAll` | `agencies/{agency}/plans/e2e-resell-<stamp>`.set(...) — status `active`, currency `zar`, `priceMonthlyCents: 49900`, two gates true (`broadcastsEnabledByAgency`, `whatsappEnabledByAgency`), all three `stripe*Id` fields `null` | Row renders for a plan with no Stripe linkage — proves the page does not need Stripe to RENDER a plan (the `--force`-style "must not call Stripe" check is: the page stays visible/functional with null stripe ids, since a client-side throw on a null id would blank the section) |
| `beforeAll` | `subAccounts/{primary}`.update({ billing: {status: "active", planId: e2e-resell-<stamp>, priceCents: 49900, billingInterval: "month", currency: "zar", ...} }) | Test 1: row for the plan shows `data-active="1"`, "1 active", MRR containing "R" and "499" (R 499.00 via `formatBillingPrice`), and the ZAR totals row contains "499" |
| Test 2 body | `subAccounts/{primary}`.update({ "billing.status": "past_due", "billing.graceUntil": now+3d }) | Row's active count drops to `data-active="0"`, "0 active", and shows "past due" (bucketed under `pastDue` via `effectiveBillingState` → "grace", since `graceUntil` is in the future) |
| `afterAll` | Restores `subAccounts/{primary}.billing` to the `priorBilling` snapshot (or `FieldValue.delete()` if it was previously absent) | Cleans the sub-account back to its pre-test state regardless of which test ran last |
| `afterAll` | `recursiveDelete` on `agencies/{agency}/plans/e2e-resell-<stamp>`, guarded by: id must start with `e2e-resell-`, and the doc's own `agencyId` field must equal `E2E_AGENCY_ID` (re-read from Firestore, not assumed) | Removes the fixture plan; refuses to delete anything that isn't the plan this run created under the fixture agency |
| `afterAll` | All three restore/delete steps run independently (errors collected, not short-circuited) and any collected error is re-thrown after all three have attempted | A failed plan-delete must not mask a failed billing-restore, and vice versa — same pattern as `reputation-overview.spec.ts` |

## What was NOT run

- The spec itself (Playwright forbidden in this worktree per the task brief).
- `firebase deploy --only firestore:rules,firestore:indexes` — no rule/index
  change; this feature reads through the existing `/api/agency/plans` route
  and the existing `subAccounts` `onSnapshot` listener already used by
  `/agency/billing`, so no new client-side Firestore access pattern was
  introduced.

## Verified in this session (no live writes)

- `pnpm exec vitest run src/lib/billing/reselling.test.ts` — 14/14 pass.
- Each of the five pure-helper guards (active-only MRR filter, annual ÷12
  normalization, archived-plan exclusion, per-currency totals never merging,
  quota `<= 0` exclusion) was mutated one at a time and confirmed to turn a
  test red — see the session transcript for the mutation commands and
  failures.
- `pnpm ci:check` (lint + tenancy check + whatsapp-rail check + `tsc
  --noEmit` + `pnpm test` [4483 tests] + `pnpm build`) — green. One flaky
  timeout on an unrelated pre-existing test
  (`src/lib/google-calendar/call-sites.test.ts`) reproduced on the first
  full run and passed in isolation and on a clean re-run of the full suite —
  known load-induced flake (see `project_crestahq_deploy_test_gate_load.md`
  in project memory), not caused by this change.
