# Public API v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

A versioned REST surface under `/api/v1/*` for the sub-account-scoped resources (contacts, deals, tasks, events, form submissions) plus signed outbound webhooks. Built so an agency's clients can plug LeadStack into Zapier, Make, n8n, or custom integrations without operator hand-holding.

## Authentication + keys

- Sub-account admin mints keys from the dashboard's **API Keys** section. Keys are scoped to one sub-account and one mode (`live` or `test`). Format: `lsk_{mode}_{prefix}_{secret}`. Only the SHA-256 hash of the secret is persisted (`subAccounts/{id}/apiKeys/{keyId}.secretHash`); the raw secret is shown ONCE at creation time and never again.
- Every `/api/v1/*` request includes `Authorization: Bearer lsk_…`. The auth helper `lib/api/auth.ts::requireApiKey()`:
  1. Parses the bearer header, looks up the key by prefix + verifies the SHA-256 hash matches the stored hash.
  2. Loads the sub-account doc, checks `apiAccessEnabledByAgency === true` (returns 403 `api_access_disabled` otherwise — see Agency feature gates).
  3. Returns a `{ subAccountId, agencyId, keyId, mode }` context. Every downstream Firestore query filters by `subAccountId` so a leaked key only ever sees its own sub-account.
- **Test mode** (`lsk_test_*`) lets the buyer's clients exercise the API without firing real automations / SMS / emails — the form-submission route, for example, gates `fireTriggers()` on `ctx.mode === "live"`.

## Infrastructure modules

All under `src/lib/api/`:
- `auth.ts` — `requireApiKey()` + key hashing.
- `keys.ts` — mint / list / revoke helpers.
- `responses.ts` — uniform `{ data, error }` envelope + pagination cursors.
- `versions.ts` — version-pinning header (`x-api-version`) so future v2 doesn't break v1 callers.
- `idempotency.ts` — replay protection. POSTs accept `Idempotency-Key`; the helper stores `(key, requestHash, responseSnapshot)` on `idempotency/{subAccountId}/{key}` for 24h and replays the saved response on duplicate keys.
- `rate-limit.ts` — per-key token bucket (in-memory LRU, defaults to 60 req/min). Returns `429` with `Retry-After`.
- `redact.ts` — installs a console wrapper that masks `lsk_*` secrets in logs so a stray `console.log(req.headers)` doesn't leak a tenant key.
- `logs.ts` — append-only request log per key for debug visibility in the dashboard.
- `serializers/{contacts, deals, tasks, events}.ts` — strict wire-format mappers so internal field renames don't accidentally break API consumers.

## Contacts: the `prospecting` map

Every contact object carries `prospecting` — `null`, or `{ list_id, place_id,
website, rating, reviews_count, category, approached_at, last_report_id }`
(missing keys as `null`). `PATCH /v1/contacts/:id` accepts it and replaces
the stored map wholesale. Validation is strict: only those eight keys (any
other key is a 400 `invalid_body`), `list_id` / `place_id` / `category`
strings ≤ 200, `website` ≤ 300, `rating` a number 0–5, `reviews_count` a
non-negative integer, and `approached_at` / `last_report_id` only `null` —
LeadStack sets them. See [prospecting.md](prospecting.md).

## Workflow triggers + the enrolment cap

`POST /v1/contacts` and `PATCH /v1/contacts/:id` write through
[lib/server/contacts-service.ts](../../src/lib/server/contacts-service.ts) —
the same chokepoint the dashboard's own contact routes use — so a contact
created over the API fires `contact.created` and a tag applied over the API
fires `contact.tag.added`, exactly as the UI does. The tag diff lives in the
service and nowhere else; the v1 routes never re-implement it. Test-mode
writes fire no triggers (the `mode === "live"` gate is in the service).

Because a workflow can send WhatsApp / SMS / email to a real person, a
looping integration script would otherwise message a whole list. Each API key
therefore carries an hourly **enrolment fuse** of 50
([lib/api/enrolment-cap.ts](../../src/lib/api/enrolment-cap.ts)), counted in
hourly buckets at `subAccounts/{id}/apiEnrolments/{keyId}_{YYYY-MM-DDTHH}`
(same shape as the usage ledger).

**Reserve, then reconcile** — the gate has to be synchronous because the
spend is not. Enrolment happens inside a fire-and-forget
`fireWorkflowTrigger`, so a cap that merely READ the counter before writing
would let a back-to-back loop straight through: every request would read a
count its own enrolments hadn't incremented yet. So the route AWAITS
`reserveEnrolment`, which charges 1 in a Firestore transaction and reads the
result back atomically; if that lands past 50 the request is **refused** with
`429 workflow_enrolment_cap` plus `Retry-After`, the write is not applied,
and the reservation is handed straight back so a hammering caller keeps the
bucket pinned at the limit. Once the trigger settles,
`reconcileEnrolments` adjusts the bucket by (actual − 1) — a request that
enrolled nobody gets its reservation back, one that enrolled three ends up
charged three. Reconciliation is best-effort; a failure misstates the count
for the rest of the hour but cannot disable the fuse.

**Every reservation has exactly one owner.** That `finally` only covers
requests that actually reached the trigger, so the routes settle the rest:
the contact service reports `firedTrigger` (it owns the tag diff, and
re-deriving it in the route is what this design exists to avoid), and any
path that did NOT fire — an ordinary PATCH that changed a name, a contact
that vanished before the write, or a throw between the reservation and the
write — calls `releaseReservation`. Without that, fifty ordinary PATCHes
would 429 a key for the rest of the hour over workflows that never ran.

This is a **fuse on a runaway caller, not a hard ceiling on enrolments**:
reservations are per REQUEST, so a burst is bounded at 50 un-reconciled
requests, and each of those may enter more than one matching workflow before
its reconciliation lands. Reservation failures fail open, matching
`checkQuota` — but only on the infrastructure-error path; an over-budget
reservation always refuses.

## Upsert by phone

`POST /v1/contacts/upsert` creates or updates a contact using the phone as
its identity: two calls with the same phone, even concurrently and in
different formats (`082 123 4567`, `+27821234567`), leave one contact. Built
for integrations that push the same person repeatedly — FibreFlow's daily
Velocity export is the first caller.

- `phone` is required and normalised to E.164 with the workspace's default
  country; an unparseable phone is a 400 `invalid_phone`.
- `name`, `email`, `company`, `address`, `source`: only keys sent are written.
  `name` is required when the call creates the contact.
- `custom_fields` **merges** per key; `null` or `""` clears a key, and an
  unknown key is refused rather than dropped. Required custom fields are
  enforced only on create.
- `tags_add` / `tags_remove` apply to the contact's CURRENT tags inside the
  write transaction, so a tag an operator added a moment ago survives.
  `tags` (whole-array replace) is refused on this route, as are
  `pipeline_stage`, `territory_id` and `prospecting` (set those with PATCH) —
  refused rather than silently dropped.
- 201 created · 200 updated · **409 `ambiguous_phone`** when more than one
  contact already holds the phone — nothing is written and the ids are named.
- `Idempotency-Key` is honoured as on every v1 POST.

Race safety: the phone query runs inside the write transaction on every
call, and the transaction also reads and then writes a delete to a lock doc
per phone (`subAccounts/{id}/contactPhoneIndex/{mode}_{e164}`, never
persisted), so two concurrent calls contend and one re-runs onto the other's
contact. Because the query runs every time, a duplicate created later by
another path is still refused with 409.

**Matching is on the stored E.164 phone and `mode`.** Paths that store the
phone as typed — v1 form submissions, v1 PATCH, the bulk importer — and the
voice-booking path, which writes no `mode`, produce contacts the upsert will
not find; its first call for that person creates a second contact.

**The response answers "did the tag enrol?" itself.** When `tags_add` is sent
the route awaits the `contact.tag.added` trigger before responding — runs
written, first step handed to QStash — and returns an `enrolment` block:
`{ status: "enrolled" | "not_enrolled", reason, runs: [{ workflow_id,
run_id, status }], skipped: [{ workflow_id, reason }] }`. `reason` is null
when enrolled, else one of `test_mode`, `tag_already_present`,
`automations_paused`, `no_matching_workflow`, `filters_not_met`,
`reentry_blocked`, `run_failed`, `error`. Null when no tags were added. There
is no acknowledgement tag and nothing to poll — the GHL two-tag handshake
existed only because GHL cannot enrol synchronously. A `contact.created`
workflow still runs on a create but is not part of this answer. `status`
is `enrolled` when ANY `contact.tag.added` workflow started — a caller
waiting on one particular workflow should look for its id in `runs[]`. An
`Idempotency-Key` replay returns the original run ids.

A create fires `contact.created` and, when it adds tags, `contact.tag.added`
through the same tag diff as a PATCH. So the request reserves one enrolment
slot per trigger it can fire, before any write, and releases the unused ones.

## Merge tags in automations

`{{contact.customFields.<key>}}` resolves any operator-defined contact custom
field by its stable `key`, everywhere merge tags already work — email and SMS
bodies, notify/task titles, and WhatsApp template variables. Values were
validated against the sub-account's field definitions on write, so nothing is
re-checked at send time; an unknown or unset key renders as empty string, like
every other unresolved tag.

**Merge-tag values are untrusted, and the HTML email paths escape them.** A
contact name arrives from a public form and a custom field is free text set
over the API, so interpolating either raw into an HTML body would let a key
holder deliver a phishing anchor from the tenant's own verified sender.
`resolveMergeTags` therefore takes `{ escape: "html" }`, which escapes each
substituted VALUE (never the finished string, so markup the operator wrote in
their own template still renders). The three HTML builders — the workflow
`send_email` and `notify` executors and the broadcast step route — pass it;
plain-text bodies, subject lines, SMS and WhatsApp template variables
deliberately do not. `safeTags: ["unsubscribeLink"]` exempts the one value we
supply as real markup ourselves, which is legally required to render as a
link. This closes a hole that predates custom fields —
`{{contact.firstName}}` reached the HTML body raw as well.

## Events: status

**Booking-page events are not exposed on v1.** The events routes match an
event's `mode` against the key's, and booking-page (and voice) bookings
carry no `mode`, so `GET`/`PATCH`/`DELETE /v1/events/:id` 404 them. Every
event v1 can reach is a manual event (created via `POST /v1/events` or the
dashboard). Booking reschedules, `awaiting_payment` and mark-paid are
dashboard-only.

`PATCH /v1/events/:id` writes `title`/`contact_id`/`location`/`notes`/
`start_at`/`end_at` as plain field patches. `status` goes through
[lib/server/event-status-service.ts](../../src/lib/server/event-status-service.ts),
the same chokepoint as the dashboard's mark-status action — a raw write here
used to let an API key un-cancel an event or skip the activity row, trigger
and cancel email.

- **Transitions:** `scheduled` → `completed`/`no_show`/`cancelled`;
  `completed` ↔ `no_show` as a correction either direction; `cancelled` is
  always final. Anything else is refused with **`409`**
  `invalid_status_transition` before any field in the PATCH is written.
  A failed status write is a `500` `internal_error`.
- **Not-yet-started gate:** `completed`/`no_show` also require
  `start_at` to already be in the past — "This appointment hasn't happened
  yet." (**`409`** `invalid_status_transition`), so a raw API call can't flip
  a future booking (which would fire its workflow trigger and free the slot).
  `cancelled` never needs this. Checked against the PATCH's own `start_at`
  when the PATCH also moves it, so `{status: "completed", start_at: <past>}`
  on a currently-future event is allowed, and `{status: "completed",
  start_at: <future>}` on a currently-past event is refused.
- **Side effects** (activity row, the `booking.*` workflow trigger, and the
  visitor email on a cancel) run against the event *after* the rest of the
  PATCH is applied, so changing `contact_id` and `status` together notifies
  and enrols the new contact.
- **Test mode:** a `mode: "test"` event gets the validated status write
  only — no activity row, no trigger, no email.
- **Atomic refusal, not atomic success.** Both status checks above (the
  transition table and the not-yet-started gate) run as a pre-check against
  the POST-patch event *before any field is written*, so a refused status
  change never leaves the other fields written either. Once past that
  pre-check, the other fields are written, then the status change re-applies
  the same checks against the freshly stored event as its own chokepoint. If
  another writer changes the status in that window, the PATCH can still
  return `409` after its other fields were already written — re-`GET` the
  event and retry.

## Deals: assignee

`POST /v1/deals` accepts an optional `assigned_to_uid`: it must be an
ACTIVE member of the key's sub-account, else **`400`** `invalid_request`.
Absent or `null` creates the deal unassigned. It is read-only on
`PATCH /v1/deals/:id` (silently ignored there, like any unknown key).

## Webhooks

Outbound webhooks let the sub-account react to platform events (contact created, deal moved, event booked, …) without polling.

- Sub-account admin creates a subscription from the dashboard's **Webhooks** section: target URL + event-type allowlist + signing secret (auto-generated).
- `lib/api/webhooks/dispatch.ts::emitWebhookEvent({subAccountId, type, payload})` is the fan-out helper called from every state-changing route (contact.created, form.submission.created, event.booked, etc.). It looks up matching subscriptions for the sub-account, signs each payload (`lib/api/webhooks/signing.ts` — HMAC-SHA256 with the subscription secret), and POSTs in the background with retries on 5xx.
- Receivers verify by recomputing HMAC over the raw body using the secret they were shown at creation. Standard `Webhook-Signature` + `Webhook-Timestamp` headers; reject requests older than 5 minutes to defeat replays.
- **Assistant actions** (AI Suite, sub-account level + agency-delegated): `list_webhooks` (readonly; output includes the subscription ids), `create_webhook` (confirm-gated; creates + fires one synchronous signed test via [lib/webhooks/direct-test.ts](../../src/lib/webhooks/direct-test.ts) and reports the HTTP result, with n8n test-vs-production URL coaching), `send_webhook_test` (confirm-gated; re-fires a signed sample event at an EXISTING subscription — the chat equivalent of the Webhooks section's send-test button, for "my n8n node is listening now, test it again" loops; optional `eventType` override, refuses paused hooks), and `update_webhook_url` (confirm-gated; repoints an existing subscription at a new URL and tests the new URL immediately — `switchToN8nProduction: true` derives the `/webhook/` Production URL server-side from the stored `/webhook-test/` URL, so "activate the n8n workflow, then ask the assistant to make it live" is one confirm; auto-resumes a circuit-breaker-paused hook since the pause belonged to the old URL; events/secret/mode unchanged). All honor the `apiAccessEnabledByAgency` kill switch; test deliveries land in Logs → Webhooks like real ones.

## Operator surfaces

Three sub-account settings sections:
- **API Keys** ([components/settings/sub-account-api-keys-section.tsx](../../src/components/settings/sub-account-api-keys-section.tsx)) — mint, label, revoke; one-time secret reveal modal on create.
- **API Recipes** ([components/settings/sub-account-api-recipes-section.tsx](../../src/components/settings/sub-account-api-recipes-section.tsx)) — curated recipe library (Zapier, Make, n8n, plain cURL) wired to the live API base URL + per-key auth header so the buyer's client can copy-paste.
- **Webhooks** ([components/settings/sub-account-webhooks-section.tsx](../../src/components/settings/sub-account-webhooks-section.tsx)) — subscription CRUD + delivery log viewer (last 50 attempts, with status code + retry count).

All three render a "locked by your agency" state when `apiAccessEnabledByAgency !== true`, mirroring the email-domain section's pattern.

## Setup contract

**No new env vars.** Reuses `NEXT_PUBLIC_APP_URL` (for the docs base URL displayed in API Recipes), Firebase (key/subscription storage). The API key hash uses the same SHA-256 utility the rest of the codebase uses — no separate signing secret needed.

