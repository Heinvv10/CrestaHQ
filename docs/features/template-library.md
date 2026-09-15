# Template library — single-entity agency templates

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

GoHighLevel "Template Library" parity, scoped: the agency owner saves **one**
workflow, email template or form from any sub-account into an agency-level
library, then pushes it into one or more sub-accounts. Where a
[snapshot](snapshots.md) copies a whole sub-account's config, a library
template carries a single proven asset. It **reuses snapshot capture/apply** —
there is no second stripping or remapping implementation.

- **Storage**: `agencies/{agencyId}/templates/{templateId}`
  ({@link AgencyTemplateDoc} in [src/types/templates.ts](../../src/types/templates.ts)):
  `kind` (`workflow` | `email` | `form`), `name`, `description` (≤300),
  `tags` (≤10), `sourceSubAccountId`, `payload` (a `SnapshotPayload` holding
  only that entity), `version` = `SNAPSHOT_VERSION`. Agency-owner read, every
  write via the owner-only routes (rules `allow write: if false`).
- **Capture** ([src/lib/templates/capture.ts](../../src/lib/templates/capture.ts))
  — `captureEntity(db, { agencyId, subAccountId }, kind, entityId)`. Uses
  `stripDoc` from the snapshot capture, so tenancy stamps, `workflow.stats`
  and `form.submissionCount` never travel. Refuses with 404 when the
  sub-account is not in the caller's agency **or** the entity is not in that
  sub-account (one status on purpose — a tenant must not learn which ids are
  live elsewhere). `email` means a `message_templates` doc with
  `type: "email"`; SMS templates are out of scope. **A form-triggered workflow
  also carries its trigger form** (when it is in the same sub-account) so
  apply's `formId` remap keeps the pair linked on the target — the UI says
  "includes its trigger form".
- **Push** ([src/lib/templates/push.ts](../../src/lib/templates/push.ts)) —
  `applySnapshot` unchanged per target: create-only, fresh ids, workflows
  arrive as **drafts**, source-scoped references (`pipelineId`,
  `bookingPageSlug`, WhatsApp template ids, assignee uids) nulled. Each target
  is re-anchored to the caller's agency; a foreign id is a per-target failure,
  not a thrown error, so one bad id never hides the rest. Results:
  `[{ subAccountId, ok, error?, created: { forms, messageTemplates, workflows } }]`.
- **Routes** (all `requireAgencyOwnerAny`; agency from claims):
  `GET/POST /api/agency/templates` (summaries without payload / capture),
  `PATCH/DELETE /api/agency/templates/[id]` (metadata only — the payload is
  immutable; re-save from the source to refresh it),
  `POST /api/agency/templates/[id]/push` (`subAccountIds`, 1–50, de-duplicated).
- **UI**: `/agency/templates` ("Template library", sidebar entry after
  Sub-accounts) — kind tabs, tag filter, search, card grid, Push dialog with
  a sub-account checklist and per-target results, Edit, Delete. "Save to
  library" buttons ([save-to-library-dialog.tsx](../../src/components/templates/save-to-library-dialog.tsx))
  sit on the sub-account workflow list, the email rows of `/sa/[id]/templates`
  and the forms grid; the button renders only for the agency owner.
- **No new env vars.** Rules change: the `templates` match block — deploy
  `firestore:rules` (no index needed; the list orders by `createdAt` alone).

**Not carried**: SMS templates, products, custom fields, pipelines — use a
snapshot for a whole-config move.
