# W2 · Service desk: tickets on conversation threads

*Part of the [CRM gap programme](README.md) (Service desk table; decision 4: tickets layer on Conversations threads).*

**Goal:** a Blitz support agent turns a WhatsApp thread into a ticket, sets status, priority, owner and
category, works a queue that shows each ticket's age, and closes it. At close, and only when the
operator ticks it for that close, the contact gets the tag that starts the Post-Resolution review flow.

**Status:** phase 1 (this doc). No code. Phase 2 starts when Lane C's audit PR1 is on `main` (it is:
`src/lib/audit/record.ts`) **and** the WA-media PRs that own `conversation-thread.tsx` and the composer
have merged.

## Settled by Hein (2026-09-21)

1. **Blitz support staff pilot as collaborators.** There is no support-agent role first. The role below
   stays a Later spec.
2. **Import the 86 GHL Service Issues.** The 7 Resolved become closed tickets, with no tag and no
   messages. The other 79 become open tickets in an *Imported, needs triage* view, exempt from SLA. A dry
   run comes first. The production write happens only on Hein's go. The export is dated **2026-08-09**,
   so issues raised in GHL after that date are not in it.
3. **Age-only SLA for the pilot.** Nothing escalates until Hein sets Blitz's business hours and targets.

Every other decision below was made conservatively, without an interactive grill, and names the
alternative it rejected.

## Data model

### `tickets/{ticketId}`: a top-level collection, server-written only

| Field | Meaning |
|---|---|
| `agencyId`, `subAccountId`, `createdByUid` | Tenancy keys. `createdByUid` is the operator's uid, or `null` for an import |
| `territoryId` | The contact's territory. It is set at create and re-stamped in the same transaction as every contact territory move (see [Territory](#territory)) |
| `conversationId`, `contactId` | Always equal. Tickets exist only on contact-keyed threads (see decision 3) |
| `subject` | Optional free text, ≤120 chars. Redacted in audit |
| `status` | `open` · `waiting_customer` · `waiting_third_party` · `closed` |
| `priority` | `urgent` · `high` · `normal` (default) · `low` |
| `categoryId` | One of the sub-account's category ids (enum-shaped, e.g. `no_connectivity`), default `general` |
| `ownerUid` | An active member, or `null`. Defaults at creation to the contact owner (`assignedToUid`) |
| `source` | `app` · `import` |
| `openedAt`, `firstResponseAt`, `closedAt`, `reopenedAt` | Timestamps from the injected clock (see [SLA](#sla-clock)) |
| `closedBy` | `user` · `merge` (see [Contact link, merge and delete](#contact-link-merge-and-delete)) |
| `resolvedTag` | `not_requested` · `pending` · `applied` · `already_tagged` · `refused` · `failed` (see [Close](#close--issue-resolved)) |
| `sla` | `{ exempt, activeMs, runningSince, firstResponseDueAt, resolutionDueAt, escalated: { firstResponse, resolution } }` |
| `ghlOpportunityId` | Import only. The import's doc id is `ghl_<id>`, which makes a rerun idempotent |

### On the conversation: `openTicketId: string | null`, a cache

`openTicketId` exists so the inbox row and thread header can show a ticket badge without a query. It is
**not** the source of truth, and it is not in the conversation rule's client-writable keys.

### Decisions

1. **A separate ticket doc, not fields on the conversation.** A thread outlives its issues: a Blitz
   customer reports a second fault after the first is fixed, and that fault needs its own clock, owner
   and close. *Rejected:* ticket fields on `conversations/{id}`. That loses every closed issue, and every
   message path writes the conversation doc.
2. **Top-level, not `conversations/{id}/tickets`.** The queue and the escalation job both need
   cross-thread queries. The collection follows `auditEvents` and `dealStageHistory`. *Rejected:* a
   subcollection. It needs collection-group queries and indexes, and it is orphaned when a conversation
   is deleted.
3. **Tickets exist only on contact-keyed threads.** The close writes a tag on the contact, and web-chat
   conversation ids are session keys (`web_{sessionId}`), not contact ids. *Rejected:* web-chat tickets
   in W2. That is Later, with the trigger "a tenant answers support over web chat".
4. **At most one open ticket per thread, enforced by a query inside the transaction.** Create and
   reopen run `tx.get(tickets where conversationId == X and status in [open, waiting_customer,
   waiting_third_party])` and refuse with 409 when it returns a row. The merge repoint never refuses:
   it closes the stub's ticket instead (see [Contact link, merge and delete](#contact-link-merge-and-delete)).
   Create also runs `tx.get(conversationRef)` and `tx.get(contactRef)`. That puts a concurrent create on
   a known document, so the conflict is deterministic. It also means a concurrent territory move
   conflicts, so the ticket is never stamped with a stale territory. The transaction
   writes `openTicketId` as a cache. A close clears the cache **only if it still equals this ticket's
   id**. The Blitz export fits this model: 86 issues on 86 distinct contacts. *Rejected:* the pointer as
   the source of truth, because any path that forgets to clear it wedges the thread. *Rejected:* several
   open tickets per thread, which is merge/split, a Later item.
5. **Clients never write `tickets`.** Every change goes through a route that emits an audit event.
   *Rejected:* client-writable status, as conversations have for `status` and `starred`.
6. **The ticket owner is separate from the contact owner.** *Rejected:* reusing `contact.assignedToUid`.
   Handing a fault to a support agent would silently change who owns the customer for sales.
7. **No per-sub-account ticket numbers.** The UI shows the first 6 characters of the doc id.
   *Rejected:* a counter doc, which is a contended write for a label nothing customer-facing uses.
8. **Categories are a fixed list per sub-account, with enum-shaped ids.** Audit stores them unredacted.
   *Rejected:* free-text categories.

## Statuses

```
            create                 operator / macro
  (none) ─────────▶ open ◀────────────────────▶ waiting_customer
                     ▲  │ ◀── inbound message ──┘
                     │  │
          operator   │  └──────────────────────▶ waiting_third_party   (operator / macro, both ways)
                     │                                   │
          reopen     │   close: operator only            ▼
                     └──────────────────────────────  closed
```

- An inbound message on a `waiting_customer` ticket moves it to `open`.
- An inbound message on a `closed` ticket does nothing apart from the usual unread count. A "thanks!"
  must not reopen a ticket.
- Reopen passes the same one-open-ticket check as create.
- *Rejected:* a `resolved` status before `closed`, and a `new` status. "Not picked up" is
  `ownerUid == null`, and "not answered" is `firstResponseAt == null`.

## Territory

A ticket is visible exactly where its contact is.

- **Route guard.** Every ticket route (create, read, update, status, close, reopen) runs
  `requireTicketAccess`. It checks, in order: the sub-account membership (as `requireContactAccessible`
  does), the agency gate, then `territoryGate(access, ticket.territoryId)` from
  `src/lib/auth/territory-filter.ts`. Create uses `territoryGateForContact`. Those helpers return 403
  (`DENIAL_STATUS`), and `requireTicketAccess` **remaps a territory denial to 404**, so the response does
  not reveal that the ticket exists. `requireContactAccessible`
  on its own checks no territory, which is why it is not enough.
- **Moves re-stamp in the same transaction.** Both contact territory-move paths gain a tickets query in
  the transaction they already run for conversations: `updateContactServerSide` in
  `contacts-service.ts`, and `sub-accounts/[id]/contacts/[contactId]/territory/route.ts`. *Rejected:*
  refreshing on the next ticket write, which leaves a moved contact's ticket readable in the old
  territory.
- **Rules:** `tickets` read = `canSeeScopedDoc(subAccountId, agencyId, territoryId)`, write = `false`.
- **Queue queries** for a territory-scoped collaborator add the `territoryId in` constraint from
  `territoryQueryPlan()` (`src/lib/firestore/territory-query.ts`), and the `empty` plan returns no rows.
  Firestore rules are not filters, so an unfiltered query from a scoped user is refused outright.

## Contact link, merge and delete

- **Link/merge** (`api/contacts/[id]/link`, `mergeConversation`): in one transaction, repoint the stub's
  tickets to the target (`conversationId`, `contactId`, `territoryId` from the target). If both sides
  have an open ticket, the stub's ticket is closed with `closedBy: merge`, with no tag, and the target's
  stays open. The target's `openTicketId` is then recomputed from the query and never copied from the
  stub, because `...sc` in the adopt branch would otherwise carry the stub's pointer across.
- **Contact delete** has two paths, and PR1 covers both:
  - the dashboard path (`contact-delete.ts`, `findContactBlockers`): an open ticket is a **blocker**, as
    the other blockers there are. Closed tickets are deleted with the contact, and each deletion writes a
    `ticket.deleted` audit event.
  - **`DELETE /api/v1/contacts/[id]`**, which does not use `findContactBlockers`. It unlinks and
    cascades on its own, then calls `recursiveDelete`. PR1 adds the same open-ticket refusal (409) there,
    and the same closed-ticket delete with `ticket.deleted` (actor `api_key`). Without that change, a v1
    delete would leave the contact's tickets orphaned.
  - *Rejected:* cascading open tickets, which silently discards live support work.
- **Sub-account delete** (`deleteSubAccountForAgency`) is an emptiness guard: it refuses while any
  `USAGE_COLLECTIONS` query (`src/lib/agency/sub-account-delete-guard.ts`) finds a doc. PR1 adds `tickets` to `USAGE_COLLECTIONS` as a **blocker**, so a
  sub-account with tickets cannot be deleted. It does not add tickets to a clean-up.

## SLA clock

**Pilot (settled 3):** there are no hours and no targets. The queue shows **calendar age**, labelled as
such, and nothing escalates. What follows applies once a tenant saves hours and targets.

**Business hours:** the sub-account's existing `timezone`, a weekly schedule, and a holiday list,
entered per tenant. No holiday calendar ships, because this is a white-label template. One pure module,
`src/lib/service-desk/business-hours.ts`, provides `businessMsBetween(a, b, cal)` and
`addBusinessMs(a, ms, cal)` on `Intl`. **The settings route rejects a schedule with zero open minutes a
week**, and `addBusinessMs` throws after a bounded 400-day scan rather than looping.

**Every ticket service takes an injected `now()`.** Timestamps and ages are computed from it. A test
never sleeps, and a test never reads the wall clock.

| Clock | Starts | Pauses | Stops |
|---|---|---|---|
| First response | `openedAt` | never | the first human reply **after `openedAt`** (see [Message hooks](#message-hooks)). A reply sent before the ticket existed does not count: the ticket measures from when it was raised |
| Resolution | `openedAt` | in `waiting_customer` and `waiting_third_party` | `closed`. Reopen resumes the accumulated time |

**One rule for due times:** a due time is set only while that clock is running and a target exists.
Otherwise it is `null`. Concretely:

- `firstResponseDueAt` = `addBusinessMs(openedAt, target)`, set to `null` once `firstResponseAt` is
  stamped, when the ticket closes, when it is `exempt`, and when no target exists. Pausing does not touch
  it.
- `resolutionDueAt` = `addBusinessMs(runningSince, target − activeMs)`, set to `null` while paused,
  closed or exempt, and when no target exists.
- **Recomputed** on every status transition, every priority change, reopen, and a settings save. A
  settings save recomputes each non-closed ticket **in its own transaction**, which re-reads the ticket,
  so it cannot overwrite a status change that races it. *Rejected:* a blind batch.
- **Reopen** resets `escalated.resolution` to `false`. `escalated.firstResponse` is kept, because the
  first response already happened or already breached.

**Escalation** is PR5, built only when Hein sets targets for a tenant. A QStash schedule runs every 15
minutes and queries `sla.resolutionDueAt <= now and sla.escalated.resolution == false`, and the
first-response equivalent. No status filter is needed, because every non-running state has a `null` due
time, which an inequality never matches. For each result it creates one task through
`createTaskServerSide` and sets the escalated flag in the same transaction. The task goes to the owner,
or to the sub-account's admins when there is no owner. **That task emits `task.created` to the tenant's
webhook subscribers**, as every other task does. That is a tenant-configured integration, not a customer
message, and the PR body states it. The actor is `cron`.

- **Due times are stored, not computed per run.** *Rejected:* scanning every open ticket per run. The
  QStash cap was hit once already.
- **Bot replies are not a first response.** *Rejected:* counting the AI agent's reply, which would meet
  every SLA at once.

## Message hooks

After the conversation write commits, a best-effort `onTicketThreadMessage` runs when the thread has an
open ticket. It is never inside the message transaction, so it cannot break a send or a receive.

- **Inbound** on `waiting_customer` → `open`, and the resolution clock resumes. Audit actor `system`.
- **Human outbound** with `firstResponseAt == null` → stamp it and null `firstResponseDueAt`. "Human"
  means:
  - on the non-email rails, `pauseBot: true`, the flag the operator send routes already set.
  - on email, **`sentByUid` is set**, which only the composer's SMTP send path provides.
    `email-conversations.ts` stores mailbox-synced mail as `createdByUid: "system:mailbox"` with
    `sentByUid: null`. Sent-folder mail synced from the mailbox (out-of-office replies, mail-client rules,
    anything sent outside LeadStack) therefore **does not stamp `firstResponseAt`**. *Rejected:* counting
    synced Sent mail, because an auto-reply would then meet the SLA.

**Call sites:** `upsertConversationForMessage` (SMS, WhatsApp, Meta, web chat) **and
`email-conversations.ts`**, which writes the conversation itself (~line 248) and bypasses the upsert.
PR2 adds the hook there for inbound (IMAP sync) and outbound (only the composer's SMTP send counts as
human; see above). *Rejected:* declaring email out of scope. Blitz and Velocity
customers email in, and a ticket on an email thread would silently never record a response.

A failed hook is logged (`[tickets] thread hook failed …`), not retried. The ticket stays in
`waiting_customer`, or keeps an unstamped first response. Both are visible and neither sends anything.

## Queue views

A **Tickets** tab joins the Conversations tab strip, at `/sa/[id]/conversations/tickets`. It is a
full-width data surface, as Snippets is. A row opens the thread with the ticket panel in its header.

| View | Filter (client-side over the loaded set) |
|---|---|
| Unassigned (default) | not closed, no owner |
| Mine | not closed, owner is me |
| All open | `open` |
| Waiting | `waiting_customer` · `waiting_third_party` |
| Breaching | a due time within 1 business hour or past. Empty in the pilot |
| Imported, needs triage | `source == import`, not closed |
| Closed | last 30 days, paged by `closedAt` |

There is one live query for non-closed tickets, plus a paged closed query. Each exists in two shapes:
an unscoped one, and one for scoped users with `territoryId in`. **Indexes:** `(subAccountId, status)`,
`(subAccountId, territoryId, status)`, `(subAccountId, closedAt desc)`,
`(subAccountId, territoryId, closedAt desc)`, `(conversationId, status)` for the one-open check, and
PR5's `(sla.escalated.resolution, sla.resolutionDueAt)` and its first-response twin.

*Rejected:* one indexed query per view, which means more indexes and more manual deploys. *Rejected:* a
separate Service Desk nav area, which would compete with the inbox for the same staff (programme decision
4).

## Permissions

Everything sits behind a new agency gate, **`serviceDeskEnabledByAgency`** (default `false`, with all five
steps of [feature-gates.md](../architecture/feature-gates.md)).

| Actor | Read | Create / change status / edit | Close (with or without the tag) | Settings |
|---|---|---|---|---|
| Agency owner, sub-account admin | yes | yes | yes | yes |
| Collaborator (the Blitz pilot) | within territory | within territory | within territory | no |
| API key | — | — | — | — |
| Macro (snippet) | — | status to `open` / `waiting_*` only | **never** | — |
| Import script | — | creates `source: import` | closes the 7 Resolved only, **never tags** | — |
| AI agent | — | — (AI triage is Later, below) | **never** | — |

Settings live on the sub-account doc in a `serviceDesk` map, written by an admin route. A rules test that
a client cannot write that key is **regression-only**: the existing sub-account rule already refuses it,
so no PR1 code change can turn it red.

### Support agent role (Later, spec only)

The trigger is a support-desk member who must not see billing or deals. Hein settled that Blitz pilots
without it.

| Area | Support agent |
|---|---|
| Conversations, contacts (read, notes, tags), tickets, tasks, snippets | full, within territory |
| Contact delete, export, bulk actions | no |
| Deals, pipelines, quotes, invoices, products, payments, Client Billing | no, not even read |
| Workflows, AI config, settings, members, integrations | no |

### AI triage (Later)

This covers AI setting priority and category behind a `serviceDeskAiTriageEnabledByAgency` gate, with
an `ai_agent` audit row, and never status, owner or close. **Trigger:** the Blitz pilot has run 30 days
and operators name manual categorising as a bottleneck. Opening tickets from inbound messages is a
separate Later item, triggered when operators open more than half of their tickets from threads the AI
had already flagged.

## Audit events

Events go through `recordAuditEvent` after the write commits ([audit-events.md](../architecture/audit-events.md)),
one per state change.

| Action | When | `changes` |
|---|---|---|
| `ticket.created` | create, import | `status`, `priority`, `categoryId`, `ownerUid`, `source` |
| `ticket.updated` | priority, category, owner or subject | changed fields only. `subject` is always `[redacted]` |
| `ticket.status_changed` | every transition, including close, reopen and merge-close | `status`. On close it also records `resolvedTag` (enum) and `closedBy` |
| `ticket.deleted` | cascade with a contact delete | `status` |
| `ticket.escalated` | PR5 | `kind` |
| `service_desk.settings_updated` | settings save | enum-shaped fields and targets |

**Contract additions this needs from Lane C** (in `src/lib/audit/types.ts`, raised with Lane C rather
than edited here):

- a `system` actor type, for the inbound hook and the import.
- **staff uids stored unredacted** in fields ending `Uid` that match `[A-Za-z0-9]{20,128}`. Without it,
  `ownerUid` changes store `[redacted]` and the audit cannot say who a ticket moved to.

## Close → `issue-resolved`

**The state of the drafts, as read from production by the orchestrating session on 2026-09-21 (not
re-read by this lane):** the four Post-Resolution-family drafts (Blitz PE, Blitz PTA, Blitz
Post-Resolution, Velocity Post-Resolution) were patched to `trigger.tag` = their filter tag and
`reentry: once_ever`. All four are **still drafts**, so a tag written today starts nothing. Nothing
writes `issue-resolved` since GHL's "Service Issue Resolved - tag" flow stopped. The ticket close is
the intended writer, and it is opt-in on every close.

**Two engine facts the close has to account for** (`src/lib/workflows/engine.ts`, checked on `main`):

- A `contact.tag.added` workflow **without `trigger.tag` starts on any newly added tag** (~line 1255), so
  `issue-resolved` would enrol a contact in every such active workflow whose filters it passes.
- `reentryAllows` **fails open** (~line 1321). If its `workflowRuns` read throws, it allows enrolment, so
  `once_ever` is not a hard guarantee against asking a customer twice. The fix belongs to the engine, not
  W2 (see [Open items](#open-items)).

**Dialog.** When `serviceDesk.resolvedTag` is `null`, the checkbox is not rendered. When it is set:

- The checkbox *"Tag contact `issue-resolved`"* is **unchecked every time the dialog opens**.
- Under it, the dialog lists every **active** workflow that `issue-resolved` would start: those with
  `trigger.tag == resolvedTag` and those with **no `trigger.tag`**. Each is marked with whether it sends
  to the customer.
- **When any active `contact.tag.added` workflow on the sub-account has no `trigger.tag`, the checkbox
  is disabled** and names those workflows: *"Set a trigger tag on these workflows before tagging from a
  close."* *Rejected:* listing them and allowing the tag anyway. An untargeted workflow's reach depends on
  its filters, which the operator cannot judge from a close dialog.
- When the contact already carries the tag, the dialog says *"Already tagged — no workflow will start"*,
  because `fireTagsAdded` fires only on a newly added tag.

**Server: `POST /api/tickets/[id]/close { applyResolvedTag: boolean }`.** The field is required, so a
missing value is a 400. The steps run in this order:

1. **Transaction:** re-read the ticket. When it is not open, return 409 and write nothing: a retried
   request or a double click can never tag. Set it `closed` and null both due times. Clear the
   conversation's `openTicketId` only if it equals this id. Set `resolvedTag` to `not_requested`, or to
   `pending` when the tag was requested.
2. **Audit** `ticket.status_changed`.
3. **Only when requested:** re-check the untargeted-workflow refusal on the server, and set `refused`
   when it trips. Otherwise write the tag through `updateContactServerSide`, so `fireTagsAdded` fires
   `contact.tag.added` in live mode exactly as a manual tag does. Record `applied` or `already_tagged`.
4. **When step 3 throws**, the ticket stays closed, `resolvedTag` becomes `failed`, the route returns 200
   with `tagError`, and the panel says *"Ticket closed — tag not applied"*. The operator can add the tag
   from the contact page. There is no automatic retry.

- **Close before tag, not tag before close.** *Rejected:* tag first. If the close then failed, a review
  ask would go out for a ticket still open. A closed ticket with a visible `failed` is recoverable by
  hand.
- **Write the tag, don't enrol directly.** The tenant's workflow decides what "resolved" does, and
  `reentry` applies. *Rejected:* calling the engine from the close.
- **Opt-in per close, default off.** *Rejected:* a per-tenant "always tag" setting.
- **Never tags from:** a macro, the import, a merge-close, the escalation job, a reopen, or AI.

## Migration of Blitz's 86 GHL Service Issues

`scripts/import-ghl-service-issues.ts`, modelled on the V1 WhatsApp backfill (`ghl-wa-backfill*`).

The source is `~/Workspace/ApexSignal/ghl-export-data/blitz-fibre/opportunities.ndjson` plus
`config/pipelines.json`, dated 2026-08-09, keeping the *Service Issues* pipeline rows. Counts, read
2026-09-21: New Issue 76, Resolved 7, Awaiting ISP / Network 2, Diagnosing 1, Site Visit Scheduled 0.
All 86 are open in GHL, one per contact, and none is assigned.

- **Mapping (settled 2):** Resolved → `closed` (`closedBy: user`, `resolvedTag: not_requested`,
  `closedAt` = GHL `lastStageChangeAt`). The rest → `open`, with `sla.exempt: true` and
  `categoryId: imported`, and the GHL stage name kept as `subject`. `openedAt` = GHL `createdAt`.
- **Contacts** resolve through the GHL import's contact mapping, with phone as a fallback. The script
  never creates a contact or a conversation. A row with no match or no conversation is reported and
  skipped.
- **Dry run (the default) reports counts only:** per stage and target status, matched by mapping or by
  phone, unmatched, no conversation, and already has an open ticket. No names, numbers or bodies.
- **Write** (after Hein approves the dry-run count): `--write --confirm <n>`, as V1 did.
  Deterministic `ghl_<oppId>` ids, and the same one-open check per thread. One `ticket.created` event
  per row (and a `status_changed` for the 7), actor `system:import.ghl`. **No tag, no workflow trigger
  and no message**: tickets are written through the ticket service's import entry, which has no tag
  path.

## Rollback

| Lever | Effect |
|---|---|
| `serviceDeskEnabledByAgency` off | Routes return 403 and the tab, panel and hooks go quiet. Tickets are kept |
| Revert a PR | Everything is additive: a new collection, a nullable cache field, a settings map |
| PR5 | Delete the QStash schedule **before** reverting |
| Tags a close wrote | They stay. A sent review ask cannot be unsent, which is why the tag is opt-in, disabled next to untargeted workflows, and applied only after the close commits |
| Import write | Delete `source == import` tickets with the `ghl_` prefix, then recompute `openTicketId` on those threads |

## PR slices

Each guarantee has a test that goes red when the guarded code is deliberately broken, and the PR body
shows the red run (memory: `feedback_mutation_test_every_guard`). Tests drive the real route or service
seam (`feedback_test_the_seam_not_the_helper`).

**Concurrency tests run on real Firestore, not the in-memory fake,** because the fake does not serialise
transactions. The Firestore emulator needs Java, which neither velo-server nor the CI runner has
([audit-events.md](../architecture/audit-events.md) decision 8). These tests therefore run against the
E2E fixture sub-account on the real project, as the E2E suite already does. Installing Java and the
emulator on the runner is the alternative, and it is a CI change for Hein to approve.

A race on real Firestore passes by luck unless the test forces the interleaving, so it does:

- **A test-only barrier.** The ticket service takes an optional `afterRead` hook, which is `undefined` in
  production. The test passes a barrier that holds both creates until both transactions have read. Both
  then write, and one must retry and get 409. Moving the query out of the transaction makes both writes
  succeed, so the mutation is reliably red.
- **A known conflict document.** The create transaction reads the conversation doc (decision 4), so the
  two creates always contend on that document.
- **Fixture-only.** The test hard-refuses any `subAccountId` other than the E2E fixture's, and it checks
  this before any write.
- **A guarded teardown.** Teardown deletes only tickets carrying the test's own run marker, and it
  re-checks the fixture id itself. A teardown runs even when setup threw (memory:
  `feedback_playwright_teardown_runs_after_setup_throws`), so the teardown cannot rely on setup's checks.

PR5's "two runs make one task" test needs the same barrier when it is built.

| PR | Scope | Guarantee → the test that must go red |
|---|---|---|
| **1** | Gate, ticket service and routes (create, update, status, close, reopen), settings route, business-hours module, rules, territory guard and both move paths, link/merge and delete handling, audit actions. No UI | • **One open per thread** (real Firestore, barrier-forced, fixture-only): two concurrent creates give one 201 and one 409. Red if the query moves out of the transaction. A stale `openTicketId` pointing at a closed ticket does not block a create. Red if the pointer is trusted · • **Territory**: an out-of-territory collaborator gets **404 on create, read, update, status, close and reopen**. Red if `territoryGate` is removed from `requireTicketAccess` · • **Territory move**: through each of the two move paths, the ticket's `territoryId` changes in the same commit. Red if either path's tickets query is removed · • **Merge**: a stub's open ticket moves to the target, and with two open tickets the stub's closes as `merge` with no tag · • **Delete**: an open ticket blocks a contact delete through **both** the dashboard path and v1 `DELETE`, and a closed ticket is deleted with a `ticket.deleted` event. Red if the v1 check is removed. `tickets` blocks a sub-account delete · • **Close**: `applyResolvedTag: false` leaves `contact.tags` unchanged and fires nothing. Red if the default flips. A missing field gives 400. `true` tags and fires once. An active untargeted `contact.tag.added` workflow gives `refused` and no tag. Red if the check is removed. A second close gives 409 with no tag. A throwing tag write leaves the ticket closed with `failed`. Close clears the pointer only when it matches · • **Audit**: one event per route call. Red if any is removed · • **SLA** (injected clock): the due-time rule for each state, recompute on priority change, settings save and reopen, a reopen that resets `escalated.resolution`, the zero-hours schedule refused, and `businessMsBetween` across overnight, weekend, holiday and a DST day in `America/New_York` |
| **2** | Message hooks in `upsertConversationForMessage` and `email-conversations.ts` | Through each real writer: a human reply after `openedAt` stamps the response. A bot reply, a reply before `openedAt`, and a mailbox-synced Sent email with no `sentByUid` do not. Red if the `pauseBot` check, the `sentByUid` check or the `openedAt` comparison is dropped. (An internal note never reaches either writer, so it has no test here.) Inbound on `waiting_customer` gives `open`. Inbound on `closed` does nothing. A throwing hook still leaves the message written |
| **3** | Thread panel and close dialog (after the WA-media PRs merge) | E2E: create a ticket, edit it, and close with the box unticked, leaving the tags unchanged. With an active untargeted workflow seeded, the checkbox is disabled and names it |
| **4** | Tickets tab, views, calendar age, and indexes | E2E: Unassigned → assign → Mine. A scoped collaborator sees only in-territory tickets, and the query does not fail with permission-denied. Red if the `territoryId in` constraint is dropped |
| **5** | Escalation (only when Hein sets targets) | Two barrier-forced concurrent runs over one overdue ticket make one task. Red if the flag is not in the same transaction. A null due time is never escalated. `task.created` is emitted once |
| **6** | Import script, dry run | On a fixture export: the counts per bucket, and zero writes without `--write`, checked with a DB double that throws on write. Red if the dry-run path writes. With `--write --confirm` of the wrong number, it refuses |
| **7** | Macros: a snippet may set status (`open` / `waiting_*`) after send | A macro status of `closed` is refused. Red if the enum allows it. A thread with no open ticket gets no change |

Dropped from the first draft as vacuous: "the script has no `--write` flag", which asserts an absence
and cannot go red under a code break, and "`businessMsBetween` and `addBusinessMs` are exact inverses",
which is false across closed hours. The rules test on `conversation.openTicketId` is kept only as a
regression guard. Mutation proof for it is to add the key to the rule's allowed list.

PR3 and PR4 wait for the WA-media PRs. PR1 changes rules, and PR1 and PR4 change indexes: these are
manual deploys, a union of every open branch, never chained with the check, and only on Hein's go.

## Proof of done (phase 2)

On #1000: a thread becomes a ticket, sits in the queue with a live age, and closes with the tag box
shown and left unticked. There is one audit row per change. The Blitz pilot follows once Blitz has a
sendable channel (programme gate G1).

## Open items

- **`reentryAllows` fails open.** An engine PR should make `once_ever` fail closed. That is outside W2,
  and it is flagged for the W1 activation of the Post-Resolution flows.
- `mergeConversation` is not transactional today (a get, then a set). PR1's ticket repoint is
  transactional on its own, but a merge racing a create can still leave the stub with a new ticket.
  The next merge or a reopen finds it through the query.
- Failed message hooks are not retried. If the pilot shows missed first-response stamps, the close can
  backfill from the thread.
