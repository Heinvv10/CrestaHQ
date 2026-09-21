# W1 — Workflow Operations

*Part of the [CRM gap programme](README.md).* Goal: every business has its automations running again
now that GHL is stopped. Mostly activation, one code slice.

## Scope

| # | Item | Kind | Owner of the go |
|---|---|---|---|
| 1a | Workflow folders | code — one PR | Level-3 merge (greenfield, #1000 only) |
| 1b | Blitz WhatsApp on a sendable WABA | external | **Hein** (Meta Business Suite, card, SIM) |
| 1c | Blitz review templates approved on the new WABA | external | Hein submits from LeadStack UI; Meta approves |
| 1d | Blitz PE, PTA and Post-Resolution flows activated | activation | **Hein**, per flow |
| 1e | Velocity Post-Resolution flow activated | activation | **Hein** |
| 1f | Vortex sender settled (SMTP mailbox) | external | **Hein** |
| 1g | Vortex 7 internal flows reviewed against Vortex's pipelines, then activated | activation | **Hein**, per flow |
| 1h | Trigger/node additions a flow in 1d–1g cannot run without | code — only if found | Level-3 per PR |

**Not in W1:** the 3 Vortex WhatsApp nudges (no Vortex number), the 31 Brightsphere demo templates,
ONT Appliances' 6 drafts (tenant has no channel and no runs — plan with the tenant), goal events,
per-step conversion, send windows (all W3).

## 1a — Workflow folders (first implementation slice)

**Why first:** 38–44 drafts per tenant; the list is where 1d–1g happen.

**Model.** `WorkflowDoc.folderId?: string | null` (absent = unfiled, so every existing doc is valid
unchanged). Folders at `subAccounts/{id}/workflowFolders/{folderId}` `{ name, order, createdByUid, createdAt }`
— same shape and route pattern as `custom-field-folders`, which already passed review.

**Routes.** `GET/POST /api/sub-accounts/[id]/workflow-folders`, `PATCH/DELETE …/[folderId]`.
Deleting a folder unfiles its workflows in the same batch; it never deletes a workflow.
Moving a workflow is a `folderId` field on the existing workflow PATCH.

**Tenancy.** Admin SDK routes resolve membership through the existing sub-account guard; a `folderId`
from another sub-account is refused 404 on PATCH (no existence leak). Firestore rules: folders
readable by members, written only via the API.

**UI.** Workflows list groups by folder (collapsible, counts, "Unfiled" last); move via row menu;
folder create/rename/delete inline. Page width stays `max-w-5xl`.

**Snapshots.** Folders do **not** travel, matching custom-field folders: capture strips `folderId`
(`src/lib/snapshots/capture.ts`, "folders do not travel"), so applied workflows land Unfiled. SP13 has
since merged share links, portable snapshot files and a template library — re-read
`src/lib/snapshots/*` on current `origin/main` before touching it.

**Tests that must fail when wrong** (mutate and watch red):
- PATCH with a `folderId` belonging to sub-account B on sub-account A → 404, workflow unchanged.
- Delete folder → its workflows have `folderId: null`, count unchanged.
- Snapshot capture → no workflow in the payload carries a `folderId`.
- A workflow doc without `folderId` renders under Unfiled (legacy docs).

**Proof ladder:** fixture tests → CI green → blind `/review` → merge → Firestore rules + indexes deployed
from `main` on Hein's go (orchestrator first checks no open PR carries rules that main lacks) → app deployed
after 17:00 with Hein's approval → folders created and a workflow moved on #1000 in the browser,
screenshot in the PR. No Blitz/Velocity/Vortex writes.

**Rollback:** field is optional and ignored by the engine; reverting the PR leaves folder docs orphaned
and harmless.

## 1b–1d — Blitz

Follow the Velocity recipe that worked on 2026-09-13 (new WABA, own card, no LeadConnector credit
line). The old Blitz WABA 2260746424740498 stays credit-line locked (#200).

1. Hein: new WABA + number with Blitz's own card, in the CrestaHQ Messaging portfolio; system user
   gets full control.
2. Connect in Blitz Settings → Messaging as default Cloud sender; subscribe webhook **after** connect.
3. Send one message from the inbox to a staff handset. **Gate: delivered on the handset.**
4. Submit the PE/PTA/post-resolution templates from LeadStack (not Meta directly — GHL-created
   templates misbehaved). Wait for approval.
5. Blitz WhatsApp AI agent **off** for the pilot (it answers button taps beside `wait_for_reply`).
6. Activate PE on one staff contact tagged with the trigger tag → confirm the button template and the
   reply branch on the handset → Hein activates for customers. Repeat for PTA, then Post-Resolution.

**Hard gate before any activation (read from prod 2026-09-15):** the PE, PTA and Post-Resolution
drafts on Blitz, and Post-Resolution on Velocity, trigger on `contact.tag.added` with a `has_tag`
filter but **no `trigger.tag`**, with `reentry: unless_active`. Per
[workflows.md](../features/workflows.md), that re-enrols a contact who already carries the tag
whenever *any other* tag is added (unless a run is already open). Blitz already has **1,327** contacts tagged `review-request-pe`,
**3,762** `review-request-pta` and **11** `issue-resolved` (imported from GHL). One bulk tag on those
contacts would send ~5,000 review asks. Before activating: set `trigger.tag` to the filter's tag, decide
`once_ever` vs `unless_active` (Velocity accepted "a returning customer is never asked twice"), and re-read the doc from Firestore.

**Open question for 1d (settle before step 6):** what writes Blitz's trigger tag now that GHL's
"Service Issue Resolved - tag" flow is gone? If nothing does, the review flows activate and never
enrol. Candidates: a staff action in the inbox, or the W2 ticket close. Until W2, a manual tag.

## 1e — Velocity Post-Resolution

3 nodes (`send_whatsapp → add_tag → goal`). Same unset `trigger.tag` hazard and same trigger-tag question as Blitz. Activate on a staff
contact first, then customers.

## 1f–1g — Vortex

1. Hein connects a Vortex SMTP mailbox (Settings → Email). `notify` sends email. Without a configured
   sender it does **not** fail: it logs `error:email_not_configured` on that node and the run continues,
   so the run still shows *completed*.
2. For each of the 7 flows: check every `pipeline.stage.changed` filter points at a stage that exists
   on Vortex's pipelines today, every `create_task` assignee is an active member, every `notify`
   recipient is Vortex staff. Fix in the builder; record changes in this doc's evidence table.
3. Test-enrol each on a Vortex staff contact (test dialog exists). **Gate: expand the run and confirm
   no node result starts with `error:` or `skipped:`** — overall *completed* hides skipped sends.
4. Hein activates.

## Found while planning, not in W1 scope

`Velocity — QContact Installation Request` is **active** with trigger tag `qcontact-install`, and
0 Velocity contacts carry that tag. Either the QContact sync does not write the tag or the flow is
dead. Worth one read of the sync before assuming it runs.

## Done when

- Blitz, Velocity and Vortex each show `runs > 0` since activation in a read-only Firestore count.
- Every activated customer-facing flow has one delivered message confirmed on a handset or inbox,
  screenshot redacted per the PII rule.
- Folders PR merged, deployed, walked on #1000.

## Evidence

| Item | Date | Proof |
|---|---|---|
| Review drafts' trigger hazard fixed: the 4 drafts (Blitz PE, Blitz PTA, Blitz Post-Resolution, Velocity Post-Resolution) patched to `trigger.tag` = their filter tag, `reentry: once_ever`, still **draft** | 2026-09-21 | Orchestrator's production read, verified by re-reading the docs after the patch |
