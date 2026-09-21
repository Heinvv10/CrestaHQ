# W2 · Service desk: tickets on conversation threads

*Part of the [CRM gap programme](README.md) (Service desk table; decision 4: tickets layer on Conversations threads).*

**Goal:** a Blitz support agent turns a WhatsApp thread into a ticket, sets status, priority, owner and
category, works a queue that shows each ticket's SLA age, and closes it. At close, and only when the
operator ticks it for that close, the contact gets the tag that starts the Post-Resolution review flow.

**Status:** phase 1 (this doc). No code. Phase 2 starts when Lane C's audit PR1 is on `main` (it is:
`src/lib/audit/record.ts`) **and** the WA-media PRs that own `conversation-thread.tsx` and the composer
have merged.

## Needs Hein

These three are policy for Hein to set, not design. Everything else below was decided conservatively,
and each decision names the alternative it rejected.

1. **Do Blitz's support staff get to see deals, invoices and billing?** Today a sub-account member is
   an admin or a collaborator, and both see deals and quotes. If the answer is no, the *support agent*
   role (see [the permissions section](#support-agent-role-future)) becomes a pilot prerequisite. The
   programme lists this as a Later item whose trigger is exactly this case. **Recommendation:** pilot
   with collaborators who are already Blitz staff, and fire the trigger only if a non-staff
   contractor joins the desk.
2. **What happens to the 86 GHL Service Issues?** Counts from the export (read-only, 2026-09-21): all
   86 are `open` in GHL, one per contact (86 distinct contacts), created July–August 2026, none
   assigned, no custom fields. By stage: New Issue 76, Resolved 7, Awaiting ISP / Network 2,
   Diagnosing 1. **Recommendation:** Resolved → closed tickets (never tagged). The other 79 →
   open tickets in an *Imported, needs triage* view, excluded from SLA until an operator triages each
   one. The alternative is to import nothing and start clean, which is reasonable if Blitz says the
   July–August issues are long settled. The PR ships only a dry run in either case.
3. **Blitz's SLA policy:** its business hours, its public holidays, and first-response and resolution
   targets per priority. Until these are set, the queue shows business-hours age and no breach
   badges, and nothing escalates.

## Data model

### `tickets/{ticketId}`: a top-level collection, server-written only

| Field | Meaning |
|---|---|
| `agencyId`, `subAccountId`, `createdByUid` | Tenancy keys. `createdByUid` is the operator's uid, or `null` for an import |
| `territoryId` | Copied from the conversation on every ticket write, so the read rule can use the conversation's own scoping |
| `conversationId`, `contactId` | The thread (`conversations/{contactId}`) and its contact. A ticket needs a contact: an anonymous web-chat thread can be ticketed only after it captures identity |
| `subject` | Optional free text, ≤120 chars. Never copied into audit (it is redacted anyway) |
| `status` | `open` · `waiting_customer` · `waiting_third_party` · `closed` |
| `priority` | `urgent` · `high` · `normal` (default) · `low` |
| `categoryId` | One of the sub-account's category ids (enum-shaped, e.g. `no_connectivity`), default `general` |
| `ownerUid` | An active member, or `null`. Defaults at creation to the contact owner (`assignedToUid`) |
| `source` | `app` · `import` |
| `openedAt`, `firstResponseAt`, `closedAt`, `reopenedAt` | Server timestamps |
| `sla` | `{ exempt, activeBusinessMs, runningSince, firstResponseDueAt, resolutionDueAt, escalated: { firstResponse, resolution } }` (see [SLA](#sla-clock)) |
| `resolvedTagApplied` | `true` only when the operator ticked the box on the close that wrote the tag |
| `ghlOpportunityId` | Import only. The import's doc id is `ghl_<id>`, which makes a rerun idempotent |

### On the conversation: `openTicketId: string | null`

This is a server-maintained pointer that is set on create and cleared on close. The inbox row and
thread header read it to show a ticket badge without a query. It is not in the conversation rule's
client-writable keys, so a browser cannot set or clear it.

### Decisions

1. **A separate ticket doc, not fields on the conversation.** A thread outlives its issues: a Blitz
   customer reports a second fault after the first is fixed, and the second needs its own clock, owner
   and close. *Rejected:* `ticketStatus` etc. on `conversations/{id}`. That loses every closed issue,
   and every message path already writes the conversation doc, so the ticket state would race the
   hottest write in the app.
2. **Top-level, not `conversations/{id}/tickets`.** The queue asks for all open tickets in a sub-account,
   and the escalation job asks for all overdue tickets across tenants. A top-level collection answers
   both with plain composite indexes, which is the same reasoning as `auditEvents` and
   `dealStageHistory`. *Rejected:* a subcollection, which needs collection-group queries, indexes and
   rules, and is orphaned when a conversation is deleted.
3. **At most one open ticket per thread.** Create and reopen run in a transaction that reads
   `conversation.openTicketId` and refuses with 409 when it is set. The Blitz export fits this model:
   86 issues on 86 distinct contacts. *Rejected:* several concurrent tickets per thread, which is the
   merge/split/link problem the programme defers (trigger: >5% duplicate tickets on Blitz after 30 days).
4. **Every write goes through a server route. Clients have no write access to `tickets`.** Each state
   change must emit an audit event, and a client write cannot guarantee that. *Rejected:* the
   conversation model, where `status` and `starred` are client-writable. That is fine for a star and
   not for a record of accountability.
5. **The ticket owner is separate from the contact owner.** It defaults to the contact owner at
   creation. *Rejected:* reusing `contact.assignedToUid` (the SP2 owner mirror). Handing a fault to a
   support agent would silently change who owns the customer for sales.
6. **No per-sub-account ticket numbers.** The doc id's first 6 characters are shown as a reference.
   *Rejected:* a counter doc, which adds a hot contended write per create for a label that nothing
   customer-facing uses yet. Add it when a ticket reference is sent to a customer.
7. **Categories are a fixed list per sub-account, with enum-shaped ids.** The labels are free text.
   Because the ids are enum-shaped, audit stores them unredacted. *Rejected:* free-text categories,
   which fragment reporting and redact to `[redacted]` in audit.

## Statuses

```
            create                 operator
  (none) ─────────▶ open ◀────────────────────▶ waiting_customer
                     ▲  │ ◀── inbound message ──┘
                     │  │
          operator   │  └──────────────────────▶ waiting_third_party   (operator both ways)
                     │                                   │
          reopen     │         close (any open state)    ▼
                     └──────────────────────────────  closed
```

- **An inbound message on a `waiting_customer` ticket moves it back to `open`.** Otherwise a paused
  clock stays paused after the customer has answered, and the ticket drops out of the working view.
- **An inbound message on a `closed` ticket does nothing** apart from the usual unread count. A "thanks!"
  must not reopen a ticket. The operator reopens it, or opens a new one.
- **Reopening** is allowed when the thread has no other open ticket. The resolution clock resumes
  from its accumulated time and is not reset.
- *Rejected:* a separate `resolved` status before `closed`, which gives two states with no behaviour
  between them. *Rejected:* a `new` status. "Not yet picked up" is `ownerUid == null`, and "not yet
  answered" is `firstResponseAt == null`. Both are already on the ticket.

## SLA clock

**Business hours** come from the sub-account's existing `timezone` field, plus a weekly schedule and a
holiday list in its service-desk settings (below). The default schedule is Mon–Fri 08:00–17:00 with no
holidays. No holiday calendar ships in the product: this repo is a white-label template sold outside
South Africa too, so each tenant enters its own dates.

One pure module, `src/lib/service-desk/business-hours.ts`, provides `businessMsBetween(a, b, cal)` and
`addBusinessMs(a, ms, cal)`. It uses `Intl`, as `schedule-time.ts` already does, so DST-zone buyers
work.

| Clock | Starts | Pauses | Stops |
|---|---|---|---|
| **First response** | `openedAt` | never | the first **human** outbound message on the thread after `openedAt` (see [Message hooks](#message-hooks)) |
| **Resolution** | `openedAt` | while `waiting_customer` or `waiting_third_party` | `closed`. Reopen resumes it |

Resolution time is stored as accumulated business milliseconds (`activeBusinessMs`) plus
`runningSince` while the clock runs. Age is `activeBusinessMs + businessMsBetween(runningSince, now)`.
On each status transition the server settles the accumulator and recomputes both due times, or sets
them to `null` while paused, so the escalation job can run an indexed query instead of calculating.

**Targets** are optional and set per priority in business minutes. With no targets set, the queue shows
age only. `sla.exempt` (imports) shows age and never breaches or escalates.

**Breach → escalation task.** A QStash schedule runs every 15 minutes and queries
`status in [open] and sla.resolutionDueAt <= now` (and the first-response equivalent). For each result it
creates one internal task for the owner, or for the sub-account's admins when there is no owner, and
sets `sla.escalated.<kind>` in the same transaction. That gives one task per ticket per breach kind.
It is an internal write with no customer message, and its actor is `cron`.

### Decisions

8. **Due times are stored, not computed at read time.** *Rejected:* scanning every open ticket on every
   run to compute breach. That cost grows with tenants × tickets, and the QStash quota was already hit
   once (memory: `project_qstash_quota_workflow_visibility`).
9. **The first-response clock never pauses.** An operator who sets `waiting_customer` has usually just
   asked the customer something, and that message stops the clock anyway. *Rejected:* pausing both
   clocks, because a status change alone would then count as a "response".
10. **Bot replies do not count as a first response.** The customer has not reached a person yet.
    *Rejected:* counting the AI agent's reply, which would make every Velocity-style auto-answered
    ticket meet its SLA at once.

## Message hooks

After `upsertConversationForMessage` commits, it calls a best-effort `onTicketThreadMessage` when
`conversation.openTicketId` is set. It never runs inside the message transaction, so it can never break
a send or a receive.

- `direction: "inbound"` and ticket `waiting_customer` → `open`. Clock resumes. Audit actor `system`.
- `direction: "outbound"` and `pauseBot: true` (the flag that already marks a human reply) and
  `firstResponseAt == null` → stamp `firstResponseAt`.

A failed hook is logged (`[tickets] thread hook failed …`), not retried. The failure shows up as a
ticket left in `waiting_customer`, or as a first-response breach that did not happen. Both are visible
to the operator, and neither sends anything.

11. **The hook runs after the message transaction, not inside it.** *Rejected:* reading the ticket
    inside the conversation upsert transaction. That transaction runs on every message in the app, and
    making it longer for a feature most tenants do not use is the wrong trade.

## Queue views

A **Tickets** tab joins the Conversations tab strip (`ConversationsTabs`, beside Snippets) at
`/sa/[id]/conversations/tickets`. It is a full-width data surface, as Snippets is. Clicking a row opens
the thread in the normal split pane, with the ticket panel in the thread header. Conversations stays
the work surface: the queue is a list of threads to go and work.

| View | Filter |
|---|---|
| Unassigned (default) | not closed, `ownerUid == null` |
| Mine | not closed, `ownerUid == me` |
| All open | `open` |
| Waiting | `waiting_customer` · `waiting_third_party` |
| Breaching | not closed, a due time within 1 business hour or already past |
| Imported, needs triage | `source == import`, not closed, `sla.exempt` |
| Closed | `closedAt` in the last 30 days, paged |

Columns: contact, subject, status, priority, category, owner, SLA age with a breach badge, and last
message. The default sort is by earliest due time, then by oldest `openedAt`. Filters for priority and
category run client-side over the loaded open set, the same way the SP2 inbox filters work.

12. **One query for every non-closed ticket in a sub-account, filtered client-side. Closed is paged.**
    Blitz raised 86 issues in two months, so the open set stays small. *Rejected:* one indexed query
    per view, which needs more composite indexes, and indexes are a manual deploy step that has
    already gone wrong once.
13. **Tickets is a tab under Conversations, not a new sidebar item.** This is programme decision 4.
    *Rejected:* a separate Service Desk area, which would compete with the inbox for the same staff.

## Permissions

Behind a new agency gate, **`serviceDeskEnabledByAgency`** (default `false`, with all five steps of
[feature-gates.md](../architecture/feature-gates.md)). With the gate off, the routes return 403, the tab
and panel are hidden, and existing tickets are preserved.

| Actor | Read tickets | Create / change / close | Close with the resolved tag | Settings (hours, targets, categories, tag) |
|---|---|---|---|---|
| Agency owner | yes | yes | yes | yes |
| Sub-account admin | yes | yes | yes | yes |
| Collaborator | tickets on threads they can see (territory scoping, same as the conversation) | yes | yes | no |
| API key | — | — (no public API in W2) | — | — |
| AI agent (PR7, behind `serviceDeskAiTriageEnabledByAgency`) | its own sub-account | **priority and category only** | **never** | no |
| Import script | — | creates `source: import` tickets | **never** | — |

Rules: `tickets` read = `canSeeScopedDoc(subAccountId, agencyId, territoryId)`, write = `false`.
Settings live on the sub-account doc as a `serviceDesk` map, written only by an admin route. The rule
on the sub-account doc must not let a client write that key, and PR1 includes a rules test for it.

14. **AI may not change status, owner or close a ticket.** A close can start an outbound review flow,
    and a status change moves the SLA. Both are human calls under programme decision 6. *Rejected:*
    AI closing stale tickets. *Rejected:* AI opening tickets from inbound messages, which would flood
    the queue. That is Later, with the trigger "operators open more than 50% of tickets from threads
    the AI had already labelled as issues".

### Support agent role (future)

This is not built in W2. It is written down so the "custom roles" trigger has a spec to fire into
(Needs Hein 1).

| Area | Support agent |
|---|---|
| Conversations, contacts (read, notes, tags), tickets, tasks, snippets | full, within their territories |
| Contact delete, export, bulk actions | no |
| Deals, pipelines, quotes, invoices, products, payments, Client Billing | no, not even read |
| Workflows, AI agent config, settings, members, integrations | no |
| Reports | ticket reports only |

## Audit events

These go through `recordAuditEvent` after the write commits, per
[audit-events.md](../architecture/audit-events.md). There is one event per state change.

| Action | When | `changes` |
|---|---|---|
| `ticket.created` | create, including import | `status`, `priority`, `categoryId`, `ownerUid`, `source` |
| `ticket.updated` | priority, category, owner or subject edit | only the fields that changed. `subject` is always `[redacted]` |
| `ticket.status_changed` | every status transition, including close and reopen | `status`. On close it also includes `resolvedTagApplied: true/false` |
| `ticket.escalated` | SLA breach task created | `kind` (`first_response` / `resolution`) |
| `service_desk.settings_updated` | settings saved | enum-shaped fields and targets. The tag name is kept when it is enum-shaped (`issue-resolved` is) |

Target type `ticket` (new) or `subAccount` (settings). Actors: `user` (the route), `ai_agent` (PR7),
`cron` (escalation), and **`system`** for the inbound-message hook and the import.

**Contract additions this needs from Lane C** (owned by `src/lib/audit/types.ts`, raised with Lane C
rather than edited here):

- a `system` actor type. Its `id` names the trigger, e.g. `inbound_message` or `import.ghl`. An inbound
  message is not a cron job, a workflow or a user, and filing it under one of those would falsify the
  record.
- **staff uids kept unredacted.** Firebase uids are mixed-case, so the current rule redacts `ownerUid`,
  and "who was this assigned to" becomes unanswerable. The proposal: a value in a field whose name ends
  in `Uid` is stored when it matches the uid shape `[A-Za-z0-9]{20,128}`. Staff uids identify staff,
  not customers.

If Lane C declines the second one, owner changes still record `field: "ownerUid"` with redacted values,
and the W3 audit centre cannot say who a ticket moved to.

## Close → `issue-resolved`

Nothing writes Blitz's or Velocity's `issue-resolved` tag today. The GHL "Service Issue Resolved - tag"
flow is gone. The Post-Resolution drafts (trigger `contact.tag.added`, `trigger.tag: issue-resolved`,
`reentry: once_ever`) need a writer. The ticket close is that writer, and it is opt-in on every close.

- **Settings:** `serviceDesk.resolvedTag` holds a tag name, or `null`. When it is `null` the checkbox
  does not render.
- **Close dialog:** the checkbox is *"Tag contact `issue-resolved`"* and is **unchecked on every open of
  the dialog**. Under it, the dialog lists the **active** workflows whose `trigger.tag` equals that tag,
  e.g. *"Starts: Blitz — Review Ask Post Resolution (sends WhatsApp)"*. When none is active it says
  *"No active workflow uses this tag."* When the contact already carries the tag it says *"Already
  tagged — no workflow will start"*, because the tag diff (`fireTagsAdded`) fires only on a newly added
  tag.
- **Server:** `POST /api/tickets/[id]/close { applyResolvedTag: boolean }`. The field is required, so a
  missing value is a 400 and never a default. The tag is written through `updateContactServerSide`, so
  the same tag diff fires `contact.tag.added` in live mode exactly as a manual tag does.
- **Writes the tag only on the transition into `closed`.** A retried request, an edit to a closed
  ticket, or a reopen followed by a close without the box ticked writes nothing.
- **Never from:** the AI agent, the import, the escalation job, a reopen, or any bulk action (none ships).

15. **The tag write, not a direct enrolment.** Closing a ticket reuses the tag trigger the drafts already
    listen on, so a tenant's workflow decides what "resolved" does. *Rejected:* the close calling the
    workflow engine directly, which would hard-wire a review ask into the desk and bypass `reentry`.
16. **Opt-in on every close, default off.** This is a settled fact from the programme. *Rejected:* a
    per-tenant "always tag on close" setting, which is exactly the silent auto-send the programme
    forbids.
17. **The tag's `trigger.tag` hazard stays W1's gate.** The W1 spec already requires `trigger.tag` to
    be set before any Post-Resolution flow is activated. Without it, *any* tag re-enrols a tagged
    contact. The close dialog's workflow list shows the flows that match `trigger.tag` and lets the
    operator see what will start. It does not replace W1's fix.

## Migration of Blitz's 86 GHL Service Issues (dry run only)

`scripts/import-ghl-service-issues.ts`, modelled on the V1 WhatsApp backfill (`ghl-wa-backfill*`):

- **Reads** `~/Workspace/ApexSignal/ghl-export-data/blitz-fibre/opportunities.ndjson` and
  `config/pipelines.json`, and keeps rows on the *Service Issues* pipeline.
- **Resolves** each GHL `contactId` to a LeadStack contact through the GHL import's contact mapping (with
  phone as a fallback), and checks that `conversations/{contactId}` exists.
- **Maps stages** (subject to Needs Hein 2): Resolved → `closed`. New Issue, Diagnosing, Awaiting ISP /
  Network and Site Visit Scheduled → `open`, with `categoryId: imported`, `sla.exempt: true` and the
  original stage name kept as `subject`. `openedAt` = GHL `createdAt`.
- **Reports** counts only: rows per stage and target status, contacts matched by mapping, contacts
  matched by phone, contacts not found, threads with no conversation, and threads that already have an
  open ticket. No names, numbers or bodies.
- **Writes nothing.** The PR ships no write path. A later write needs Hein's approval of the dry-run
  count, and then follows V1: `--write --confirm <n>`, deterministic doc ids (`ghl_<oppId>`), one
  `ticket.created` audit event per row (actor `system:import.ghl`), and **no tag and no workflow
  trigger**.
- Contacts with no LeadStack match, or with no conversation, are reported and skipped. The script never
  creates a contact or a conversation.

## Rollback

| Lever | Effect |
|---|---|
| `serviceDeskEnabledByAgency` off | Routes return 403 and the tab, panel and hooks go quiet at once. Tickets are kept, so turning it back on resumes |
| Revert a PR | Everything is additive: new collection, new nullable `openTicketId`, new settings map. Old code ignores all three |
| Escalation (PR5) | Delete the QStash schedule **before** reverting, or it calls a 404 every 15 minutes |
| Tags a close wrote | Stay on the contact. A review ask that already went out cannot be unsent, which is why the tag is opt-in on every close |
| Import (future write) | Delete by `source == import` plus the `ghl_` doc-id prefix, and clear `openTicketId` on those conversations |

## PR slices

Each guarantee has a test that must fail when the guarded code is broken. Each PR body shows the test
failing under that deliberate break (memory: `feedback_mutation_test_every_guard`). Tests go through the
real route or the service seam, not only a helper beside it (memory: `feedback_test_the_seam_not_the_helper`).

| PR | Scope | Guarantee → the test that must go red |
|---|---|---|
| **1** | Gate (5 steps), `tickets` model + service + routes (create, update, status, close, reopen), settings route, business-hours module, rules, audit actions. No UI | • **One open ticket per thread:** two concurrent creates on a thread give one 201 and one 409 (red if the `openTicketId` read moves out of the transaction) · • **Tenancy:** a create against another sub-account's conversation gives 404. Rules test: another sub-account's member, a collaborator outside the territory, and another agency's owner are all denied (red if the read rule drops `territoryId`) · • **Server-only:** rules test shows a client create, update and delete on `tickets` and a client write of `conversation.openTicketId` all denied · • **Audit:** each route writes exactly one event with enum values (red if any call is removed) · • **Gate:** gate off gives 403 on every route · • **Close is opt-in:** close with `applyResolvedTag: false` leaves `contact.tags` unchanged and fires no trigger (red if the default flips). A missing field gives 400. `true` adds the tag and fires `contact.tag.added` once. An already-tagged contact fires nothing. A second close gives 409 with no second write · • **Business hours:** overnight, weekend, holiday and a DST day in `America/New_York`, with `businessMsBetween` and `addBusinessMs` as exact inverses |
| **2** | Message hooks in `upsertConversationForMessage` | Driven through the real upsert: a human reply stamps `firstResponseAt`, while a bot reply and an internal note do not (red if the `pauseBot` check is dropped). Inbound on `waiting_customer` moves the ticket to `open` and resumes the clock. Inbound on `closed` changes nothing. A hook that throws still leaves the message and conversation written |
| **3** | Thread panel and close dialog (after the WA-media PRs merge) | E2E on the fixture: create a ticket from a thread, change priority, owner and category, and close with the box unticked. The contact's tags are unchanged. Close and reopen, tick the box, and the tag is present. The dialog lists an active workflow on that tag. The box is unticked each time the dialog opens (red if its state persists) |
| **4** | Tickets tab with views and live SLA age, plus indexes | E2E: a new ticket appears in Unassigned, and after assigning it, in Mine. Age advances. `waiting_third_party` freezes age. A collaborator outside the territory does not see the ticket |
| **5** | Escalation schedule | Two runs over one overdue ticket make one task (red if `sla.escalated` is not written in the same transaction). Paused, exempt and closed tickets are never escalated. Actor `cron` |
| **6** | GHL Service Issues dry-run script | On a fixture export: the stage and target-status counts, the matched, unmatched and no-conversation counts, and **zero Firestore writes**, checked with a DB double that throws on any write (red if a write path is added). The script has no `--write` flag |
| **7** | AI triage (priority and category) behind `serviceDeskAiTriageEnabledByAgency` | The AI actor is refused for status, owner and close (red if the refusal is removed). Gate off gives no writes. Each AI change has an `ai_agent` audit row |
| **8** | Macros: a snippet may set a ticket status after it is sent (README: "snippets + status change") | Sending the snippet changes the status once and writes an audit event. It does nothing on a thread with no open ticket |

PR3 and PR4 are UI and wait for the WA-media PRs (#144–#149), which own `conversation-thread.tsx` and
the composer. PR1, PR2, PR5 and PR6 touch neither. PR7 and PR8 come after the Blitz pilot has run for a
week, so there is real ticket data to triage.

**Firestore deploy:** PR1 changes rules, and PR1 and PR4 change indexes. These are manual deploys: a
union of every open branch, never chained with the check, and only on Hein's go (see the
[programme gates](README.md#gates-that-stay-human)).

## Proof of done (phase 2)

On #1000: a thread becomes a ticket, sits in the Tickets queue with a live SLA age, and closes, with
the tag box shown and left unticked. The audit stream has one row per change. The Blitz pilot follows
once Blitz has a sendable channel (programme gate G1) and Needs Hein 1–3 are answered.

## Open items

- A failed message hook is not retried (see [Message hooks](#message-hooks)). If the pilot shows missed
  `firstResponseAt` stamps, the close path can backfill the stamp from the thread's messages.
- `deleteSubAccountForAgency` must add `tickets` to its clean-up in PR1.
- The ticket's `territoryId` is refreshed on ticket writes only. A contact moved to another territory
  keeps its old ticket territory until the next ticket write.
