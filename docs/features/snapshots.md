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
- **Workflow destinations do not travel either** (`sanitizeNodes` in apply, so
  EVERY apply path — same-agency, template push, share import, file import —
  gets it): a `notify` step with a typed address is reset to `recipient:
  "owner"` with `to` blank (the source client's inbox must not receive the
  target client's leads; `account_contact` is kept since it resolves on the
  target), and a `webhook` step's `url` is blanked (the engine skips a
  non-http(s) URL). Reconfigure both before activating an applied workflow.
  A form's post-submit `settings.redirectUrl` is blanked the same way
  (`sanitizeForm`) — it points at the source client's site.
- **Routes**: `GET/POST /api/agency/snapshots` (list summaries + counts / capture),
  `POST /api/agency/sub-accounts/[id]/apply-snapshot`. Owner-only.
- **UI**: [snapshots-section.tsx](src/components/agency/snapshots-section.tsx) on
  `/agency/sub-accounts`, plus the picker on the new-sub-account page.
- **No new env vars** — snapshots are server-only (default-deny). The share
  links below added explicit deny rules; deploy rules with the PR.

### Share links + portable files (SP13 b)

GHL's "Shared / Imported snapshots". An owner shares a snapshot as a link;
whoever opens it downloads a **portable snapshot file** and imports it on their
own deployment with **Import from file**. A production deployment holds ONE
agency (signup mints an agency only at bootstrap; a buyer copy is its own
Firebase project), so the file is the path that actually crosses tenants; an
owner of another agency on the *same* deployment can also import the link
directly. Logic in [share.ts](src/lib/snapshots/share.ts) (mint / list /
revoke / same-deployment import), [share-redeem.ts](src/lib/snapshots/share-redeem.ts)
(token resolution, preview, download), [portable.ts](src/lib/snapshots/portable.ts)
(the scrub) and [snapshot-file.ts](src/lib/snapshots/snapshot-file.ts) (file
format + untrusted-file parser); routes are thin.

- **Share page** `/s/snapshot/{token}` is public (middleware pattern; no
  session, `noindex`, `no-referrer`). It shows the snapshot's name, counts and
  expiry, a **Download snapshot file** button (`GET /api/public/snapshots/{token}`
  — `Content-Disposition: attachment`, `Cache-Control: no-store`, no CORS), and,
  for a signed-in owner on this deployment, **Import into my agency**. Viewing
  is free; a download or an import each **count as one use**, so a single-use
  link downloads once. Not rate limited: the token is 256 random bits and the
  repo has no shared per-IP limiter for public routes (checkout, booking and
  the GBP feed each keep their own).
- **File format** `{ format: "leadstack-snapshot", version, name, exportedAt,
  payload }`, payload already scrubbed (below).
- **Import from file** (`POST /api/agency/snapshots/import-file`, owner-only)
  treats the upload as untrusted: 5 MB cap (413), `format` + integer `version`
  ≤ `SNAPSHOT_VERSION` (400), and a **whitelist parser** — each entity keeps
  only its known fields with the right types, unknown fields are dropped,
  strings are capped at 20k chars, an unknown node type or a missing required
  field refuses the whole file. The payload is then scrubbed **again** on the
  server before it is stored with `importedFrom: { importedAt, via: "file" }`.

- **Share** `agencies/{a}/snapshots/{s}/shares/{shareId}` stores `tokenHash`
  (sha256 of a 32-byte base64url token), `expiresAt` (1/7/30 days, default 7),
  `singleUse`, `usedCount`, `revokedAt`. **The raw token is never stored** — it
  exists only in the create response's URL
  (`${NEXT_PUBLIC_APP_URL}/s/snapshot/<token>`). Lose it and the only move is
  revoke + re-share.
- **Index** `snapshotShareIndex/{tokenHash}` → `{agencyId, snapshotId, shareId}`
  so import resolves a token with one read, no collection-group index. Revoke
  deletes it; import still re-checks the share's `revokedAt`.
- **Same-deployment import** runs in one transaction: every link refusal
  (unknown, revoked, expired, used, source gone) is the same 404 `Invalid or
  expired link`; the owning agency gets 409. The copy gets the importer's
  `agencyId`/`createdByUid`, `sourceSubAccountId: null`, and
  `importedFrom: { importedAt }` — no id of the sharing agency, its snapshot or
  the share. Download and import both leave through `toPortablePayload`: nested
  `agencyId`/`subAccountId`/`createdByUid` keys dropped; strings equal to a
  source tenant id nulled; every `sourceId` re-minted (a random UUID) with
  `trigger.formId` remapped through the same map so apply still links forms to
  workflows; `trigger.linkId`/`pipelineId`, WhatsApp `templateId`/`senderId` and
  task assignees nulled; forms and nodes go through apply's own
  `sanitizeForm` / `sanitizeNodes` so the file is already clean.
- **Workflow destinations are cleared and must be reconfigured** — the same
  `sanitizeNodes` rule as any apply (see "do not travel" above); a shared
  workflow would otherwise send the importer's contact data to addresses the
  sharer picked.
- **A multi-use link is a bearer link until it expires or is revoked** — anyone
  who holds it can download the file, and a file, once downloaded, can be
  imported anywhere any number of times. Prefer single use for one recipient.
  An imported snapshot cannot be shared on (409).
- **Applying** an imported snapshot is identical to an own one — the new
  sub-account form's picker lists both.
- **Routes** (owner-only): `POST /api/agency/snapshots/[snapshotId]/shares`,
  `GET /api/agency/snapshots/shares`,
  `DELETE /api/agency/snapshots/[snapshotId]/shares/[shareId]`,
  `POST /api/agency/snapshots/import`. `GET /api/agency/snapshots` now returns
  `importedFrom` so the panel can split **My snapshots / Imported / Shared** tabs.
- **Same-deployment import page** `/agency/snapshots/import?token=…` is
  session-gated like every `/agency` page (the share page links to it for a
  signed-in owner). A logged-out visitor goes to `/login?redirect=…`; the
  middleware puts path + query in `redirect` (the login form's `safeRedirect`
  still refuses anything off-origin), so `?token` survives sign-in — and is
  removed from the top-level `/login` query so it appears only there. The page
  waits for the owner claim before refusing anyone (`useOwnerClaim`); a failed
  claim read shows a retry, not a refusal. A pasted link box remains as a
  fallback when the page has no `?token`.

**Not carried yet**: pipelines (`subAccounts/{id}/pipelines`). Apply therefore nulls a workflow's `trigger.pipelineId` and any `move_stage` step's `config.pipelineId` — like an unmapped `formId` — so a copied workflow fires on any pipeline (stage ids kept; the default pipeline's are shared) until the operator re-pins it. Also not carried: booking pages,
per-channel AI config (the `aiAgent/{channelId}` docs — the persona travels, the
channel toggles do not, deliberately: a new workspace must not start replying to
customers before the operator reviews the imported persona).
