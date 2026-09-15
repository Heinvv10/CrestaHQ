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
- **No new env vars** — snapshots are server-only (default-deny). The share
  links below added explicit deny rules; deploy rules with the PR.

### Share links + import (SP13 b)

GHL's "Shared / Imported snapshots". An owner shares a snapshot as a link;
another agency's owner opens it and imports a **copy** into their own library.
Logic in [src/lib/snapshots/share.ts](src/lib/snapshots/share.ts); routes are thin.

- **Share** `agencies/{a}/snapshots/{s}/shares/{shareId}` stores `tokenHash`
  (sha256 of a 32-byte base64url token), `expiresAt` (1/7/30 days, default 7),
  `singleUse`, `usedCount`, `revokedAt`. **The raw token is never stored** — it
  exists only in the create response's URL
  (`${NEXT_PUBLIC_APP_URL}/agency/snapshots/import?token=…`). Lose it and the
  only move is revoke + re-share.
- **Index** `snapshotShareIndex/{tokenHash}` → `{agencyId, snapshotId, shareId}`
  so import resolves a token with one read, no collection-group index. Revoke
  deletes it; import still re-checks the share's `revokedAt`.
- **Import** runs in one transaction: every link refusal (unknown, revoked,
  expired, used, source gone) is the same 404 `Invalid or expired link`; the
  owning agency gets 409. The copy gets the importer's `agencyId`/`createdByUid`,
  `sourceSubAccountId: null`, and `importedFrom` — the ONLY source ids it may
  carry. The payload is deep-scrubbed on the way in: nested
  `agencyId`/`subAccountId`/`createdByUid` keys dropped, strings equal to a
  source tenant id nulled, and workflow nodes run through apply's
  `sanitizeNodes` (source member uids, template and pipeline ids). Opaque source
  doc ids that apply already remaps (`sourceId`, `trigger.formId`) stay.
- **Applying** an imported snapshot is identical to an own one — the new
  sub-account form's picker lists both.
- **Routes** (owner-only): `POST /api/agency/snapshots/[snapshotId]/shares`,
  `GET /api/agency/snapshots/shares`,
  `DELETE /api/agency/snapshots/[snapshotId]/shares/[shareId]`,
  `POST /api/agency/snapshots/import`. `GET /api/agency/snapshots` now returns
  `importedFrom` so the panel can split **My snapshots / Imported / Shared** tabs.
- **Import page** `/agency/snapshots/import` is session-gated like every
  `/agency` page. A logged-out recipient is sent to `/login?redirect=…`, which
  drops the token from the redirect target — so the page also accepts a pasted
  link when it has no `?token`.

**Not carried yet**: pipelines (`subAccounts/{id}/pipelines`). Apply therefore nulls a workflow's `trigger.pipelineId` and any `move_stage` step's `config.pipelineId` — like an unmapped `formId` — so a copied workflow fires on any pipeline (stage ids kept; the default pipeline's are shared) until the operator re-pins it. Also not carried: booking pages,
per-channel AI config (the `aiAgent/{channelId}` docs — the persona travels, the
channel toggles do not, deliberately: a new workspace must not start replying to
customers before the operator reviews the imported persona).
