# SP1 — Contacts, Smart Lists, Opportunities, Tasks

**Date:** 2026-09-11 · **Status: all PRs merged; deployed to crm.crestahq.com 2026-09-12 05:20 SAST (0e2cc7d)** · **Depends on:** SP0 (merged) · **Blocks:** SP6 (workflow rebuild needs tags/pipelines), SP11 (reporting), SP14.
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP1. Handoff: `.claude/handoffs/2026-09-11-1640.md`.

Proving tenant: **#1000 CrestaHQ** (`subAccounts/54vPI0BS1zDMcxMyMAyA`). Never Blitz/Velocity/Vortex.

Definition of done per row: Playwright spec (mutation-proven, blocking CI) + blind review APPROVED + shown in the browser on #1000 with a screenshot under `docs/parity/evidence/sp1/`.

> **Evidence:** per-feature frames under `evidence/sp1/<letter>-*/` come from a local standalone build of `main` driven on the E2E fixture tenant; `evidence/sp1/prod-1000/` are screenshots of crm.crestahq.com on #1000 after the 2026-09-12 deploy (contacts with smart-list tabs/filters/selection/phone-titled contacts, pipeline, companies, contact activity chips, custom-field folders).

---

## Ledger

Columns: GHL behaviour · CrestaHQ today (verified in code at `0d6f449` and in the browser on #1000, 2026-09-11) · Gap · PR · Spec · Status.

GHL column drawn from product knowledge (ghl-agency-ops skill); rows marked ⚠ still need side-by-side confirmation in the GHL tab, which was logged out in this Chrome profile at session start.

### Contacts list

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| C1 | Contacts list: name, phone, email, created, last activity, tags; columns manager | Table: Name, Email, Phone, Company, Source, Territory (conditional), Added. Sort on Name/Added only. Live `onSnapshot`, no pagination (`contacts/page.tsx`, `contacts-table.tsx`) | Tags column missing; no columns manager (defer — not in scope list) | — | — | out of scope |
| C2 | Quick search (name/email/phone) | Search box, client-side substring on name/email/company. **Phone not searched** | phone search | (a) #91 | `contacts-smart-lists.spec.ts` | merged |
| C3 | **Filters** panel: AND/OR condition builder over tag, source, date added, pipeline stage, custom fields, DND, assigned user… | None. Only the search box | Filter builder | (a) #91 | same | merged |
| C4 | **Smart Lists**: save a filter set as a named tab; per-user + shared; rename/delete; "All" is the default list | None | Saved smart lists | (a) #91 | same | **merged 8846b2c** |
| C5 | Row checkboxes, select-all-on-page / select-all-matching | No row-selection model in the table | Selection | (b) #97 | `contacts-bulk-actions.spec.ts` | **merged 3c21cf1** |
| C6 | Bulk: add/remove tag | None (bulk email/call dialogs exist but use their own audience filter, not selection) | Bulk tag | (b) #97 | same | merged |
| C7 | Bulk: assign to user (owner) | **No `assignedTo` on Contact at all** (`src/types/contacts.ts`) | Add `assignedToUid` + bulk assign + single-contact assign in form | (b) #97 | same | merged |
| C8 | Bulk: delete (with confirm) | None | Bulk delete | (b) #97 | same | merged |
| C9 | Bulk: export CSV of selection | Export button dumps *all loaded* contacts | Export selection (falls back to all when nothing selected) | (b) #97 | same | merged |
| C10 | Bulk: send email / SMS / add to workflow / pipeline change | Bulk email + bulk AI call exist (audience filter) | Not in scope list; keep existing | — | — | out of scope |
| C11 | Import CSV with mapping | Exists (`import-contacts-dialog.tsx`) | — | — | — | parity |
| C12 | ⚠ Contact can exist with phone only, name optional (shows phone as title) | Create/edit with **no email works** (proven in browser 2026-09-11: created "SP1 NoEmail Probe" with phone only, edited company, deleted). **Name is required** — WhatsApp-inbound contacts arrive nameless ("Unnamed"), so the first edit forces the operator to invent a name | Make name optional when phone or email is present; title falls back to phone | (g) #89 | `contact-nameless-edit.spec.ts` | merged |

### Contact detail

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| D1 | Header: name, tags, owner, DND, source | Name, Email/SMS/Review/Edit/Delete actions, phone, company, source, tags | Owner (needs C7) | (b) #97 | bulk spec asserts owner shown | merged |
| D2 | **Custom fields grouped in folders** ("General Info", custom folders), collapsible | Flat "Details" card, ordered by `order` (`CustomFieldDef` has no folder) | Folders: `folder` on def + settings UI to create/rename/assign + grouped render in detail + form | (f) #90 | `custom-field-folders.spec.ts` | **merged 6f984d5** |
| D3 | **Activity** tab: every event (messages in/out, notes, tasks, appointments, opportunity moves, workflow enrolments/steps, form submits) | `activity-timeline.tsx` merges `notes` + `activities`; types cover pipeline_moved, task_completed, form_submitted, email/sms/wa/messenger/ig sent, automation_*, voice, quote, booking, order, webinar | **Inbound** messages are not activities (they live in `messages`/`whatsappMessages`/`emailMessages`); `task_created` missing; `deal_created`/`deal_won`/`deal_lost` only via pipeline_moved; workflow entries not linked to the run | (e) #96 | `contact-timeline.spec.ts` | **merged 7ee08ae** |
| D4 | Tasks sub-tab on contact | `contact-tasks.tsx` | — | — | — | parity |
| D5 | Opportunities on contact | `contact-deals.tsx` | shows the pipeline name when >1 pipeline (#93) | (c) #93 | — | merged |
| D6 | Company link | `company` is a free-text string | See Companies | (d) #92 | — | merged |

### Companies (GHL "Businesses")

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| B1 | Companies list (name, phone, website, address, #contacts) | Nothing | `companies` collection + list page `/sa/[id]/companies` | (d) #92 | `companies.spec.ts` | merged |
| B2 | Company detail with linked contacts | Nothing | Detail page listing contacts where `companyId == id` | (d) #92 | same | merged |
| B3 | Contact → company picker (create inline) | Free text | `companyId` on Contact; form picker with create-new; keep `company` string in sync for CSV/quotes | (d) #92 | same | merged |

### Opportunities / Pipeline

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| O1 | **Multiple pipelines** per sub-account, each with its own stages; pipeline switcher on the board | One fixed 6-stage pipeline (`PIPELINE_STAGES`), label/order overrides on the sub-account doc | `pipelines` collection (stages embedded), `pipelineId` on Deal, switcher, default pipeline migration | (c) #93 | `pipelines.spec.ts` | merged |
| O2 | Pipeline settings: create/rename/delete pipeline, add/rename/reorder/delete stages | Stage label/order only, in settings | Full CRUD | (c) #93 | same | merged |
| O3 | ⚠ Stage-level automation: stage change fires workflow trigger "Pipeline Stage Changed" (filter by pipeline + stage); "Opportunity Created"; "Opportunity Status Changed" (won/lost) | `pipeline.stage.changed` fires from `deals-service.ts:336-341` with `toStage`; no created/won/lost triggers; trigger filter has no pipeline dimension | Add `pipelineId`/`fromStage` to context; new triggers `deal.created`, `deal.won`, `deal.lost`; trigger filter by pipeline | (c) #93 | same + workflow enrol assertion | merged |
| O4 | Board + list view, filters (owner, stage, value, date) | Board only; filters: stage, priority, value range, country | List view out of scope | — | — | out of scope |
| O5 | Won/Lost with lost reason | `lostReason`, terminal stages | — | — | — | parity |
| O6 | Opportunity owner | No `assignedTo` on Deal | `assignedToUid` on Deal (same PR as contacts) | (b) #97 | — | merged |

### Tasks

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| T1 | Tasks list across contacts; filters: assignee, status, due | Today/Overdue/Upcoming/Done/All tabs (`TaskFilter`) | Assignee filter (needs T2) | (b) #97 | `tasks-assign.spec.ts` | merged |
| T2 | Assign task to user | **No `assignedTo` on Task** | `assignedToUid` on Task + dialog picker + filter | (b) #97 | same | merged |
| T3 | Link task to contact / opportunity | `contactId`, `dealId` | — | — | — | parity |
| T4 | Bulk complete / delete | None | Not in scope list | — | — | out of scope |

### Custom fields settings

| # | GHL | CrestaHQ today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| F1 | Custom Fields page: folders, drag order, field types | `sub-account-custom-fields-section.tsx`, flat, 9 types, max 100 | Folders (D2) | (f) #90 | `custom-field-folders.spec.ts` | **merged 6f984d5** |

---

## Build order and DAG

Each PR is greenfield-or-additive, on tenant-scoped docs carrying `agencyId`/`subAccountId`/`createdByUid`, specs first.

| PR | Scope | Ledger rows | Depends on |
|---|---|---|---|
| #87 | agency-owner claims fallback (unblocks owner-login specs) — **merged** | — | — |
| (a) #91 | Smart lists: filter model + builder UI + saved lists (`subAccounts/{id}/smartLists`) + phone search | C2 C3 C4 | #87 (merged) |
| (b) #97 | Selection + bulk tag/assign/delete/export; `assignedToUid` on Contact/Deal/Task; task assignee filter; assignee field in the smart-list filter builder | C5–C9 D1 O6 T1 T2 | (a) (filter → selection) |
| (c) #93 | Multiple pipelines + stage CRUD + `pipelineId` on Deal + triggers `deal.created/won/lost` + pipeline dimension on `pipeline.stage.changed` | O1 O2 O3 D5 | — (parallel with a/b) |
| (d) #92 | Companies collection, list/detail pages, contact picker | B1–B3 D6 | — |
| (e) #96 | Timeline: inbound message activities (all rails incl. web-chat), `task_created`, `automation_started/completed/failed`, run links, filter chips | D3 | — |
| (f) #90 | Custom-field folders | D2 F1 | — (merged) |
| (g) #89 | Nameless contact edit | C12 | — |

Sizes: (a) and (c) are the large ones (expect 500+ lines → `review-team`). (b) is medium. (d) medium. (e), (f), (g) small.

## Gates per PR

1. `pnpm ci:check` green locally (lint at `--max-warnings 0`, tsc, vitest, build).
2. `pnpm check:tenancy` passes.
3. Playwright spec added under `e2e/specs/`, mutation-proven: the PR body shows the spec red against one deliberate break of the production code.
4. Any `firestore.indexes.json` / rules change → `firebase deploy --only firestore:rules,firestore:indexes` (service-account workaround in memory `project_crestahq_gh_pr_rest`).
5. Blind `/review`; `review-team` for 500+ lines; one reviewer briefed to hunt unreachable paths (a route no UI calls, a trigger nothing fires, a filter the query ignores).
6. Fix rounds reviewed as their own target.
7. Merge via REST when CI green + APPROVED. Update this ledger's Status column + evidence screenshot.

## Decision summary (grilled 2026-09-11, evidence from the repo; Hein's overrides welcome)

**Verdict:** Proceed with constraints.

**Design concept:** SP1 is "GHL's contact/opportunity data model on top of what already exists" — every feature extends a live collection additively; nothing existing is renamed or moved.

**Proven assumptions (checked at `7bab54a`):**
- A filter engine already exists: `ConditionGroup { all: Condition[]; match?: "all"|"any" }` (`src/types/workflows.ts:70-73`), evaluated by `src/lib/workflows/conditions.ts`, with an editor at `src/components/workflows/conditions-editor.tsx`. **Smart lists store a `ConditionGroup` and reuse the evaluator and the editor.** The evaluator is `server-only`; the pure evaluation moves to an isomorphic module (`src/lib/contacts/conditions.ts`) that `workflows/conditions.ts` re-exports — the workflow engine's behaviour is unchanged and its tests stay green.
- `pipeline.stage.changed` is the only stage hook and it keys on `trigger.toStage` (a stage id; `engine.ts:970`). Multi-pipeline keeps existing `stageId` strings on the migrated default pipeline, so every stored trigger keeps matching without a data migration of workflows.
- The contacts list is fully client-loaded (`onSnapshot`, no pagination). Smart lists evaluate client-side over that array. #1000 holds a few hundred contacts; Blitz/Velocity are larger but still one collection read — acceptable for v1, noted as the first thing to revisit if a list stalls.
- No assignment concept exists on Contact, Deal or Task. `assignedToUid` is a new nullable field on all three; the picker lists `subAccounts/{id}/subAccountMembers`.
- Rules pattern for new sub-account collections is `tenantFieldsLockedOnUpdate()` + territory-aware read (contacts `firestore.rules:762`). `smartLists`, `pipelines`, `companies` follow it.

**Highest-risk unknown:** (c). Changing the deal → stage relationship touches the board, the deal dialogs, the deals API/v1 API, webhooks, the workflow `move_stage` action and the trigger filter. Mitigation: default pipeline = today's stages with the same ids; `pipelineId` optional on read (absent ⇒ default) and always written on create/update; one reviewer briefed to hunt any path that still assumes one pipeline.

**Explicitly not building:** columns manager (C1), list view for opportunities (O4), bulk complete/delete tasks (T4), bulk add-to-workflow (C10), nested condition groups, per-user private smart lists, server-side smart-list evaluation, teams.

**Rollback:** every PR is additive with nullable fields; reverting a PR leaves data that older code ignores. (c) is the exception — after (c) ships, deals carry `pipelineId`; old code ignores it and still renders by `stageId`, so a revert is still safe.

**User-owned decision, defaulted:** smart lists are shared across the sub-account (GHL default). Hein can flip to per-user later; the doc carries `createdByUid` either way.

## Assumptions

- Assignment = a sub-account member (`subAccounts/{id}/subAccountMembers/{uid}`); stored as `assignedToUid: string | null`. No "team" concept.
- Smart lists are per sub-account, visible to all members (GHL's default); `createdByUid` recorded, no per-user privacy in v1.
- Filter evaluation is client-side over the already-live contact list (the list is fully loaded today; no server pagination exists). Server-side smart-list evaluation is a follow-on if lists exceed what the browser holds.
- Existing deals migrate to a generated "Default" pipeline whose stages are today's six; `stageId` values unchanged so every existing workflow trigger keeps matching.
- Companies are a separate top-level collection `companies/{id}` (sub-account scoped), not a subcollection, so cross-contact queries stay single-collection.

## Review log (2026-09-11)

Decisions and residuals surfaced by the blind review teams — the code is the source of truth; this is the why.

- **Firestore rules are not deployed by CI**, so every new subcollection is default-deny until `firebase deploy`. Deployed during the session as a union of all open SP1 branches; **after the last merge, deployed once more from `main` 3c21cf1** so the released ruleset equals the file in the repo (verified byte-identical). A parallel SP15 session overwrote the union once mid-day — any session that runs `firebase deploy` must do it from `main`, not a branch.
- **Deals are now server-only at the rules level** (#93): every deal write goes through `/api/deals` or `/api/v1/deals`; `src/lib/firestore/deals.ts` writers are dead code (kept, not deleted).
- **`updateDealServerSide` validates `stageId` against the deal's pipeline** and accepts `patch.terminal: "won"|"lost"` resolved to that pipeline's closed stage (#93). Quotes lifecycle and the AI Suite use `terminal`; a pipeline with no won stage leaves the linked deal untouched and does not mint a duplicate.
- **`dealOutcome(deal, pipelines)`** replaces the `"won"`/`"lost"` literals in dashboard, reports and attribution. Reports funnel is default-pipeline-only (follow-up). `find_deals` labels still resolve via the canonical `getStage` (follow-up).
- **Company rename does not propagate** to `contact.company`; the string refreshes on the next contact save that picks the company. Public-API PATCH/upsert that rewrite `company` null the `companyId` (`companyStringDrifts`).
- **A contact with a dangling `companyId`** would be refused client-side edits by `companyLinkInTenant()`; only reachable via a partial batch failure on company delete (retryable). None exist today.
- **Smart lists** store a `ConditionGroup`; the evaluator moved to `src/lib/contacts/conditions.ts` (isomorphic) and `src/lib/workflows/conditions.ts` re-exports it. Export uses the visible (filtered) set; bulk email/call keep their own audience picker — PR (b).
- **Snapshots** strip `folderId` on capture and null `trigger.pipelineId` / `move_stage.config.pipelineId` on apply.
- **Gate fragility under load** (four parallel builders on one runner): vitest `hookTimeout` 10s and one `toHaveCount` on 5s tripped on three PRs — raised to 30s in #95. The shared E2E fixture tenant is purged by any concurrent CI/local Playwright run; builders serialised on port 3100.
- **Browser evidence:** `evidence/sp1/<letter>-*/` — frames extracted from Playwright traces of the real specs run against a local standalone build of `main` (7ee08ae) on the E2E fixture tenant; `a-smart-lists/` was captured earlier on #91's build (local standalone build of #91 driven through the E2E harness on the fixture tenant — the Chrome session's login is origin-bound to crm.crestahq.com). Screenshots on #1000 itself follow the next production deploy (this goal forbade deploying).

## Follow-ups (not in SP1 scope, surfaced by review)

- Reports funnel is default-pipeline-only; `find_deals` AI labels use canonical stage names.
- CSV export shows a former member as blank where the UI says "Former member"; CSV import has no assignee column.
- A crash between run-doc `completed` and the activity write leaves that run without an `automation_completed` row.
- Contacts: tags column + columns manager (C1); opportunities list view (O4); bulk complete/delete tasks (T4); bulk email/call dialogs still use their own audience picker (C10).
- Roster cache (`use-sub-account-members`) is module-level and not cleared on sign-out.
- GHL-side column of this ledger was written from product knowledge; the GHL tab was logged out all session — verify side-by-side on the next pass.
