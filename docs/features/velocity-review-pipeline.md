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

**Engine work this needs** (the one non-pipeline piece): template buttons, and
button taps reaching the workflow. The branch itself already exists — an
`if_else` after `wait_for_reply` can test `reply.text`. Grilled on 2026-09-11;
see [Buttons (gaps 6–7)](#buttons-gaps-67).

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

| # | Gap | Where | Status |
|---|---|---|---|
| 1 | Upsert-contact-by-phone (search + create-or-update) | `POST /api/v1/contacts/upsert` | **closed** — see below |
| 2 | Add/remove tags without whole-array replace | `tags_add` / `tags_remove` on the upsert | **closed** — see below |
| 3 | v1 writes must fire `contact.tag.added` | `src/app/api/v1/contacts/[id]/route.ts` | **closed** — see below |
| 4 | Combined endpoint: upsert + tag + enrol, idempotent, synchronous result | `POST /api/v1/contacts/upsert` → `enrolment` | **closed** — see below |
| 5 | Install context as contact custom fields, resolvable as template variables | `src/types/whatsapp-templates.ts`, template routes, builder picker | **closed** — see below |
| 5b | Refuse a template send when any variable renders empty (the template draft requires it) | `src/lib/workflows/engine.ts` `execWhatsappTemplate` | open — changes every tenant's send path, needs its own decision |
| 6 | Buttons on templates — quick-reply and URL, all three rails | template doc, `cloud-templates.ts`, `templates-api.ts`, builder | **Cloud done** (PR 2); **Twilio done** (templates PR 4a, in-session PR 4b); bridge PRs 6–7 |
| 7 | Button taps reach the workflow branch | inbound webhooks → `reply.text` | **closed** for Cloud + Twilio (build-order PR 1); bridge taps with build-order PR 7 |
| 8 | FibreFlow: destination column, LeadStack client, delete the ack-poll states | `FF_Next.js:src/modules/velocity-review/` | later session |

**Gap 3 was already fixed when this plan was written.** PR #53 (merged
2026-09-07) routed both v1 contact writes through `contacts-service.ts`, so an
API tag add fires `contact.tag.added` exactly as the dashboard does. What was
missing was proof: `route.test.ts` mocks `fireWorkflowTrigger`, so it showed
the trigger was *called*, not that anyone was *enrolled*.
`src/app/api/v1/contacts/[id]/route.enrols.test.ts` now drives the PATCH
through the real service and the real engine over an in-memory Firestore that
honours query filters (`src/test/memory-firestore.ts`), and asserts a
`workflowRuns` doc for the `contact.tag.added` workflow. Seven mutants —
removing the fire, the wrong trigger type, test mode forced on, no `enroll`,
no filter evaluation, no live-mode gate, no tag diff — all turn it red.

**Gap 5 was half done.** The resolver has rendered
`{{contact.customFields.<key>}}` since PR #53, and both WhatsApp executors
pass the contact's custom fields in. But a template *variable* could never map
to one: `isWhatsappMergeTag` allowed seven fixed contact scalars, so the
Velocity install template was refused at save, and the builder's picker had
no custom-field options anyway. Both now accept `contact.customFields.<key>`
for a key the sub-account actually defines — a typo is refused at save rather
than rendering blank into every send. The builder lists the sub-account's
contact custom fields under their own heading.
`src/lib/workflows/custom-field-template-variables.test.ts` saves the draft
template (first name, install address, install date, DR reference) through
the real create route and sends it through the real `whatsapp_template`
executor, asserting the four parameters Meta would receive. Seven mutants —
the custom-field branch removed, any key accepted, keys not passed by either
route, custom fields dropped from the send subject, the resolver blanked, the
wrong entity's fields loaded — all turn it red.

**Gaps 1 and 2** are `POST /api/v1/contacts/upsert`
([public-api.md](public-api.md#upsert-by-phone)). The phone is the identity.
The phone query runs inside the write transaction on every call, with a
never-persisted per-phone lock doc forcing concurrent calls to contend, so
calls in different phone formats still leave one contact. More than one
existing contact on a phone is refused (409), never guessed at (Hein,
2026-09-10) — including a duplicate another path creates later. Custom fields merge per key; tags go through
`tags_add` / `tags_remove` against the current tags. The trigger tag is
**add-only**: a phone that already carries it does not fire the trigger
again (Hein, 2026-09-10), so a returning customer's second install is not
asked. On its own that is only half the guarantee — a `contact.tag.added`
workflow starts on ANY new tag, so a later unrelated tag on a contact that
still carries the trigger tag re-enrols it through a `has_tag` filter. Gap 4's
per-tag trigger filter closes that.

Existing Velocity contacts imported with un-normalised phones will not match,
so the first upsert for them creates a second contact. FibreFlow's own
`UNIQUE (dr_number, phone_e164)` still stops a second message.
`src/app/api/v1/contacts/upsert/route.test.ts` drives the real `withApiAuth`,
service and engine: the same phone twice is one contact and one enrolment,
with and without an `Idempotency-Key`. Thirteen mutants all turn it red.

**Gap 4** is the same endpoint: when `tags_add` is sent, the response carries
`enrolment` — the run id the tag started, or the one reason it did not
(`tag_already_present`, `no_matching_workflow`, `filters_not_met`,
`reentry_blocked`, `run_failed`, `automations_paused`, `test_mode`, `error`),
decided before the response is written. `fireWorkflowTrigger` now returns
that outcome instead of nothing. No ack tag, no polling. Per Hein's decision
of 2026-09-10, `contact.tag.added` gained a per-tag filter (`trigger.tag`,
engine + builder): the Velocity workflow must name
`velocity-review-ready`, or any later tag on a reviewed contact would start
the review again. `apiAccessEnabledByAgency` (403) and test mode are honoured.
`src/app/api/v1/contacts/upsert/route.enrolment.test.ts` asserts from the
response alone, never awaiting the engine; nine mutants all turn it red.

**Cutover blocker, not a pilot blocker:** the per-key enrolment fuse is 50 per
hour and FibreFlow's 09:00 run sends 100–212. The pilot (~5/day) fits. Pacing
or a configurable cap is decided at cutover (Hein, 2026-09-10).

**Also before cutover — unverified on real Firestore:** the upsert's race fix
reads a per-phone lock doc and writes a *delete* to it, which is never
persisted. Whether two Admin-SDK transactions deleting a doc that never
existed actually contend (blind review put it at ~70–80%) has not been
probed; the in-memory fake assumes they do. If they don't, two concurrent
creates for one phone make two contacts and two review asks — after which
every call returns 409, so it fails loud. The pilot's sequential ~5/day
cannot hit it. Settle it with a two-transaction probe on a non-production
Firestore project; the fallback is `tx.set` on a doc keyed by a hash of
sub-account, mode and phone.

**5b is not built.** The template draft says an empty variable must refuse
the send rather than ship a blank. Today `execWhatsappTemplate` sends
whatever renders. Meta Cloud rejects an empty parameter anyway, but Twilio's
behaviour is unverified, and the change would alter every tenant's template
step, including the live Cresta campaigns. It needs a deliberate decision,
not a drive-by.

## Buttons (gaps 6–7)

Grilled with Hein on 2026-09-11. **Design concept: a button tap is a reply.**
The workflow tells Yes, No, free text and silence apart with what it already
has — `wait_for_reply` (replied / timed out) and an `if_else` on `reply.text`
(`branch-on-reply.test.ts`). No button-aware node is built.

### What exists and what does not (surveyed before the grill)

- **Works:** the wait, its no-reply path, `reply.text` conditions in the
  builder, and the 24h window rule that sends free-form inside the window
  (`send-mode.ts`).
- **Dropped today:** a button tap on every rail. `parseCloudInbound` ignores
  `type: "button"` / `"interactive"`, the Twilio route reads only `Body`, and
  the bridge has no handling — a tap resumes the run with `reply.text = ""`.
- **Missing:** buttons on the template doc, a BUTTONS component on submission
  to Meta, Twilio quick-reply / call-to-action content types, buttons in the
  builder, and any bridge template at all.

### Decisions

1. **Branch on the button's text**, through the existing `reply.text`
   condition. Meta locks button text once a template is approved, so a label
   change is a new template and a deliberate workflow edit. The payload is
   stored on the message too, so a payload match stays possible without
   re-parsing. A customer who *types* the label lands on the same branch —
   the right outcome.
2. **All three rails.** Cloud and Twilio carry buttons; so does the bridge,
   gated on a handset test (below).
3. **Buttons live on the template — on every rail.** The bridge gains
   templates: the same doc, its `registrations.bridge` approved instantly.
   On the bridge a template is a **saved message, never a way around
   reply-only** (decision 5): the Go service still refuses a cold send, and
   the builder says so.
4. **Wait 24 hours** before the no-reply path — the window a tap opens — so
   the no-reply path only fires once free-form sending has closed anyway. A
   tap arriving later goes to the inbox with an "after timeout" marker for
   staff; nothing resumes the finished run.
5. **Quick-reply and URL buttons, at most 3 per template**, so one
   definition works on every rail. Not built: list messages, call buttons,
   per-send payload overrides.
6. **The review link sits behind a URL button, sent as an in-window
   interactive message — never a paid template.** A review-link template is
   very likely MARKETING (the template draft says so). The customer's tap
   opens the window, and inside it Cloud sends a free-form `cta_url`
   interactive with no approval and no template charge; Twilio uses an
   in-session call-to-action; the bridge renders its own. Only the
   quick-reply experience check is ever submitted to Meta. If the window is
   closed when the link would go, the send **refuses** rather than falling
   back to a template.

### Gates and dependencies

- **Bridge buttons may not render.** WhatsApp is believed to have stopped
  displaying button messages from non-Business-API clients (medium
  confidence). Before any bridge button code: one test message to Hein's own
  handset. If it does not render, the bridge falls back to numbered replies
  ("Reply 1 … 2 …"), which `reply.text` already handles.
- **Bridge templates need 1.2b.** The CRM's `bridge` send arm is still a stub
  (`send-dispatch.ts:130`).
- **Twilio in-session buttons — verified 2026-09-11** against Twilio's Content
  docs (quick-reply, call-to-action, card): an unapproved Content resource may
  be sent in-session with up to **3 quick replies** or **exactly one link**
  (a phone button needs approval). Every button in a Twilio template must be
  the **same action type**, and titles are **20 characters** even on
  templates. A tap returns its text in both `Body` and `ButtonText` and the
  id in `ButtonPayload`.
- The experience check with buttons must still come back **utility** from
  Meta (submission checklist).

### Build order

| PR | Scope | Depends on |
|---|---|---|
| 1 | Tap parsing, Cloud + Twilio: the tapped button's text becomes the message body (so `reply.text`), payload stored on the message | — |
| 2 | Template buttons on Cloud: the type, BUTTONS on submission to Meta, the builder editor | — |
| 3 | In-window interactive send on Cloud — quick replies and the URL button — via `resolveWaSendMode` | 2 |
| 4a | Twilio templates with buttons: quick-reply / call-to-action Content types at submit | 2, the in-session check |
| 4b | Twilio in-session buttons: an unapproved Content resource per template, cached | 4a |
| 5 | Late-tap inbox marker | 1 |
| 6 | Bridge templates, CRM side | 1.2b |
| 7 | Bridge Go service: send buttons, parse taps | handset test |

PR 1 alone makes gap 7 work for any Cloud or Twilio template that already has
buttons. **Done:** Cloud's `type: "button"` (`button.text` / `.payload`) and
`type: "interactive"` (`button_reply.title` / `.id`), and Twilio's
`ButtonText` / `ButtonPayload`, now reach the wait as `reply.text`, with the
payload stored on the message. `src/lib/workflows/button-tap-branch.test.ts`
posts real webhooks through the real routes, conversations service and
engine, then runs the `if_else` step and asserts the branch. Every tap shape
is proven on its Yes case, because a dropped tap would also land on No.
One interaction to know: a button labelled exactly `Yes` or `Stop` counts as
an opt-in or opt-out keyword, as typed text does. "Yes, all good" does not —
the keyword check reads the first word, and "Yes," with its comma is not
"YES".

**PR 2 done:** templates carry up to 3 buttons (quick replies, then links),
edited in the builder and submitted to Meta as a `BUTTONS` component. A quick
reply starting with an opt-out word ("Cancel my booking") is refused at save,
from the same keyword list every WhatsApp inbound route now shares. A
buttoned template cannot be submitted on Twilio until PR 4 — Twilio would
approve it without its buttons.

**PR 3 done:** a `send_whatsapp` step whose template has buttons sends that
template's text WITH them inside the window, as a free Cloud interactive
message that needs no approval — reply buttons for quick replies, `cta_url`
for a single link (`lib/comms/whatsapp/interactive.ts`). Outside the window it
sends the template only if approved, else refuses; it never falls back to a
paid template for the review link. Meta's in-window rules are narrower than a
template's — labels at most **20** characters, one link per message, reply
buttons and a link never together — and a template outside them is refused
IN-WINDOW rather than sent stripped; outside the window an approved one
still goes as itself, whatever its buttons. The dispatcher makes that call
once it knows the window. Twilio and the bridge refuse a button template
in-window until PRs 4 and 6–7. The step's template picker now offers unapproved button
templates, marked "in-window only".

**PR 4b done:** on Twilio the same step sends a template's buttons in-session
as an unapproved Content resource — Twilio sends buttons only by ContentSid.
One resource per template, created on first in-window use and cached on the
doc (`twilioSessionContent`), keyed by a fingerprint of the Twilio account,
body, language, samples and buttons, so an edited draft or a moved account
gets a new one; each send passes the contact's values as `contentVariables`.
A resource deleted in the Twilio console is not detected — sends fail until
the template is edited. An in-window button send with a **blank variable is
refused** on both rails: Cloud would send "Thank you !", and Twilio may fill
in the template's sample value — a stranger's name
(`lib/comms/whatsapp/twilio-session-content.ts`). Twilio's unapproved
in-session limits match the Cloud in-window rules, so the same check guards
both. Only the bridge still refuses in-window buttons.

Each PR: provider-documented payload fixtures, mutation-tested,
blind review, `pnpm ci:check`. The pilot's end-to-end (own handset, tap Yes
and No, link on both branches) stays a human gate.

## What the FibreFlow client (gap 8) must do

The `enrolment` block is exact about what happened, but three things in it
are the caller's to handle (blind review of #68):

1. **Match the workflow, not just the status.** `status: "enrolled"` means
   *some* `contact.tag.added` workflow started. If the sub-account ever has a
   second, untagged one, `enrolled` can come back while the review workflow
   sat in `skipped[]`. Record a review ask as sent only when `runs[]` holds
   the review workflow's id with `status: "running"`.
2. **Always send an `Idempotency-Key`** (e.g. `{dr_number}:{phone_e164}`).
   A replay within 24h returns the original answer, run ids included. A
   retry WITHOUT the key after `run_failed` answers `tag_already_present`,
   because the tag is already on the contact. That reads like success, but it
   is a review ask that never happened. Treat `run_failed` as a
   permanent failure for a human, not something to retry blind.
3. **Give the call a generous timeout.** The response waits for the first
   step to be handed to QStash, whose client has no timeout of its own and
   retries with backoff. If FibreFlow gives up first there is no double
   send — the tag was committed first — but the answer can be lost: a keyed
   retry after the first call finished gets the original answer from the
   cache, while one that arrives while it is still running gets
   `tag_already_present`.

Also `tag_already_present` is reported only when the trigger tag was
*already* there. Sending an extra new tag alongside it produces
`no_matching_workflow` instead, so send the trigger tag alone.

## Before a pilot send is possible

The receiving surface (gaps 1–5) is built. None of the remaining items is
LeadStack API work:

- **Gaps 6–7** — buttons and taps; planned in [Buttons](#buttons-gaps-67).
  Without PRs 1–3 there the funnel can send the experience check but cannot
  route the answer or send the tidy link.
- **Gap 8** — FibreFlow: destination column, the LeadStack client above,
  and deleting the four ack-poll ledger states.
- **Long-lead, human** — Velocity's Meta Business Manager verification, a
  WABA and dedicated number, display-name approval, the template submitted
  and its category recorded (below).
- **Operator setup in the Velocity sub-account** — contact custom fields
  `install_address`, `install_date`, `dr_number`; the template mapped to
  them; a workflow on `contact.tag.added` with **trigger tag set to
  `velocity-review-ready`** and the review steps; an API key with the
  agency's API access switched on. The experience-check template carries the
  two quick replies, "Yes, all good" and "No, there's a problem", and the
  workflow's `if_else` tests `reply.text` equals "Yes, all good". The
  experience check must be a **`whatsapp_template` step** (always sends the
  template), so it goes out the same way whether or not the customer has
  messaged recently.
- **The review link** is a template that is never submitted: body text plus
  ONE link button ("Leave a review" → the Google review URL). Both the Yes and
  the No branch send it with a `send_whatsapp` step — inside the window the
  tap opened, so it goes free as an interactive message. Keep its label to 20
  characters.
- **The sub-account's WhatsApp AI agent must be OFF.** The AI auto-reply does
  not know a contact is waiting in a workflow, so it would answer a tap —
  "Yes, all good" — alongside the workflow's own message. (Pre-existing for
  typed replies too; noticed while reviewing buttons PR 1.)
- **Gap 5b** (optional) — refuse a template send with an empty variable.
- **The first send is a human gate** — own handset first, per Validation.

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
