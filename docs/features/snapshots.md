# Snapshots — agency config templates

GoHighLevel-style reusable config templates, and the answer to "how do I onboard
a new client fast". An agency owner captures one sub-account's CONFIG into an
agency-scoped doc, then stamps it onto another sub-account in one click — at
creation time (the **new sub-account page has a snapshot picker**) or later from
the Snapshots panel. **This already exists — do not re-propose building it.**

- **Storage**: `agencies/{agencyId}/snapshots/{snapshotId}` ({@link SnapshotDoc}
  in [src/types/snapshots.ts](src/types/snapshots.ts)). Agency-owner read; all
  writes go through Admin-SDK routes. `SNAPSHOT_VERSION` on every doc so a schema
  change migrates on apply rather than breaking old snapshots.
- **Payload**: forms, message templates, products, workflows, custom-field
  definitions, and the AI agent persona. **Never** contacts, deals, submissions,
  workflow runs, or credentials.
- **Capture** ([src/lib/snapshots/capture.ts](src/lib/snapshots/capture.ts)) —
  pure reads. Strips tenancy stamps (`id`/`agencyId`/`subAccountId`/
  `createdByUid`/`createdAt`/`updatedAt`), keeping the original id as `sourceId`
  so apply can remap. Resets runtime counters (`workflow.stats`,
  `form.submissionCount`).
- **Apply** ([src/lib/snapshots/apply.ts](src/lib/snapshots/apply.ts)) —
  **CREATE-ONLY**: fresh ids, never overwrites/updates/deletes, so it is safe
  against a live sub-account. Forms are written first to build an old→new id map;
  workflow `trigger.formId` is remapped through it (or nulled). Workflows always
  arrive as **drafts** so nothing enrolls a contact before review.
  `whatsapp_template` nodes have `templateId` nulled — the target has its own
  Meta-approved templates, so the source id would dangle.
- **Two entities need a pre-read to honour create-only**, because they are not
  addressed by a fresh auto-id: **custom fields** are keyed by `key` (unique per
  subAccount+entity), so a key the target already defines is skipped rather than
  redefined — two definitions would fight over the same `contact.customFields`
  slot. Their `folderId` is stripped on capture: custom-field folders do not
  travel in a snapshot yet, so every applied field lands in General; and the **AI persona** lives at the fixed path `aiAgent/profile`, written
  only when the target has none, so apply can never replace a tuned live agent.
- **What deliberately does NOT travel in the persona** ({@link SnapshotAiProfile}):
  `businessName` (source client's trading name — blanked so the prompt falls back
  to the target's own name), `escalationNotifyEmail` (an inbox belonging to the
  source client — carrying it routes one client's leads to another's team), and
  `websiteUrl`/`websiteKb`/`websiteKbFetchedAt` (a Firecrawl scrape of the source
  client's homepage — factual content about the wrong business is worse than no
  KB, because the agent states it confidently). What travels is the reusable
  half: persona prompt, hours, timezone, escalation keywords.
- **Routes**: `GET/POST /api/agency/snapshots` (list summaries + counts / capture),
  `POST /api/agency/sub-accounts/[id]/apply-snapshot`. Owner-only.
- **UI**: [snapshots-section.tsx](src/components/agency/snapshots-section.tsx) on
  `/agency/sub-accounts`, plus the picker on the new-sub-account page.
- **No new env vars, no rules deploy** — snapshots are server-only (default-deny).

**Not carried yet**: pipelines (`subAccounts/{id}/pipelines`). Apply therefore nulls a workflow's `trigger.pipelineId` and any `move_stage` step's `config.pipelineId` — like an unmapped `formId` — so a copied workflow fires on any pipeline (stage ids kept; the default pipeline's are shared) until the operator re-pins it. Also not carried: booking pages,
per-channel AI config (the `aiAgent/{channelId}` docs — the persona travels, the
channel toggles do not, deliberately: a new workspace must not start replying to
customers before the operator reviews the imported persona).
