# Velocity install → review pipeline (LeadStack)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md).*

**Date:** 2026-09-10 · Grilled and locked before any code was written.

FibreFlow exports yesterday's completed fibre installs into GoHighLevel every
morning, where a workflow asks the customer how the install went and routes the
answer. This moves that destination to LeadStack. GHL keeps running Velocity
until a separate cutover decision; LeadStack takes a pilot slice first.

## What exists today (GHL)

`FF_Next.js`: cron `0 9 * * *` → `scripts/cron-velocity-review-export.sh` →
`pages/api/cron/velocity-review-export.ts` → `src/modules/velocity-review/`.

Candidates are yesterday's installs across six sources (`types.ts`:
`dr_submitted`, `drops_installed`, `stock_installed`, `oes_activated`,
`pp_activated`, `olt_mismatch_created`), filtered by POPIA consent evidence and
phone-safety quarantine, deduped by a permanent `UNIQUE (dr_number, phone_e164)`.

Delivery into GHL is a **transient two-tag handshake** (`contactExport.ts`):
upsert contact by phone with install custom fields → read back → add
`velocity-review-ready`, which is what starts the GHL workflow → poll up to 30s
for the workflow to swap in `velocity-review-enrolled` → remove it. FibreFlow
never sends the WhatsApp itself.

That handshake exists **only because GHL has no "enrol this contact in this
workflow" API**. It is the source of four ledger states —
`trigger_requested`, `ambiguous`, `workflow_acknowledgement_timeout`,
`ack_cleanup_pending`.

The GHL workflow itself is Velocity's 5-branch "Installation Experience": an
experience-check template with quick-reply buttons, branching on the tap
(Installation issue / Not connected → apology template, assign, notify staff).
Since the review-gating fix of 2026-09-05 **every branch ends with the Google
review link**.

**Measured volume** (`/home/velo/logs/velocity-review-export.log`, 12 days to
2026-09-10): 15–212 contacts messaged per day, typically 100–200.

## Locked decisions

### 1. Not a cutover

GHL keeps running Velocity. LeadStack takes a pilot slice via the export's
existing `pilotLimit` (`dateWork.ts`). Cutover is a later decision with its own
evidence.

### 2. Eligibility stays in FibreFlow

Consent evidence, phone quarantine, source selection and dedupe stay where the
OneMap and Velocity data live. LeadStack never learns what a DR number is; it
receives a contact, install context, and an instruction to enrol.

This is the boundary that keeps the port a data-pipeline job rather than a
migration of the machinery that took production pain to earn (225 rows died
untriageable on 2026-08-03; the `permanent_failure:status` ledger is the fix).

### 3. One ask per install, across both destinations

Destination (`ghl` | `leadstack`) becomes a column on the existing export row,
chosen at claim time. The permanent `UNIQUE (dr_number, phone_e164)` spans both
destinations, so a customer cannot be asked twice while both rails run.

### 4. Transaction-specific **utility** template

Meta categorises a feedback request tied to a specific transaction as utility,
and a generic "rate us" as marketing. At 200/day that is the difference between
**~R900/month and ~R4,600/month**.

SA rates (recipient country + category, revised quarterly, next change
2026-10-01): marketing $0.0379, utility $0.0076, authentication $0.0076, +15%
VAT.

The template therefore names the install — address, date, DR reference, all of
which the export already carries (`ghlCustomFields.ts`). **No promotional
content**: one upsell or referral line makes it marketing regardless of the
transaction reference, and marketing templates are additionally subject to
invisible per-user frequency caps.

Draft: [velocity-review-template-draft.md](velocity-review-template-draft.md).

### 5. Review asks go on a WABA rail, never the bridge

`services/wa-agent-bridge/rails/replyonly.go` refuses outbound to any number
that has never messaged in, citing direct evidence: the same number on the same
library ran reply-only for months without incident and was banned within days of
sending cold DMs. Velocity's review targets have all never messaged in.

The bridge's rails (per-hour and per-day consumer budgets, per-contact cap,
consecutive cap, global daily cap, quiet hours, kill switch) are good, and are
not the point — reply-only is. ~R900/month does not justify risking Velocity's
WhatsApp identity.

The bridge's outbound arm (1.2b, `send-dispatch.ts:130`) stays a separate
project, for **conversational** traffic, where it is already proven. That case
gets stronger on 2026-10-01, when Meta starts charging for in-window replies
that are free today.

### 6. Yes/No buttons — and **both** branches get the review link

Withholding the link from unhappy customers is review gating, prohibited by
Google Maps UGC policy and removed from GHL on 2026-09-05
(`docs/REVIEW_GATING_FIX.md`). It is not reinstated here.

The Yes/No split earns its place by routing unhappy customers to staff, not by
deciding who may review:

- **Yes** → review link, up front.
- **No** → apology, triage, staff assignment, **then** the review link.
- **No reply / free text** → triage. (This closes a live GHL gap: that workflow
  branches on button payloads only, so a customer who types is routed nowhere.)

Legitimate levers that remain: prominence and ordering within a branch; asking
after a problem is resolved rather than before; timing; and objective
eligibility rules (incomplete install, open snag, failed QA) — written down, and
never predicted sentiment.

**Engine work this needs** (the one non-pipeline piece): quick-reply button
support on Cloud templates, and a branch on the returned button payload.
LeadStack today has neither — workflow conditions read contact fields only
(`src/types/workflows.ts:50`) and `wait_for_reply` distinguishes only replied
from timed out.

### 7. Tag trigger, synchronous result — no ack polling

FibreFlow calls **one** idempotent endpoint per candidate: upsert contact by
phone + write install custom fields + add the trigger tag, under an
`Idempotency-Key`. The response carries the enrolment outcome (run id, or the
reason it did not enrol).

The tag stays because it is what lets an operator repoint the funnel in the
workflow builder without a code change. The **ack tag and the 30s poll do
not** — LeadStack enrols synchronously (`fireWorkflowTrigger`,
`enrollForTest`), so the answer is already in the response. Four states leave
the FibreFlow ledger instead of being ported.

### 8. Per sub-account throughout

Rail (`whatsappProvider`), WABA credentials (`getWabaCreds(subAccountId)`),
Twilio config and template approval state are all already per sub-account. Each
tenant brings its own WABA under its own Business Manager — which also settles
display-name approval, since Meta approves a display name only against the
owning business.

One rail per sub-account, not per traffic class. "Cold on WABA, replies on the
bridge" inside one sub-account is out of scope.

## Gaps to build

| # | Gap | Where |
|---|---|---|
| 1 | Upsert-contact-by-phone (search + create-or-update) | `src/app/api/v1/contacts/` |
| 2 | Add/remove tags without whole-array replace | v1 contacts |
| 3 | v1 writes must fire `contact.tag.added` — today only `contacts-service.ts` does, and the v1 route bypasses it | `src/app/api/v1/contacts/[id]/route.ts:95` |
| 4 | Combined endpoint: upsert + tag + enrol, idempotent, synchronous result | new v1 route |
| 5 | Install context as contact custom fields, resolvable as template variables — merge tags resolve contact scalars only, not custom fields | `src/lib/automations/merge-tags.ts:65` |
| 6 | Quick-reply buttons on Cloud templates | `src/lib/comms/whatsapp/cloud-templates.ts` |
| 7 | Workflow branch on button payload | `src/lib/workflows/engine.ts`, `src/types/workflows.ts` |
| 8 | FibreFlow: destination column, LeadStack client, delete the ack-poll states | `FF_Next.js:src/modules/velocity-review/` |

## Long-lead items — start these first

1. **Verify Velocity Fibre's Meta Business Manager**, create the WABA, provision
   a **new dedicated number**. Meta Cloud direct. Velocity's existing GHL number
   is untouched. If Velocity has no verified BM and that is slow, Twilio is the
   faster sender to stand up; its extra per-message fee is small at this volume.
2. **Submit the draft template** and record the category Meta returns. Its
   verdict is the input to the cost question and to decision 4. If it returns
   marketing, the GHL shape is cheaper — utility experience-check first, link
   sent free-form inside the window the reply opens — and decision 6 is revisited.

**Unverified, low confidence:** whether the CrestaHQ Meta app
(1400409065548643, App Review outstanding) can send for a WABA it does not own
before App Review clears. Check before committing to the Cloud rail.

## Validation

- Template category recorded **before** any code merges.
- End-to-end on an own handset first: FibreFlow row → LeadStack enrol → template
  delivered → button tap → correct branch → **link present on both branches**.
- Pilot at ~5/day for a week. Reconcile LeadStack sends against GHL's for the
  same dates: **zero customers messaged twice**.
- Mutation-test the dedupe — force a duplicate export row, watch it refuse.
- Customer-facing send path: a human gate stands regardless of green CI.

## Known unrelated defect

The 09:00 export hard-failed on 2026-09-06 and 2026-09-08
(`ERROR: Velocity review export request failed`). Uninvestigated, pre-existing,
not caused by this work.
