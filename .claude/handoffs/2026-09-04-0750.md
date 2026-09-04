# Handoff — 2026-09-04 07:50 SAST

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`, private) — fork of the LeadStack Agency CRM template
**Branch:** `main` clean. Two PRs open and awaiting Hein: **#9** (code) and **#10** (docs).
**Session goal:** continue from the 06:15 handoff. Its next-actions 1 and 2 were stale, so the
session moved to Phase 1.3 instead, grilled it, and built the foundation.

Supersedes `.claude/handoffs/2026-09-04-0615.md`.

## Read this first: three corrections to the project's own record

Each of these sent me looking for work that was already done, or told me something was blocked
when it was not. PR #10 fixes all three in the docs; they are repeated here because a handoff is
read before a diff.

1. **Phase 1.1 is NOT blocked.** Hein confirmed the Paystack account is live and verified. The
   `BillingProvider` interface and `StripeBillingProvider` have also already landed, and
   `billing-service.ts` routes every call through `getBillingProvider()`. The only piece left in
   1.1 is `PaystackBillingProvider`, and it can now be proven against a real account instead of
   mocks — which removes the trap the last two handoffs flagged.
2. **Payments v1 is much further along than CLAUDE.md says.** Hosted checkout pages, order bumps,
   the `orders` collection, the per-sub-account Stripe webhook and the order reconciler all exist,
   and a card-paid invoice is marked paid automatically through the same `markQuotePaidServerSide`
   the manual button uses. PayPal.me is the only manual rail, because paypal.me has no callback.
3. **The WhatsApp live test is NOT unblocked by the Meta env vars.** `META_APP_ID` /
   `META_APP_SECRET` are set locally, but they belong to the Facebook Login app behind the inbox
   and Social Planner. The Cloud rail reads a phone number id, a WABA id and a system-user token
   from **Firestore, per sub-account** (`cloud-credentials.ts`). Setting the app vars does nothing
   for it. A live WABA is still needed and only Hein can provision it.

Also stale in the last handoff: its next-action 2 ("no settings UI for the Cloud connection") had
already shipped as PR #8 before that handoff was written.

## What got done

### Phase 1.3 grilled and locked — `docs/RECURRING_INVOICING_PLAN.md`

**The finding that shaped everything: all three recurrence arms converge on Paystack.** Stripe
does not onboard SA entities and every client sub-account is one, so the client-facing card rail
(`sub-account-client.ts`, the sub-account's own restricted key) is unusable by every real client —
and it is hard-coded to `mode: "payment"`, with no subscription surface at all. Auto-charge
therefore means Paystack, not Stripe.

So the **engine and the rail are separate builds, and only the rail is blocked.** Hein picked
generate-and-send, auto-charge and agency→sub-account; the third is just Phase 1.1, and the second
waits for the Paystack rail as a `chargeMode` on the same schedule.

Locked: auto-send by default with a per-schedule `reviewFirst` opt-out · always generate on
cadence, count `consecutiveUnpaid`, escalate to a Task past a threshold · the schedule is its own
top-level `recurringInvoices/{id}` doc minting ordinary invoices · month-end **clamps from the
stored anchor**, never rolls · no new agency gate.

### PR #9 — the send path extracted so a cron can call it

Pure refactor, no behaviour change. The route went 247 → 52 lines; everything else is
`src/lib/server/quote-send-service.ts`. Auth stays in the route. The service takes an `actor`,
either `{kind:"user", authorize}` or `{kind:"system", reason}`, so territory scoping cannot be
skipped by forgetting an argument and every unscoped send is greppable — the same reasoning the
WhatsApp seam uses for `supportsTemplates` / `enforcesWindow`.

**Quotes, invoices and orders had ZERO tests** despite a Stripe webhook already marking invoices
paid through that path. Now 27, and 395 → 422 overall.

### PR #10 — the three corrections above, docs only

Kept separate deliberately so neither review covers work it was not aimed at.

## What's next

1. **Hein reviews #9 and #10.** Neither is auto-mergeable: #9 sits on the customer-facing outbound
   send path, which the Level-3 boundary gates permanently.
2. **Build the engine on top of #9** — `recurringInvoices` types, the cadence module, the daily
   cron, the operator UI. Design is fully locked in the plan doc; the two indexes it needs are
   named there. Scratch notes with a cadence test table are in this session's scratchpad but the
   plan doc supersedes them.
3. **Phase 1.1 `PaystackBillingProvider`** — now genuinely unblocked, and verifiable.
4. **Live WABA test** for 1.2 — still gated on Hein provisioning a WABA.

## Context the next session needs

**Two constraints carried forward, both written into the plan doc:**

- **Idempotency must live on the schedule, never on invoice status.** The send path swallows a
  failed lifecycle write while the email still goes out, so an invoice can sit at `draft` with no
  `sentAt` after the customer received it. Any sweep keyed on invoice status would re-send a real
  invoice to a paying customer every night until someone noticed. Nobody may add a "re-send unsent
  invoices" pass without fixing that write first.
- **The system actor's `reason` must be logged when the cron sends.** It is currently required but
  never read. Forcing an author to write one helps at grep time; logging makes it useful at
  incident time. Deliberately deferred out of #9, which had to stay a no-behaviour-change refactor.

**Two pre-existing defects preserved on purpose in #9**, both now pinned by tests: the swallowed
lifecycle write above, and the send response echoing a stored payment link when none was minted
(a card-only invoice can hand back a URL for the wrong rail).

**Blind review earned its keep twice more.** The first review broke three guards with the whole
suite still green — the membership check, the territory argument (the mock ignored its arguments),
and the in-memory payment link. All three are one assertion each, all now fail when broken. This
is exactly the limit the last handoff recorded: **mutation testing cannot reveal a guard nobody
thought to test**, because a guard with no test cannot be mutated into failing.

**A mutation script corrupted the working tree.** It failed to restore lines, and at one point
left `quote.paymentLinkId = null` commented out in the service. Shipped, that emails customers a
paypal.me link carrying the **previous invoice's amount**. Caught by reading the tree against
`origin/main`, not by any gate — the suite was green with it broken. **Every mutation must assert
byte equality (md5) on restore.** Disclosed in #9's body.

**Non-obvious facts (new this session):**
- **Two concurrent `next build`s in ONE worktree corrupt `.next`** and produce ENOENT build-trace
  failures that look like real defects. `rm -rf .next` and re-run alone. Cost four wasted runs.
- The 300-line cap: `PARITY_PLAN.md` names the two over-cap test files as debt. Do not cite them
  to justify a third — a subagent tried, and that is how a cap dies.
- `structuredClone` in a vitest spy pins call-time values; vitest records arguments **by
  reference**, so an assertion on a later-mutated object can pass while pinning nothing.

**Still true from before:** `gh pr create`/`merge` fail with a GraphQL permissions error — use
`env -u GITHUB_TOKEN -u GH_TOKEN gh api -X POST repos/Heinvv10/CrestaHQ/pulls --input f.json`.
Node via `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`. Self-hosted runner only.

## Git state

- **Uncommitted:** clean in all worktrees.
- **Worktrees:** `/home/hein/Workspace/CrestaHQ` (main) · `CrestaHQ-wt-recurring`
  (`feat/recurring-invoicing`, PR #9) · `CrestaHQ-wt-docs` (`docs/correct-stale-status`, PR #10) ·
  `CrestaHQ-wt-snapshots` — **another session's, leave it alone**.
- **Open PRs not mine:** #5, #6 (`crestahq-c9`'s).
- Both my branches verified with `git log origin/main..HEAD` — every commit is mine.

## Where to resume

Read `docs/RECURRING_INVOICING_PLAN.md`. If #9 has merged, build the engine on top of it. If it
has not, do not stack on it — it is human-gated and may change.
