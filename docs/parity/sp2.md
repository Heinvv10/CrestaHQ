# SP2 — Conversations / unified inbox

**Date:** 2026-09-13 · **Status: (a)(b)(c)(d)(e)(g)(v) merged 2026-09-13; (f) in review (#112); nothing deployed — #1000 browser proof follows the next approved deploy** · **Depends on:** SP0 (merged), SP1 (merged — contact owner `assignedToUid`) · **Blocks:** SP6 (send actions), SP7 (per-channel personas), SP14 (Velocity cannot triage in LeadStack until V1 lands).
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP2. Model ledger: [sp1.md](sp1.md).

Proving tenant: **#1000 CrestaHQ** (`subAccounts/54vPI0BS1zDMcxMyMAyA`) and the E2E fixture tenant. Never write Blitz/Velocity/Vortex data — V1 (Velocity backfill) writes only after Hein approves a dry-run count.

Definition of done per row: Playwright spec in `e2e/specs/` (mutation-proven, blocking CI) + blind review APPROVED + shown in the browser with a screenshot under `docs/parity/evidence/sp2/`.

**WhatsApp is in scope** (Cloud + bridge rails) — the programme's WhatsApp exclusion is struck. FB/IG ship behind `metaInboxEnabledByAgency`; **Meta App Review for app 1400409065548643 is the external blocker for live FB/IG** and is not submitted by this subproject.

---

## Ledger

Columns: GHL behaviour (observed 2026-09-13 in the CrestaHQ location `jEr9SOZnEyVsi8oK2Vnj`, screenshots in `evidence/sp2/ghl/`) · CrestaHQ today (code at `e23d635`, browser on #1000 2026-09-13, `evidence/sp2/before/`) · Gap · PR · Spec · Status.

### Inbox list

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| I1 | **Three-pane workspace**: conversation list · thread · contact details, all on one screen; opening a thread keeps the list visible | List page (`conversations/page.tsx`, `max-w-5xl`) → separate thread page with a collapsible details panel (`[contactId]/page.tsx`). Opening a thread loses the list | Split-pane inbox on `lg+` (list left, thread right, details toggle); list→thread navigation stays on mobile. Conversations becomes the second full-bleed page (rule change in `key-architecture.md`) | (a) | `inbox-filters.spec.ts` | **merged #105** |
| I2 | Tabs **Unread · All · Recent · Starred**, unread tab carries a count badge (25) | Pills All · Unread (count in label) · Email (`page.tsx:14,79-93`) | Starred tab; tab badge for Unread; Email pill moves into the channel filter (I4). Recent not built (see "Not building") | (a) | same | **merged #105** |
| I3 | Left rail **My inbox / Team inbox** (assigned to me vs everyone) | Everyone only | Inbox scope: All · Assigned to me · Unassigned, keyed on the conversation's `assigneeUid` | (a) filter, (b) data | same | **merged #105 + #106** |
| I4 | **Filters** drawer: Assigned, Follower, Mention, Last Message Direction, Last Outbound Message Type, Last Message Channel, Tag, SLA (AND/OR) | Email pill only; `lastDirection`/`lastChannel` already on every doc (`types/conversations.ts:89-146`) | Filters: channel (email/SMS/WhatsApp/Messenger/Instagram/web chat), last direction (awaiting reply = last inbound). Follower/Mention/SLA/Tag not built | (a) | same | **merged #105** |
| I5 | Per-row unread count badge, bold row | Per-row badge + bold (`conversation-list.tsx:56-116`) | — | — | — | parity |
| I6 | Star / unstar from the row and the thread header | No star concept | `starred` boolean on the conversation (client-writable in rules), toggle in row + header | (a) | same | **merged #105** |
| I7 | Mark as unread (envelope in thread header) | Opening a thread zeroes `unreadCount` (`page.tsx:112-115`); no way back | Mark unread (sets `unreadCount` to 1 when 0) | (a) | same | **merged #105** |
| I8 | Sort toggle (newest / oldest) | Newest first, client-side sort (`firestore/conversations.ts:29-59`) | Oldest-first toggle | (a) | same | **merged #105** |
| I9 | Search | Name/phone substring (`page.tsx:56-67`) | Add email | (a) | same | **merged #106 (moved from (a))** |
| I10 | Select-all + bulk actions on the list; delete conversation | None | Not in scope list (see "Not building") | — | — | out of scope |

### Thread + composer

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| T1 | **Owner** picker in the details panel (= contact owner); Followers | Details panel shows phone/source/tags/deals/tasks; no owner. `conversation.assigneeUid` exists and is client-writable in rules (`firestore.rules:811-813`) but nothing sets it; SP1 put `assignedToUid` on Contact | Owner picker in thread + details; single owner = contact `assignedToUid`, mirrored server-side to `conversation.assigneeUid` on **every** contact-assignment path (form, bulk assign, API). Followers not built | (b) | `inbox-assign-notes.spec.ts` | **merged #106** |
| T2 | **Internal Comment** tab in the composer — posts into the thread, never sent | Contact notes exist (`contacts/{id}/notes`, rules 909-914) but only on the contact page | Composer "Internal note" mode writes a contact note (`source: "conversation"`); thread timeline renders notes inline, visually distinct; also appears on the contact timeline | (b) | same | **merged #106** |
| T3 | **Snippets** tab: list (Name, Body, Folder, Type, Updated), folders, "Add Text Snippet" / "Add Email Snippet"; composer snippet button inserts one ("No snippets available" when empty) | Nothing (only WhatsApp approved templates under AI Agents) | `snippets` collection (sub-account scoped, `type: text|email`, optional `folder`, email snippets carry a subject); management page `/sa/[id]/conversations/snippets`; composer picker | (c) | `inbox-snippets.spec.ts` | **merged #108** |
| T4 | **Custom Values** picker (tag icon) inserts merge fields; rendered at send | No shared renderer; two ad-hoc `.replace` chains (`missed-call.ts:101-111`, `conversation-composer.tsx:70-79`). No custom-values concept | One merge-tag renderer (`{{contact.first_name}}`, `{{contact.name}}`, `{{contact.email}}`, `{{contact.phone}}`, `{{business.name}}`…) used by snippets, the composer and scheduled sends; the two ad-hoc chains keep their legacy aliases through it | (c) | same | **merged #108** |
| T5 | Send button menu: **Send · Send Later · AI Schedule** | Send only | Send Later: date/time picker → `scheduledMessages` doc + QStash `notBefore`; worker re-checks opt-out, identity, gates and the WhatsApp window **at send time**; pending sends listed in the thread with Cancel. AI Schedule not built | (d) | `inbox-scheduled-send.spec.ts` | **merged #111** |
| T6 | Email composer: From, From Name, To, CC/BCC, Subject; each email is a card with its own Reply; replies thread | Subject + body; per-message Reply sets `In-Reply-To`/`References` (bounded 100) via `email-reply.ts` → `/api/comms/email/send` (route validates, lines 14-47, 112-129). Inbound grouping via `email-conversations.ts` / IMAP sync | Prove end to end: reply from the composer carries the headers on the wire, an inbound reply with `In-Reply-To` lands in the same conversation, subject `Re:` handling. Fix whatever the spec finds. CC/BCC not built | (e) | `inbox-email-threading.spec.ts` | **merged #103** |
| T7 | **Channel dropdown** in the composer (Email, SMS, WhatsApp…) — every channel listed | Only *configured* channels are offered, and only switchable when >1. Observed on #1000: a WhatsApp thread offers **only Email**, to a contact with **no email address**, with no hint why WhatsApp is missing (`evidence/sp2/before/02-*`) | Switcher lists every channel; unavailable ones disabled with the reason (not connected / agency gate off / no email or phone / opted out / no Meta identity) | (f) | `inbox-channel-switcher.spec.ts` | **PR #112** |
| T8 | WhatsApp: composer shows the 24h customer-service window; outside it only templates can be sent | Enforced server-side only — `resolveWaSendMode()` (`whatsapp/send-mode.ts`), route 409s `session_window_closed`; the operator learns after pressing Send. Bridge rail is window-exempt with its own refusals | Window state in the composer for Cloud/Twilio rails: "open · closes in 3h 12m" / "closed — send a template", computed from the last inbound WhatsApp row and `sessionWindowHours`; template picker when closed. Bridge rail shows no window | (f) | same | **PR #112** |
| T9 | Attachments, emoji, trigger links, payment links in the composer | Not in the composer | Not in scope list | — | — | out of scope |
| T10 | Conversation AI on/off | AI replies Auto / Suggest / Off per thread + draft card | — (CrestaHQ step up) | — | — | parity+ |

### Channels and automations

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| C1 | Email in and out of the inbox | IMAP sync + SMTP send, live on #1000 since 2026-09-08 | Covered by T6 | (e) | — | parity |
| C2 | SMS | Twilio inbound + send route | — | — | — | parity |
| C3 | WhatsApp in the inbox | Cloud + bridge + Twilio rails all land via `upsertConversationForMessage` (`conversations-service.ts:96-251`) | T7/T8 | (f) | — | parity (inbox) |
| C4 | Facebook / Instagram DMs | Inbound webhook + send route behind `metaInboxEnabledByAgency`; lands in `conversations` | Channel filter (I4) and switcher (T7) include them; live proof blocked on Meta App Review (app 1400409065548643) — not submitted here | (a) #105, (f) #112 | fixture-level only | **blocked (external — Meta App Review, app 1400409065548643, not submitted)** |
| C5 | Missed-call text-back | `missed-call.ts` + Twilio voice/status webhooks, gated by `missedCallTextBackEnabledByAgency`, idempotent per `callSid`; **no unit test and no E2E** | Spec drives a signed Twilio status webhook (no-answer) on the fixture tenant and asserts: contact reconciled, SMS row + conversation row written, activity logged, second callback is a no-op; unit tests for `handleMissedCall`. Live proof on #1000 needs a dedicated Twilio number (see risks) | (g) | `missed-call-text-back.spec.ts` | **merged #104 (fixture; live blocked: #1000 has no dedicated Twilio number)** |
| C7 | Web chat widget conversations in the inbox | Live: `web_{sessionId}` threads with their own composer (`WebChatComposer`, `[contactId]/page.tsx:271`), `webChatSessions` rules (`firestore.rules:382`) | Must survive the split-pane (a) and appear in the channel filter; not a switcher target in (f) — a web visitor can only be answered in their live session | (a) | `inbox-filters.spec.ts` seeds one | parity (keep working) |
| C6 | SLA settings, Manual Actions, Trigger Links, Analytics tabs | — (Tracked Links exists separately) | SLA / Manual Actions / Analytics belong to SP6/SP11 | — | — | out of scope |

### Data

| # | Item | Today | Gap | PR | Status |
|---|---|---|---|---|---|
| V1 | Velocity #1002 WhatsApp history is complete | 3,880 GHL threads imported, frozen 2026-09-10 07:14Z; Cloud webhook live only from ~14:00 SAST 2026-09-11 — a ~31h hole | Read-only script pulls GHL messages in the window, dedupes against what LeadStack already holds, **dry-run count first**; write only after Hein approves the count | (v) #102 | **merged — script only; dry run 136 writable, 140 on 80 unknown contacts; write awaits Hein** |

---

## Build order and DAG

| PR | Scope | Rows | Depends on | Notes |
|---|---|---|---|---|
| (a) | Split-pane inbox, tabs, inbox scope, channel/direction filters, star, mark unread, sort, email search | I1–I4 I6–I9 | — | Largest UI change; `review-team` |
| (e) | Email threading end-to-end proof + fixes | T6 | — | parallel with (a) |
| (g) | Missed-call text-back unit + E2E | C5 | — | parallel with (a) |
| (v) | Velocity WA backfill script (dry-run only in the PR) | V1 | — | parallel; write step is Hein's call |
| (b) | Owner picker + contact→conversation assignee mirror; internal notes in thread | T1 T2 | (a) | reviewer hunts every contact-assignment path that skips the mirror |
| (c) | Snippets + merge-tag renderer | T3 T4 | (b) (composer) | |
| (d) | Scheduled send via QStash | T5 | (c) (renderer) | extracts a server-side send service the routes and the worker share |
| (f) | Channel switcher with reasons + WhatsApp window state + template fallback | T7 T8 C4 | (d) (composer) | |

(a)/(b)/(c)/(d)/(f) all edit the composer or the list, so they run in sequence; (e)/(g)/(v) touch neither and run beside them. Every PR is additive: nullable fields, new collections, no renames.

## Gates per PR

1. `pnpm ci:check` green locally (lint at `--max-warnings 0`, tsc, vitest, build) and `pnpm check:tenancy`.
2. Playwright spec under `e2e/specs/`, mutation-proven: the PR body shows it red against one deliberate break of production code. Local E2E only under `flock /tmp/crestahq-e2e.lock`, and never while a CI E2E job is running (the fixture sub-account is purged by every run).
3. New collection or index → `firestore.rules` / `firestore.indexes.json` in the PR; deploy is manual, as a **union of every open branch's rules**, then once more from `main` after the last merge. Indexes deploy too.
4. Blind `/review`; `review-team` for 500+ lines; one reviewer briefed to hunt unreachable paths (a filter the query ignores, a mirror nothing calls, a worker nothing schedules). Fix rounds are their own review target.
5. Anything that makes a message reach someone new, or fire more often, is flagged in the PR body (scheduled send is the candidate: it sends later, not to more people).
6. Merge via REST when CI is green and review is APPROVED. Update this ledger's Status column and add an evidence screenshot.

## Decision summary (grilled 2026-09-13 from the repo and GHL side by side; Hein's overrides welcome)

**Verdict:** Proceed with constraints.

**Design concept:** the inbox is a *triage workspace* on top of the existing conversation index — `conversations/{contactId}` stays a thin, server-created index; SP2 adds per-conversation state (star, owner mirror) and per-sub-account content (snippets, scheduled messages), and never moves message storage.

**Rulings (defaulted — each is the one to overturn if wrong):**
1. **Split-pane layout, full-bleed.** GHL's inbox is one screen; the done-definition asks for the same information architecture, and triage speed is the point of SP2 (Velocity's staff live in this screen). This is a deliberate exception to "Pipeline is the only full-bleed page"; `key-architecture.md` is updated in PR (a). *Overturn if* Hein wants the width rule held — fallback is a two-pane list+thread inside `max-w-6xl`.
2. **Owner = contact owner.** GHL's conversation "Owner" is the contact's assigned user. SP1 already put `assignedToUid` on Contact; the conversation carries a server-maintained mirror (`assigneeUid`) so the list can filter without loading every contact. The contact is the source of truth; the client-writable `assigneeUid` key is removed from the conversation rule so the two cannot diverge.
3. **Star is shared per conversation** (a boolean, like `status`), not per user. Per-user stars need a join the fully-loaded list does not have. *Overturn if* several staff star independently in practice.
4. **Internal notes are contact notes** with `source: "conversation"`, so they appear in the thread and on the contact timeline from one write, under existing rules.
5. **Merge tags render at insert time in the composer** (operator sees exactly what is sent) and again at send time for scheduled messages; unresolved `{{…}}` blocks Send with a visible error rather than shipping a raw tag to a customer.
6. **Scheduled send re-evaluates everything at fire time** — opt-out, contact identity, agency gates, WhatsApp window. A scheduled WhatsApp free-form message whose window has closed is refused and marked failed with the reason, never silently converted to a template.

**Proven assumptions (checked at `e23d635`):**
- Every inbound and outbound rail already funnels through `upsertConversationForMessage`, which increments `unreadCount` on inbound — unread counts need no new write path.
- `lastChannel` / `lastDirection` are on every conversation doc, so channel and direction filters are client-side over the already-live list (same approach as SP1 smart lists; a composite index `(subAccountId, lastDirection, lastMessageAt)` exists).
- Email threading headers are already generated and validated; (e) is a proof-and-fix PR, not a build.
- QStash is live on crm.crestahq.com (fixed 2026-09-06) and used by broadcasts, reminders and social publish — (d) adds one more worker, no new infrastructure.
- The WhatsApp window rule lives in one function (`resolveWaSendMode`), so the composer's window state can reuse it instead of re-deriving the rule.

**Highest-risk unknown:** (d). The send logic for each channel lives inside its HTTP route (session-authenticated), so a worker cannot call it. The PR extracts one server-side `sendConversationMessage` used by the routes *and* the worker. Mitigation: the existing route tests must pass unchanged against the thin wrappers; one reviewer diffs old route behaviour against the extracted service, check by check.

**Other risks:**
- **Missed-call live proof** needs a dedicated Twilio number on #1000; if #1000 has none, (g) is proven on the fixture tenant with a signed webhook and the live step is recorded as blocked, not claimed.
- **Velocity backfill** depends on the GHL API answering while the agency sits on a failed-payment hold; the script must fail loudly, not import a partial window.
- **FB/IG** stay fixture-proven until Meta App Review passes.

**Explicitly not building:** Recent tab, Followers, Mentions, SLA, Tag filter in the inbox, bulk actions on conversations, delete conversation, AI Schedule, CC/BCC, attachments/emoji/payment links in the composer, iMessage/"SMS Android" (GHL device channels), Manual Actions, conversation Analytics.

**Rollback:** every PR is additive. Reverting (a) restores the list page; `starred` fields are ignored by old code. Reverting (b) leaves `assigneeUid` mirrors that nothing reads. Reverting (d) leaves pending `scheduledMessages` that nothing fires — cancel them before reverting.

## Review log (2026-09-13)

Every PR had a blind review team (fresh agents, diff + CLAUDE.md only; an adversarial reviewer on each security- or send-path change; a browser pass on every UI PR against a local standalone build on the fixture tenant). The code is the source of truth; this is the why.

- **Merged:** #101 ledger · #102 (v) Velocity backfill script · #103 (e) email threading · #104 (g) missed-call + fenced fake SMS provider · #105 (a) split-pane inbox · #106 (b) owner mirror + notes + email search · #108 (c) snippets + merge tags · #111 (d) scheduled send + one send service · #113 E2E_PORT harness. (f) is #112.
- **Firestore rules** were deployed by hand: 07:27Z (`starred`, from #105's branch as a union with main), after #106 (`assigneeUid` removed from the client-writable conversation keys), after #108 (snippets deny block). After #108 a main-only deploy briefly (~1 min) dropped SP3 #109's open-PR rules before the union was redeployed — see memory `feedback_rules_deploy_check_then_deploy`. `snippets` and `contacts/{id}/scheduledMessages` are server-only (`if false`), so they never depend on a rules deploy. **Redeploy from main after the last SP2/SP3 merge.**
- **Reviews caught, before merge:** an orphan conversation stalling forever on "Loading conversation…" (#105); URL↔filter-state races (#105); the owner mirror losing a race and the contact-link adopt branch copying the stub's owner/territory (#106); Send-time re-render rewriting contact text that looked like a merge tag, and a deferred caret that split fast typing (#108 — the caret race was caught by CI, not locally); late QStash retries sending hours late, provider timeouts labelled "Not sent", silent double-booking on an out-of-range date, sends stuck in "sending" (#111); a STOP'd WhatsApp thread silently opening on SMS, and template sends never updating the conversation (#112); the approved backfill report being able to approve itself (#102).
- **CI noise, not code:** four PR runs failed because local E2E runs held `:3100` (fixed by #113 — local runs now use `E2E_PORT`); two main runs failed on velo-server host networking (a Docker container attaching an interface mid-login, DNS timeouts) — proven with the Playwright traces and the host journal.
- **#1000 data:** the owner/email mirror backfill ran on #1000 (263 scanned, 206 email mirrors written, 0 owners — no contact has an owner yet).

## Waiting on Hein

- **Velocity WhatsApp backfill (V1):** dry run 294 fetched · 18 present · **136 writable** · 80 GHL contacts with no LeadStack contact carry 140 more messages (reported only). Approved report `~/.local/share/crestahq/ghl-wa-backfill-report-2026-09-13.json` on velo-server; the exact `--write --confirm 136` command is in PR #102's comments. The 140 need a decision (create the contacts or leave them).
- **Owner/email mirror backfill** for the client sub-accounts (dry run): Blitz 5052 scanned / 21 email mirrors, Velocity 3889 / 3, Vortex 58 / 54 — `scripts/backfill-conversation-owner-email.ts --write --sub-account <id>`.
- **Deploy** (after 17:00 Mon–Fri): then the #1000 browser proof for every row above.
- **Missed-call text-back live:** #1000 has no dedicated Twilio number (`twilioConfig: null`, gate off).
- **Scheduling beyond 7 days:** needs the production Upstash plan confirmed (Free plan max delay is 7 days).
- **Live email route and opted-out contacts:** the live `/api/comms/email/send` has never refused an `emailOptedOut` contact server-side (scheduled sends now do). Unchanged, flagged.

## Follow-ups (surfaced by review, not in SP2 scope)

- Missed-call template with a canonical tag for an unknown caller renders "Hi , …"; `{{contact.*}}` beyond first name is empty in missed-call templates; a third ad-hoc replace chain remains in `src/lib/reviews/request.ts`.
- The contacts rule still lets a member write `assignedToUid` directly from the browser (no UI does) — such a write skips the owner mirror until the next message. A failed mirror is logged, not retried; very large bulk assigns may hit a proxy timeout.
- Link/merge leaves `web_` web-chat conversation rows pointing at the deleted stub (pre-existing).
- No contact details panel at phone width (owner picker is in the thread bar); "Couldn't load pipelines" 500 toast seen on the fixture; `conversation-composer.tsx` and `[contactId]/page.tsx` are over 300 lines.
- A 3-click A→B→A filter burst collapsed into one URL echo can leave a stale pending write.
- Scheduled WhatsApp on the bridge rail fails at fire time during quiet hours (recorded, never sent).
- WhatsApp templates whose merge-tag variable resolves empty are a dead end in the picker (pre-existing sender); bridge rows count toward a Cloud window (pre-existing server logic).
- The E2E cannot reliably reproduce the caret race; unit tests are the guard.
