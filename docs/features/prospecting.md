# Prospecting

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md). Plan and PR sequence: [docs/programme/prospecting-module.md](../programme/prospecting-module.md) (plan, PR #244).*

Status: **PR 1 of 6** — gate, quota, collections, saved lists. No report is generated and no message is sent yet.

## What exists

- **Gate** `prospectingEnabledByAgency` (off by default, in `PLAN_GATE_KEYS`, hide-override `prospectingHiddenWhenDisabled`) and the monthly `prospectingReportQuota` (0–1000, default 50 via `lib/prospecting/quota.ts`), both set in the agency Manage dialog. See [feature-gates.md](../architecture/feature-gates.md).
- **Saved lists** — Get Leads' results bar "Save as list" creates a `prospectLists` doc; imports from that result set stamp `contacts.prospecting.listId`. `GET`/`POST /api/sub-accounts/[id]/prospecting/lists`, member auth, 403 `gate_off` while off. Details in [get-leads.md](get-leads.md#save-as-list-prospecting-gate).
- **Page** Sidebar → Prospecting (`/sa/[id]/prospecting`): locked / empty / list states, driven by the GET route.
- **Contacts carry the prospect** — `source: "prospecting"`, tags `["prospecting", <batch>]`, and `contacts.prospecting` `{ listId?, placeId?, website?, rating?, reviewsCount?, category?, approachedAt: null, lastReportId: null }`. The public API returns it (`prospecting`, snake_case, null when absent) and `PATCH /api/v1/contacts/:id` merges it field by field (Prospecting gate, own-sub-account `list_id`; `approached_at` / `last_report_id` read-only — see [public-api.md](public-api.md#contacts-the-prospecting-map)).
- **Collections** `prospectLists`, `prospectReports` (type + rules only; the PR 2 runner writes it), `prospectReportShares` (no client access). See [firestore-collections.md](../architecture/firestore-collections.md).

## Not yet

Report runner and sections, quota enforcement, share page `/r/[shareId]`, ApexGEO sections, workflow trigger and merge tags, approach guard, mystery shop, ApexSignal push — each its own PR in the plan. `POST /api/v1/contacts` ignores a `prospecting` field (like any unknown top-level field) and `POST /api/v1/contacts/upsert` refuses it with a 400 — ApexSignal's push (PR 6) either PATCHes after create or extends one of them.
