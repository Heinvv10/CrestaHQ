# SP0-C — CrestaHQ's own workflows live on #1000

**Date:** 2026-09-07 · **Depends on:** SP0-A (harness, merged), SP0-B (Google + Paystack, live)
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP0 · Parent: [sp0.md](sp0.md)

SP0-C takes CrestaHQ's own automation off GoHighLevel and onto crm.crestahq.com.
It grew during grilling from "rebuild one workflow" into five code changes plus
four workflow rebuilds, because the one workflow depends on a trigger LeadStack
does not have and three more published workflows appeared after the export the
original plan was written from.

---

## What is actually in GHL today

Observed in the GHL builder 2026-09-07, sub-account **CrestaHQ / Somerset West**
(`jEr9SOZnEyVsi8oK2Vnj`, formerly Brightsphere). **Four** published workflows, not
one — the `docs/WORKFLOW_RECONSTRUCTION.md` table says one because the ApexSignal
export predates 2026-08-24.

### 1. `Audit clicked → Contacted + notify` (2 enrolled)

```
Trigger Link Clicked (no filters)
  → Add Tag
  → Update opportunity
  → Internal Notification
  → END
```

- Tag is `opened-audit`. **Proven, not assumed:** exactly two contacts in
  `ghl-export-data/brightsphere/contacts.ndjson` carry it, matching GHL's
  "Total enrolled: 2".
- Opportunity moves to `Contacted` in *Marketing Pipeline*
  (`config/pipelines.json`: New Lead → Contacted → Qualified → Proposal Sent →
  Negotiation → Closed).
- The trigger links are per-prospect audit reports —
  `Audit — EDC Engineers & Contractors` → `prod.analyzemy.business/#/share/report/…`
  (`config/links.json`, one link per business).
- Internal Notification goes to the only user on the account (Hein,
  `config/users.json`).

### 2–4. The three WhatsApp campaigns (28 / 17 / 17 enrolled)

All three are the same three-node shape, created 2026-08-24:

```
Contact tag — "Tag added includes <tag>"
  → WhatsApp (template, branches on, from +27 78 435 6159)
      ├── Delivered   → END
      └── Undelivered → END
```

| Workflow | Trigger tag | Template |
|---|---|---|
| `CrestaHQ WA — audit offer` | `cresta-send-audit-offer` | `cresta_audit_offer (en)` MARKETING |
| `CrestaHQ WA — no website` | `cresta-send-no-website` | `cresta_no_website (en)` MARKETING |
| `CrestaHQ WA — review gap` | `cresta-send-review-gap` | `cresta_review_gap (en)` MARKETING |

Template bodies use per-contact custom fields: `cresta_business`,
`cresta_reviews`, `cresta_trade`, `cresta_metro`, `cresta_benchmark`
(plus `cresta_finding`, written by the sender at send time).

**Both delivery branches terminate.** Nothing happens on either — see the
delivery-branching ruling below.

### The sender

`~/Workspace/ApexSignal/scripts/cresta/send_batch.py` is what makes these run: it
picks the day's batch, then `POST /contacts/{id}/tags` against GHL's API. The tag
*is* the send trigger. `backfill_fields.py` fills the `cresta_*` custom fields;
`push_ghl.py` holds the API client. Moving the campaigns means pointing that
script at CrestaHQ's public API.

---

## Decision summary (grilled 2026-09-07)

**Verdict:** Proceed with constraints.

### Decided

1. **Senders become a registry, not a single field.** A sub-account gets
   `whatsappSenders[]` (id, label, rail, number, credentials ref, `isDefault`),
   and `whatsapp_template` gets an optional `senderId` that falls back to the
   default when unset. Rationale: GHL's own send node has a
   `SELECT FROM PHONE NUMBER` dropdown, so one-rail-per-tenant
   (`resolve-provider.ts:19-24`) is already *worse* than the thing we claim
   parity with — and more bridge options are being built. Existing workflows
   carry no `senderId` and keep working unchanged.
   **Resolution happens in exactly one function** that readiness, template
   approval (`isTemplateApprovedFor` is rail-specific) and dispatch all call, so
   they cannot disagree about which sender is in play. This repo has already
   shipped a bug where one gate admitted a rail and the next refused it.
2. **The number does not have to stay the same.** +27 78 435 6159 stays on GHL;
   #1000 proves the flows on a sender of its own. No WABA migration in SP0-C.
3. **The public API fires workflow triggers** on tag-add and contact-create, the
   same as the dashboard — routed *through* `updateContactServerSide` so there is
   one tag-diff-and-fire path, not a copy of it.
   Paired guard: a per-key enrolment cap (50/hour) that **refuses** rather than
   truncates, so a runaway `PATCH` loop fails loudly instead of WhatsApping 500
   real businesses.
4. **No delivery branching.** `whatsapp_template` stays a linear step. Recorded
   as an open parity gap with the evidence that both GHL branches are terminal
   today. Revisit when something needs to act on a failed delivery — probably the
   first real use of the multi-sender registry.
5. **Tracked links use a per-contact token.** One link record (destination,
   label, sub-account scoped) plus a token minted at send time; `/l/{token}`
   resolves to (link, contact), records the click, fires `link.clicked`, 302s.
   Per-contact destination override covers this campaign's unique report URLs.
   Reuses the HMAC pattern already in `src/lib/reviews/feedback-token.ts` +
   `src/app/r/[token]/page.tsx` rather than inventing a second one. A tokenless
   link still works; the click is then attributed to the link only.
6. **Done = a real WhatsApp on Hein's own number**, driven end to end by an API
   tag write, plus a spec that fails when any link in the chain breaks, plus the
   side-by-side GHL screenshots. **Cutting the live campaign over** — pointing
   `send_batch.py` at CrestaHQ and running a real prospect batch — is a separate,
   human-gated step, not a merge criterion.

### Proven assumptions

Verified in this repo at `caefb09` and in the live GHL account, 2026-09-07.

- **`contact.tag.added` does not fire from the public API.**
  `PATCH /api/v1/contacts/:id` writes `tags` straight to Firestore
  (`src/app/api/v1/contacts/[id]/route.ts:89`) and emits only a `contact.updated`
  webhook; `updateContactServerSide`
  (`src/lib/server/contacts-service.ts:169-215`) is the sole path that diffs tags
  and fires, and only the dashboard route calls it. As shipped, ported campaigns
  would enrol nobody.
- **Custom fields cannot be merged into messages.**
  `src/lib/automations/merge-tags.ts:60-88` supports a closed set — contact
  name/email/phone, owner, workspace, booking and unsubscribe links. No
  `{{contact.customFields.x}}` syntax exists. All three templates need five.
- **The bridge rail cannot send templates.** `provider.ts:37-42` declares
  `bridge → supportsTemplates: false`, and `whatsapp_template` skips outright on
  a rail without templates (`engine.ts:335`).
- **`whatsapp_template` is linear.** Every outcome — opt-out, no phone, not
  configured, not approved, quota, send error, success — returns
  `{ kind: "next" }` (`engine.ts:309-404`). Only the log string differs.
- **No tracked link, shortlink or click tracking exists anywhere.** The one
  token-redirect route (`src/app/r/[token]/page.tsx`) is the Google-review
  feedback page and records no clicks.
- **`notify` is email-only** (`engine.ts:656-703`), recipients
  owner / account-contact / custom. GHL's Internal Notification is the same shape.
- **`move_stage` writes `contacts/{id}.pipelineStage`** (`engine.ts:587-596`)
  against a fixed canonical six-stage pipeline (`src/types/deals.ts:3-24`) whose
  second stage is already `contacted`. Per-tenant customisation is
  label/order overrides only — there is exactly one pipeline per sub-account.
- **Templates are managed in-app** at `subAccounts/{id}/whatsappTemplates/{id}`
  with per-rail approval, surfaced by
  `src/components/ai-agents/whatsapp-templates-manager.tsx`; the builder's picker
  is fed by `workflow-builder-loader.tsx:79-122`.

### The gap that changed the scope

SP0-C as briefed was "rebuild one workflow and take screenshots". The workflow's
trigger does not exist in LeadStack, and three more published workflows exist that
the plan never saw. Recorded so the cost is visible: SP0-C now contains five code
changes, two of which (sender registry, API-fired triggers) touch outbound
messaging.

### Remaining risks

- **API-fired triggers make outbound sends reachable from a script.** The
  enrolment cap is the only brake inside CrestaHQ; ApexSignal's ledger,
  suppressor and manifest check remain the outer one.
- **Meta template approval is Meta's decision and takes time.** The three
  `cresta_*` templates must be re-submitted against CrestaHQ's own WABA before
  the WA half can be proven. Copy is already written and approved once, so this
  is expected to be routine — but it is not in our control and it gates the
  proof, so it starts first.
- **The three campaigns keep running on GHL** until a human-gated cutover. Until
  then "CrestaHQ runs on crm.crestahq.com" is only true for the audit workflow.
- **The delivery-branch gap is deliberate** and will be visible in any
  side-by-side screenshot of the WA nodes.

### Execution guardrails

- Branch `feat/sp0c-*` per PR, in `../CrestaHQ-wt-sp0c`. Never `main`. Stage
  explicit paths — the shared checkout carries other sessions' work and is
  currently 11 commits behind `origin/main` with 115 staged deletions that are
  not ours.
- Every gate stays blocking: `pnpm ci:check`, gitleaks, the Playwright job.
- Blind `/review` per PR; `review-team` over 500 lines.
- Every spec mutation-proven before it counts as done.
- No credential in the repo; sender credentials follow the existing
  `subAccounts/{id}/private/*` pattern, never the member-readable doc.

---

## DAG

Five PRs. 1–3 are independent and can run in parallel; 4 needs 1–3; 5 needs 4.

```
SP0-C-1  tracked links ────┐
SP0-C-2  sender registry ──┼──▶ SP0-C-4  workflows rebuilt on #1000 ──▶ SP0-C-5  cutover
SP0-C-3  API triggers +    ┘        (+ side-by-side screenshots)          (human-gated,
         custom-field merge tags                                           out of this PR set)
```

| PR | Contents | Gate to merge |
|---|---|---|
| **SP0-C-1** | Link CRUD per sub-account, per-contact click token, `/l/{token}` redirect + click record, `link.clicked` trigger, builder support | `pnpm ci:check` · Playwright · gitleaks · spec mutation-proven · blind `/review` |
| **SP0-C-2** | `whatsappSenders[]` on the sub-account, single resolver, optional `senderId` on `whatsapp_template`, settings UI, node picker | same, plus a spec proving a node-level `senderId` overrides the default and an unset one does not |
| **SP0-C-3** | Public API routed through `updateContactServerSide`; triggers fire on tag-add + create; per-key enrolment cap that refuses; `{{contact.customFields.*}}` merge tags | same, plus a spec proving the cap refuses at the boundary rather than truncating |
| **SP0-C-4** | Four workflows rebuilt on #1000; `cresta_*` custom fields defined; templates submitted and approved; side-by-side GHL screenshots | same, plus a real WhatsApp received on Hein's own number, driven by an API tag write |
| **SP0-C-5** | `send_batch.py` pointed at CrestaHQ; supervised first batch | **human gate — Hein runs it** |

---

## Parity ledger

| GHL screen / behaviour | Observed in GHL | CrestaHQ today | Gap | Spec that proves it | Status |
|---|---|---|---|---|---|
| Trigger link clicked | `Audit clicked → …`, per-prospect links in `config/links.json` | nothing — no link, shortlink or click tracking | whole subsystem | SP0-C-1 | **planned** |
| Send-from number picker | `SELECT FROM PHONE NUMBER` on the WhatsApp node | one rail per sub-account, no sender choice | sender registry + node picker | SP0-C-2 | **planned** |
| Tag applied by an external system enrols a contact | GHL API `POST /contacts/{id}/tags` → workflow | public API writes tags without firing the trigger | trigger firing + enrolment cap | SP0-C-3 | **planned** |
| Per-contact fields inside a template | `{{contact.cresta_business}}` etc. | closed merge-tag set, no custom fields | merge-tag extension | SP0-C-3 | **planned** |
| `Audit clicked → Contacted + notify` | published, 2 enrolled | to rebuild | depends on SP0-C-1 | SP0-C-4 | **planned** |
| Three WA campaigns | published, 28/17/17 enrolled | to rebuild | depends on SP0-C-2, -3 | SP0-C-4 | **planned** |
| WhatsApp delivered/undelivered branch | both branches terminal | linear send node | deliberate gap, not built | — | **open, accepted** |
| Live campaign runs off CrestaHQ | `send_batch.py` → GHL | — | cutover | SP0-C-5 | **human-gated** |

A row is done only when the last two columns are filled and the spec is green in CI.
