# Firestore Collections

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*
| Collection | Scope | Notes |
|---|---|---|
| `agencies/{agencyId}` | agency-read | Agency profile + Stripe billing (one per deployment in v1). `aiModelPolicy` = the AI model allow-list + price ceiling. `brandColor` (`#RRGGBB`, prospect report redesign R2) drives `/report/[shareId]`'s header/accents/CTA; rejected at PATCH unless white text on it reaches WCAG AA (4.5:1), re-validated at read time by `resolveBrandColor()` (`lib/branding/brand-color.ts`). `usageRebillingEnabled` (usage rebilling master switch, read `=== true`, default off) + `usageRebillingSince` (stamped on off→on), written only by the owner's PATCH /api/agency — see [client-billing.md](../features/client-billing.md#usage-rebilling) |
| `agencies/{agencyId}/agencyMembers/{uid}` | agency-read | Owner / staff list |
| `agencies/{agencyId}/plans/{planId}` | server-only | Client Billing v1 plan docs (monthly price + feature-gate bundle + Stripe product/price ids). All access via the owner-only `/api/agency/plans` routes |
| `agencies/{agencyId}/snapshots/{snapshotId}` | server-only | Agency config template — forms/workflows/templates/products/custom-fields/AI-persona payload captured from one sub-account, applied to another. Carries no customer data and no credentials. All access via the owner-only `/api/agency/snapshots` + apply routes. An imported copy carries `importedFrom: { importedAt, via?: "file" }` (no source ids), `sourceSubAccountId: null`, re-minted `sourceId`s, and cleared workflow destinations |
| `agencies/{agencyId}/snapshots/{snapshotId}/shares/{shareId}` | server-only | Snapshot share link: `snapshotName`, `tokenHash` (sha256 hex — the raw token is never stored), `expiresAt`, `singleUse`, `usedCount`, `revokedAt` + tenancy stamps. Via `/api/agency/snapshots/[snapshotId]/shares` and `/api/agency/snapshots/shares` |
| `snapshotShareIndex/{tokenHash}` | server-only | `{agencyId, snapshotId, shareId, createdByUid, createdAt}` — resolves a presented share token to its share without a collection-group query. Deleted on revoke; read by the public `/s/snapshot/{token}` page + download and by `POST /api/agency/snapshots/import` |
| `agencies/{agencyId}/templates/{templateId}` | server-only | Template library — ONE workflow / email template / form (plus a workflow's trigger form) as a `SnapshotPayload`, with `kind`, `name`, `description`, `tags`, `sourceSubAccountId`. Owner-readable; all writes via the owner-only `/api/agency/templates` routes; pushed into sub-accounts through `applySnapshot` |
| `agencies/{agencyId}/apiKeys/{keyId}` | server-only | Agency API keys (Agency Agent API): same doc shape as a sub-account key (`name`, `mode` = `live`, `prefix`, `hashedSecret`, `scopes` = `["agent"]`, `defaultVersion`, `createdByUid` = the minting owner, `createdAt`, `lastUsedAt`, `revokedAt`, `revokedByUid`, `agencyId`). Level and agency come from the doc path (`findApiKeyByPrefix` is a `collectionGroup("apiKeys")` query on the `prefix` override). Minted and revoked only by an active agency owner via `/api/agency/api-keys` (mint refused while `agencies/{id}.agentApiEnabled` is off). `creations/{YYYY-MM-DD}` (`count`, the 10-a-day cap of `create_sub_account`) and `creations/name_{sha256(normalised name)}` (`subAccountId`, `accountNumber`, `expiresAt` +10 min, the duplicate-name lock) are written in the creating transaction (`lib/server/sub-account-key-create.ts`) and never swept. No client rule, so the default deny. See [agent-api.md](../features/agent-api.md#agency-keys) |
| `agencies/{agencyId}/agentCalls/{autoId}` | server-only | One `agent.call` row per call an agency key makes in a sub-account it reached: `action`, `keyId`, `keyPrefix`, `tool`, `subAccountId`, `access` (`read` / `write`), `at`, `expiresAt` (+30 d) — never the args. Written by `recordAgentCall` (`lib/api/agent-audit.ts`) before the call runs (a failed write fails the call); deleted by the daily api-cleanup collection-group sweep on `expiresAt`. No in-app reader yet; no client rule, so the default deny |
| `agencies/{agencyId}/apiRequestLogs/{autoId}`, `agencies/{agencyId}/apiIdempotency/{id}` | server-only | An agency key's request logs for refusals and agency-level calls (a call that reach lets through logs under its target sub-account), and its REST `Idempotency-Key` cache; same shape and `expiresAt` sweep as the sub-account collections of the same name. Default deny; no viewer |
| `paymentLinks/{id}` | members + agency owner read; server-only write | Paystack payment link paid into the sub-account's OWN Paystack: `invoiceId` (null = ad-hoc), `description`, `amountCents`, `currency` ("ZAR"), `mode` (`test`/`live`, the mode it was issued in; paid only in that mode), `token`, `active`, `status` (`open`/`paid`), `paystackReference`, `payerEmail`, `paidAt` + tenancy keys. Flips to paid only in the verified webhook. Spec: [w4-paystack-payment-links.md](../programme/w4-paystack-payment-links.md) |
| `paymentAttempts/{reference}` | members + agency owner read; server-only write | One per Paystack checkout, keyed by the reference, written before Paystack is called: `paymentLinkId`, `amountCents`, `currency`, `mode`, `keyFingerprint` (truncated SHA-256, never the key), `state` (`open`/`settled`/`refused`/`flagged`), `reason` + tenancy keys. The webhook records a payment only when the verifying key and Paystack's domain match it; a connection change flags open attempts. Spec: [w4-paystack-payment-links.md](../programme/w4-paystack-payment-links.md#test-mode) |
| `prospectLists/{listId}` | members + agency owner read; server-only write | One saved Get Leads result set: `name`, `query {businessType, placeName, lat, lng, radiusKm}`, `count`, `createdAt` + tenancy keys. Written only by `POST /api/sub-accounts/[id]/prospecting/lists`; imports that name it stamp `contacts.prospecting.listId`. See [prospecting.md](../features/prospecting.md) |
| `prospectReports/{reportId}` | members + agency owner read; server-only write | One prospect audit report: `contactId`, `status` (`queued`/`running`/`ready`/`failed`), `sections: []`, `headline`, `shareId`, `generatedAt`, `apexgeo` (`{ scanId, status, attempts, startedAt }` — the ApexGEO scan behind sections 5/7/8, or null) + tenancy keys. Written only by the report worker and the ApexGEO poll worker (Prospecting PR 2/3). The sub-account's ApexGEO key is at `subAccounts/{id}/private/apexgeoConnection` (Admin SDK only, generic `private/` deny rule) |
| `mysteryShops/{shopId}` | members + agency owner read; server-only write | One speed-to-lead mystery shop (Prospecting PR 5): `contactId`, `reportId`, `channel` (`email`/`call`/`whatsapp`/`form`), `target` (never public), `targetDomainTrusted` (email: colleagues at the target's domain may answer — it is the website's domain), `status` (`queued`/`sent`/`responded`/`missed`/`failed`/`refused`), `sentAt`, `respondedAt`, `responseMs`, `responseVia` (`email`/`answered`/`callback`/`whatsapp`), `senderAuth` (`pass` for our own answered call and a WhatsApp reply from the target number — Meta attests the sender; `unknown` for an email reply or a callback's caller ID — members see it as unverified), `authFailedReplyAt` (the first in-window reply whose sender failed the mail host's checks — it never settles the shop) / `disputed` (missed after such a reply — a member flag), `missedConfirmedAt` / `missedConfirmedByUid` (a member confirmed the miss after checking — only a confirmed miss is public; set by POST …/mystery-shop/[shopId]/confirm-missed, cleared if a late reply upgrades the shop), `autoReplyAt`, `jobValueCents`, `currency`, `niche`, `enquiryText`, `providerRef`, `failure` (code `bounced` for a delivery report naming our Message-ID, `undeliverable` for a Cloud `failed` receipt naming our WhatsApp message id — it was sent, so the cap slot is kept), `deliveredAt` / `readAt` (WhatsApp receipts, member card only; a WhatsApp miss can't be confirmed without `deliveredAt`), `optOutAt` (the business replied STOP to a WhatsApp shop — such a miss can't be confirmed), `sendUncertain` (the send may have gone out: kept `sent`, slot kept, never shown publicly as missed), `awaitingSync` / `timerRequeues` (an email shop is not called missed until the sub-account's `mailboxConfig.inboxCaughtUpAt` — the start of a sync pass that read the INBOX to its end — is past its window), `usageMonth` + tenancy keys. Written by the mystery-shop route, the IMAP / Vapi / WhatsApp Cloud reply matchers and the 24 h timer. Monthly cap counted at `subAccounts/{id}/usage/{month}.mysteryShops` |
| `prospectReportShares/{shareId}` | server-only (no client read) | Public share handle for a report: `reportId`, `revokedAt` + tenancy keys. Resolved only by the server's public report route, never by a client SDK |
| `agentProposals/{id}` | members + agency owner read, territory-scoped via the row's `territoryId` unless `targetScoped == false`; server-only write | Agent API approval queue: an agent call on a capability with an `approval` class lands here instead of running. `capability`, `approval`, validated `args`, `summary`, verbatim `preview` rows, `keyId`/`keyPrefix`, `status` (`pending` → `executing` → `executed`/`failed`; or `rejected`/`expired`; or `unsettled` = outcome unknown), `rev` (per-generation nonce every decision must echo), `gen` (the generation's id; a preview refresh bumps `rev` but keeps `gen`, so a reject naming it cannot land on another generation), `claimedAt` + `claimId` (the approve claim; settles and sweeps match on `claimId`), `contactId` / `territoryId` / `targetScoped` (from the capability's required `approvalTarget`; gate the read rule, the list route and the approver), `pinned` (values execute must act on, from `preview`), `priorAttemptSent` (sticky across generations once a late settle shows an earlier attempt did send; approve then needs `acknowledgePriorAttempt`), `expiresAt` (+7 d) + tenancy keys. Id = hash of (sub-account, capability, args) — not the key, so a re-proposal of the same action is the same row; superseded versions move to `history/{id}` (same read rule via `get()`). An agency key's row also carries `keyLevel: "agency"`; an agency tool's row (`set_sub_account_gate`, `apply_snapshot`, `assign_billing_plan`, `create_one_time_charge`, `resend_checkout_link`) has `subAccountId: null`, `targetSubAccountId` (the client), `targetScoped: false`, and is readable by the agency owner only (`canSeeProposal`); its id hashes `agency:` + agency id instead of the sub-account. Written by `dispatchAgentTool`, `POST /api/sub-accounts/[id]/agent-proposals/[proposalId]`, `POST /api/agency/agent-proposals/[proposalId]`, the key-revoke hook and the daily api-cleanup sweep. See `AGENT_API_V1_PLAN.md`. Deleting a sub-account is refused while a row on it (either keying) is `pending`, `executing` or `unsettled`; its decided rows, and their `history/` generations, are deleted with it. |
| `billingEvents/{id}` | server-only | Client Billing v1 append-only audit trail (plan assigned/switched, comped, activated, dunning transitions; usage close: `usage.frozen`, `usage.skipped`, `usage.withheld`; `usage.flagged` = a usage month that needs a person, listed under Client billing → Attention, deduped by id `usage-flag-{sa}-{month}-{hash}`) |
| `billingActivations/{provider}-{reference}` | server-only | Client Billing ledger: one row per provider payment (Stripe checkout session / Paystack transaction) that activated a plan, written in the same transaction as the activation. A redelivered payment finds its row and changes nothing. Survives re-assign/comp, which replace the `billing` map. |
| `billingAttention/{flagId}` | server-only | One per flagged payment: the email claim (created before sending, so a redelivery never re-sends) for both billing-event and order flags, and — for `payment.flagged`/`subscription.flagged` only — the resolution (`resolvedAt`/`resolvedByUid`/`resolvedByEmail`). Order resolutions live on the order (`attentionOpen`, `attentionResolved*`). Written only by `src/lib/server/billing-attention*.ts`. |
| `auditEvents/{id}` | agency owner + sub-account admin read; server-only write | Append-only "who changed what": `action`, `actor {type, id}`, `target {type, id}`, `changes [{field, before, after}]` (free-text values stored as `[redacted]`) + tenancy keys; `subAccountId: null` = agency-level, owner-only. Written only by `recordAuditEvent()` (`src/lib/audit`). Contract: [audit-events.md](audit-events.md) |
| `subAccounts/{subAccountId}` | members + agency owner | Workspace metadata; reserved fields for Workflow-Recipes Twilio/Resend/booking/sendWindow. `whatsappNumber` (E.164, optional, prospect report redesign R2) sets the public prospect report's WhatsApp CTA button; unset falls back to a connected WhatsApp Cloud sender's `displayPhoneNumber` (never a bridge sender's), via `resolvePublicReport`. `usageRebillingEnabled` (this client's usage rebilling switch, read `=== true`, default off; refused on unless the agency's switch is on) + `usageRebillingSince` (stamped on off→on), written only by the agency owner via the feature-gates PATCH, and switched off for every client when the master switch goes off (PATCH /api/agency) |
| `subAccounts/{subAccountId}/subAccountMembers/{uid}` | admins | Per-sub-account membership rows |
| `subAccounts/{subAccountId}/getLeadsSearches/{requestId}` | server-only | **Legacy, no longer written.** Recorded which sub-account submitted each async Get Leads search while search was a submit-then-poll flow; search is synchronous now. Existing rows are inert |
| `communityMagicLinkUses/{sha256}` | server-only | `{subAccountId, usedAt, expiresAt}` — one per consumed community magic link, created atomically at the verify POST so each link signs in once; deleted by the `api-cleanup` sweep once `expiresAt` passes |
| `userMemberships/{uid}/subAccounts/{saId}` | self-read | Denormalized index powering the sub-account switcher |
| `userMemberships/{uid}/agencies/{agencyId}` | self-read | Denormalized index for agency-level access |
| `users/{uid}` | self only | Slim profile (display name, photoURL, primaryAgencyId) |
| `appConfig/main` | active members | Bootstrap singleton: `firstAgencyId`, `firstAgencyOwnerUid` |
| `appConfig/aiModels` | active members read; server-only write | Cached OpenRouter model list `{models: [{id, name, promptPerM, completionPerM}], fetchedAt, lastAttemptAt}` — refreshed daily by QStash (`/api/cron/ai-models`) or single-flight when stale; last good copy kept on failure (see [ai-agents.md](../features/ai-agents.md#model-allow-list)) |
| `system/heartbeat` | server-only | Instance id + last-heartbeat timestamp (gitpage status checks) |
| `system/gitpageStatus` | active members read | Cached gitpage subscription state; drives the activate-banner UI |
| `invites/{auto}` | agency owner / sub-account admin | Typed invites (carry `subAccountId` + `subAccountRole`) |
| `contacts/{id}` | sub-account | Carries `agencyId`, `subAccountId`, `createdByUid`; optional `assignedToUid` (a `subAccountMembers` uid or null — rules refuse any other value) |
| `contacts/{id}/notes/{id}` | inherits | Free-text notes |
| `contacts/{id}/activities/{id}` | inherits | Typed events |
| `companies/{id}` | sub-account | GHL "Businesses". `{name, phone, email, website, address}` + tenancy keys. Members read/create/update via the client SDK; delete is admin-only and goes through `DELETE /api/companies/[id]`, which nulls `companyId` on every linked contact in the same batch. A contact links via `contacts.companyId`; on link the server copies the company's `name` into the legacy free-text `contacts.company`, so CSV export, quotes and webhooks read the string unchanged. Free-text values with no link keep `companyId: null`. **Renaming a company does not propagate** — `contacts.company` is a link-time copy; the string refreshes on the next contact save that picks the company. Conversely, a writer that changes `contacts.company` without a `companyId` (the public API PATCH / phone upsert) clears `companyId` rather than leaving a stale link. |
| `snippets/{id}` | sub-account | Saved replies (SP2 T3): `{name, body, type: "text"\|"email", subject (email only, else null), folder (free text or null)}` + tenancy keys. `body`/`subject` may carry merge tags (`lib/messaging/merge-tags.ts`), rendered when inserted into the composer. **Server-only** (rules deny all client access): every read and write goes through `/api/sub-accounts/[id]/snippets`, which validates and stamps the tenant keys. No composite index — one equality clause, sorted in the route. |
| `deals/{id}` | sub-account | One contact → many deals. `pipelineId` names the pipeline; absent = `default` (every pre-multi-pipeline doc). Optional `assignedToUid` (validated by the deals API) |
| `dealStageHistory/{id}` | server-only | Append-only: one row per stage a deal enters (`fromStageId: null` on create), written in the same transaction/batch as the deal write by every stage writer. `{dealId, pipelineId, stageId, fromPipelineId, fromStageId, fromStageEnteredAt, enteredAt, source, mode, territoryId, assignedToUid}` + tenancy keys; no PII, outlives a deleted deal. Read only by `/api/sub-accounts/[id]/reports/stage-history` (territory-scoped). Spec: [w3-stage-history](../programme/w3-stage-history.md) |
| `subAccounts/{id}/pipelines/{pipelineId}` | server-only | Deal pipelines with stages embedded (`{ id, label, tone, terminal? }[]`; `terminal` = `won`/`lost` drives `deal.won`/`deal.lost`). `pipelines/default` is seeded lazily on first read from the canonical six stages + the legacy `subAccounts/{id}.pipelineStages` label/order overrides, keeping the SAME stage ids. Read via `GET /api/sub-accounts/[id]/pipelines`; written only by those Admin-SDK routes and the GHL import start route (`import/ghl/start`, opt-in "Recreate my GoHighLevel pipelines": one pipeline per GHL pipeline at `pipelines/ghl_<ghlPipelineId>`, its stage names + appended Won/Lost (a GHL stage named Won / Lost / Closed Won / Closed Lost maps onto those), stamped `externalSource: "ghl"`, `externalId` and `externalStageIds {ghlStageId: stageId}`; a re-import reuses the doc in a transaction, only adds GHL stages it has not seen, never re-adds a stage the operator deleted, and when it cannot update the doc maps deals onto its existing stages rather than back onto the default). Deleting a stage / pipeline that still holds deals is refused (409) |
| `events/{id}` | sub-account | Calendar events. Booking-page events may carry `hostUids` (collective) and `serviceId`/`serviceName` (service pages) — server-written only; rules refuse them from clients. `isLong` (> 8 h) is written with the event's times and read by availability's long-event query. `source: "google"` (test with `isImportedEvent()`) = imported from a member's Google Calendar, owner in `importOwnerUid` (never `assignedToUid`/`hostUids`/`mode`/`publicTokenHash`); no importer writes it yet. Availability treats it as busy for its owner only (never on a hostless schedule); every other reader that books, pushes, reminds, feeds, links, counts, searches or answers the API/assistant skips it. Index `(subAccountId, source, startAt)` serves the assistant's upcoming count |
| `events/{id}/reminderSends/{offset_tokenHash}` | server only | Create-only claim per booking reminder (offset × schedule), so a QStash redelivery doesn't email twice. Deleted again when a send fails in a way a retry could fix |
| `tasks/{id}` | sub-account | Todos; optional `assignedToUid` (a `subAccountMembers` uid or null — rules refuse any other value) |
| `forms/{id}` | sub-account | Form config |
| `forms/{id}/submissions/{id}` | sub-account read, server-write | Inbound submissions; route stamps tenancy from the form doc |
| `usagePendingCharges/{chargeId}` | server-only | Usage rebilling close queue (`usage_{subAccountId}_{YYYY-MM}`): `subAccountId`, `month`, `createdAt`. Written in the same transaction that freezes the month on `subAccounts/{id}/usage/{YYYY-MM}.closed` (`totalCents`, `currency`, `lineItems`, `carryOutCents`, `chargeId`, or `skipped: true` when the month was not billable; `withheldAt` when a switch was off by the time the charge was minted); deleted once the `billingCharges` doc exists and its invoice email went (or was given up on, or the month was withheld because a switch went off first); no raw pay token is stored (`tokenHash: null` until an email mints one). A Paystack month with no email to open a payment page for stays queued, logged each day. `billingCharges/{id}` for these carries `kind:"usage"`, `usageMonth`, `lineItems`, `dueAt`, `remindedAt.{beforeDue,onDue,overdue}`, `emailedTo`, `invoiceEmailClaimedAt` — see [client-billing.md](../features/client-billing.md#usage-rebilling) |
| `usage/{subAccountId}/users/{uid}` | self/owner read | Email + SMS quotas |
| `mail/{id}` | server-only | Trigger-Email extension queue |
| `automations/{id}` | sub-account; admin-write | Recipe configs (one per attached form). Carries `agencyId`, `subAccountId`, `recipeType`, `trigger`, `config`, `enabled` |
| `message_templates/{id}` | sub-account; admin-write | Reusable email + SMS bodies with merge tags |
| `automation_executions/{id}` | sub-account read; server-only write | Per-firing run rows; the QStash callback executor mutates these |
| `contacts/{id}/messages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | SMS chat thread when the sub-account has dedicated Twilio enabled. Doc id = Twilio MessageSid for natural dedupe on retries. |
| `contacts/{id}/whatsappMessages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | WhatsApp chat thread (same model as `messages`). Populated by the WhatsApp inbound webhook + `/api/comms/whatsapp/send` + `/api/comms/whatsapp/send-template`. Doc id = Twilio MessageSid. |
| `contacts/{id}/scheduledMessages/{id}` | server-only (read and write) | "Send later" (SP2 T5). One booked conversation message: tenancy keys (`agencyId`, `subAccountId`, `createdByUid`), `contactId`, `channel` (email/sms/whatsapp/messenger/instagram), FINAL `body` (+ email `subject`, `inReplyTo`, `references`), `sendAt`, `status` (pending → sending → sent / failed / unconfirmed — attempted, outcome unknown — or cancelled), `failureReason`/`failureCode`, `dismissedAt` (failed/unconfirmed taken off the thread), booked at most 7 days ahead (QStash Free max delay), a delivery >15 min late fails as `delivered_late`, `qstashMessageId`, `sentMessageId`. Lives under the contact so it inherits the thread's lifetime (deleted with the contact) and needs no index. Booked/cancelled/listed by `/api/sub-accounts/[id]/scheduled-messages` (authorised like the send routes), fired by the QStash worker `/api/scheduled-messages/fire`, which re-runs every send-time check through `lib/server/conversation-send`. |
| `subAccounts/{id}/quietHoursHolds/{id}` | server-only (read and write) | An automated SMS/WhatsApp held for the workspace's quiet hours (review request, AI reply, missed-call text-back): `agencyId`, `subAccountId`, `contactId`, `payload` (`{kind: "review_request", request}` — what to re-run — or `{kind: "message", message}` — channel, to, body, senderId, source), `releaseAt`, `heldAt`, `status` (pending → releasing → released / skipped / failed; `superseded` when a newer held AI reply for the contact replaced it), `outcome`. Queried by `contactId` (single-field) to supersede. Written by `lib/comms/quiet-hours-hold.ts`, released once by the QStash worker `/api/comms/quiet-hours/release`, which re-checks opt-out before sending. Get-by-id only; no index. |
| `subAccounts/{id}/smartLists/{id}` | members read/create/update/delete | Saved contacts-list filter: `name`, `filters` (a workflow `ConditionGroup`, evaluated client-side by `lib/contacts/filter.ts`), plus `agencyId`, `subAccountId`, `createdByUid`. Tenant keys locked on update. No composite index — the list is read by subcollection path alone. |
| `subAccounts/{id}/media/{mediaId}` | members read; server-only write | Media Library file (SP13a): `name`, `folderId` (null = root), `storagePath` (`media/{subAccountId}/{mediaId}/{fileName}` in Firebase Storage), `contentType` + `size` read back from the bucket by `POST /api/sub-accounts/[id]/media` (never the client's), `downloadUrl`, `kind` (image/video/document), plus tenancy keys. The browser uploads the bytes directly under `storage.rules` (sub-account admin/agency owner, ≤25 MB, image/video/PDF, create-only; any member reads); register/rename/move/delete are admin-only routes over `lib/media/service.ts`. No composite index — read whole, ordered by `createdAt`. |
| `subAccounts/{id}/mediaFolders/{folderId}` | members read; server-only write | Media Library folder: `name`, `parentId` (null = root), tenancy keys. Delete is refused (409) while it holds files or sub-folders. |
| `subAccounts/{id}/emailSuppressions/{sha256(email)}` | server-only | Email suppression list: `email` (trimmed, lower-case), `reason` (`hard_bounce` / `complaint` / `manual`), `note` + tenancy keys. The doc id is the sha256 of the address, so `sendEmail` checks with one `get()`. Admin-only access via `/api/sub-accounts/[id]/email-suppressions`. Covered by the default-deny rule; no index. Spec: [w4-email-tracking](../programme/w4-email-tracking.md) |
| `subAccounts/{id}/workflowFolders/{folderId}` | server-only | Workflow-list folder: `name`, `order`, tenancy keys. A workflow points at one via optional `workflows.folderId` (absent/null = Unfiled; the engine never reads it). All access through the member-gated `/api/sub-accounts/[id]/workflow-folders` routes; delete unfiles its workflows in the same transaction. Does not travel in snapshots or template pushes — capture strips `folderId`, so applied workflows land Unfiled. |
| `subAccounts/{id}/whatsappTemplates/{id}` | members read; server-only write | WhatsApp message templates (v2). Carries the body + positional variables, Twilio `contentSid`, and the Meta approval `status`. Written by the `whatsapp-templates/*` Admin-SDK routes and the agent tools `create_whatsapp_template` / `submit_whatsapp_template` (same code, `lib/comms/whatsapp/template-create.ts` / `template-submit.ts`); status synced live by the QStash approval poll. |
| `subAccounts/{id}/snapshotApplies/{snapshotId}` | server-only | Forensic record of one `applySnapshot` run into this sub-account — `status` (`started`/`completed`/`failed`), `startedAt`/`completedAt`/`failedAt`, `error`. Doc id is the snapshot id (or, for a template push, the template id) so a retry overwrites the same record. Written by `applySnapshot` itself (best-effort — a failure writing it never masks the apply's real error); not read by any route or UI, Firestore-console only. |
| `broadcasts/{id}` | sub-account read; server-only write | Bulk-email batch metadata (template, audience filter, totals, status). One per "Send bulk email" action. |
| `broadcasts/{id}/sends/{contactId}` | sub-account read; server-only write | Per-recipient delivery row. Doc id = contactId for natural dedup. Status: queued/sent/skipped/failed. Carries Resend message id + error string. |
| `subAccounts/{id}/private/websiteLimits` | Admin SDK only (the generic `private/{docId}` deny rule) | Website builder limits, one doc per sub-account, written only by `lib/server/websites-service.ts`. `windowStart` (ms since epoch) + `count`: the hourly build counter — `WEBSITE_BUILDS_PER_HOUR` (10) submits to gitpage per fixed one-hour window, reserved in a transaction before gitpage is called and consumed whatever happens next (an HTTP error and a thrown request both count; there is no release, so ten failed attempts lock builds until the window rolls). `createSeq`: bumped by every transaction that creates a site doc at `subAccounts/{id}/website/{siteId}`, so concurrent creations conflict on this doc and the `MAX_WEBSITES_PER_SUBACCOUNT` count is atomic. `updatedAt`. No secret in it; it lives under `private/` so no client can read or reset it. See [website-builder.md](../features/website-builder.md). |
| `subAccounts/{id}/private/websiteHandoff` | Admin SDK only (the generic `private/{docId}` deny rule) | The website publish hand-off's claims, one doc per sub-account, written only by `lib/server/website-handoff-service.ts`: `contactFormId` (the ONE "Website contact" form) and `workflowId` (the ONE speed-to-lead workflow, created as a draft and stamped `provisionedFrom: "website-build"` + `provisionedSiteId`), each set in a transaction so two builds racing cannot make two; a claimed id whose doc was deleted may be replaced. `updatedAt`. See [website-builder.md](../features/website-builder.md). |
| `subAccounts/{id}/websiteDismissed/{pageId}` | Admin SDK only (no rule — the default deny) | A website deleted in LeadStack: one tombstone per gitpage site it stood for (`pageId` — a gitpage ObjectId, also the doc id — and `dismissedAt`). Written by `DELETE /api/sub-accounts/[id]/website/[siteId]` in the same transaction that deletes the site doc; read by the gitpage-copies sync (`lib/server/website-import-service.ts`) so a deleted site is never imported again. Never deleted. See [website-builder.md](../features/website-builder.md). |
| `subAccounts/{id}/private/websiteSync` | Admin SDK only (the generic `private/{docId}` deny rule) | The gitpage-copies sync throttle, one doc per sub-account: `lastSyncAt` (ms since epoch) + `updatedAt`, checked and set in one transaction by `claimSyncSlot` (`lib/server/website-import-service.ts`) so a sub-account syncs at most once a minute. Separate from `private/websiteLimits` so syncs never contend with build reservations. See [website-builder.md](../features/website-builder.md). |
| `subAccounts/{id}/aiAgent/profile` | sub-account read; server-only write | Shared AI Agent identity. `systemPrompt`, `businessName`, `hoursStart/End`, `timezone`, `escalationKeywords`, `escalationNotifyEmail`, plus optional `websiteUrl` + `websiteKb` (Firecrawl snapshot or a premium website build's KB, ≤6000 chars) + `websiteKbFetchedAt`, `websiteKbSource` (`firecrawl` / `gitpage-build`), `websiteKbSiteId`, and `websiteSeeded` (the values the website hand-off last filled in, so it can tell them from the operator's own). One per sub-account. |
| `subAccounts/{id}/aiAgent/{channelId}` | sub-account read; server-only write | Per-channel operational config. Channels today: `sms`, `web-chat`, `whatsapp`, `voice`, `meta`, `email` (Email AI drafts — the shared fields only, no nested block). Carries `enabled`, `contextMessageCount`, `modelOverride`, `escalationKeywordsOverride`, `escalationNotifyEmailOverride`, `totalTokensUsed`. The `web-chat` doc nests a `webChat` block (`allowedDomains`, `welcomeMessage`, `accentColor`, `position`); the `whatsapp` doc nests `whatsapp` (`sessionWindowHours`); the `voice` doc nests `voice` (Vapi linkage + render prefs + the **Outbound** block: `outboundEnabled`, `outboundFirstMessage`, `outboundSystemPrompt`, `outboundWindow`, the per-minute/daily/per-number caps, `allowedCountries`). Outbound has no separate channel doc — it rides the `voice` doc. |
| `subAccounts/{id}/aiConfig/main` | sub-account read; server-only write | **Legacy.** Pre-refactor combined config. Kept readable so `lib/comms/ai/agent.ts::maybeMigrateLegacy()` can lazily split it into the new `aiAgent/profile` + `aiAgent/sms` shape on first read. Safe to remove after every sub-account has been migrated. |
| `subAccounts/{id}/webChatSessions/{sessionId}` | sub-account read; server-only write | One row per Web Chat thread. Anonymous-first — `contactId: null` until the bot captures identity. Carries `pageUrl`, `referrer`, `origin`, `visitorIp`, `visitorUserAgent`, `status` (active/closed/escalated), `messageCount`, `tokensUsed`, `capturedName/Email/Phone`, `capturePromptShownAt`, `captureSkipped`, `pendingFollowUpTaskId`, and `voiceSeconds` once a Web Voice call on it has been settled. Session id = a UUID generated client-side and stored in localStorage. |
| `subAccounts/{id}/webChatSessions/{id}/messages/{id}` | sub-account read; server-only write | Per-turn transcript. `direction` inbound/outbound, `body`, `tokens`, `aiGenerated`, and `via: "voice"` on a turn spoken through Web Voice (absent on typed turns). Visitor sees the body with any `[[capture …]]` / `[[form …]]` markers stripped. |
| `subAccounts/{id}/voiceCalls/{callId}` | sub-account read; server-only write | One summary doc per voice call (doc id = Vapi `call.id` for retry-dedup). Carries `direction` (`inbound` \| `outbound`), `callerPhone`, `toPhone`, `durationSec`, `summary`, `endedReason`, `contactId`, captured fields, `callbackRequested`, `taskId`, inline `transcript[]`, and live-status fields. Written by the Vapi end-of-call + status webhooks. |
| `voiceCampaigns/{campaignId}` | sub-account read; server-only write | Bulk Outbound Voice campaign (top-level, like `quotes`). Carries tenancy, `code` (`VC-YYYY-NNNN`), `name`, `audienceFilter` (reuses `BroadcastAudienceFilter`), `suppression`, `consentAck`, `status` (queued → calling → completed/cancelled/failed), and `totals` (audienceSize/queued/called/skipped/failed/interested). |
| `voiceCampaigns/{campaignId}/recipients/{contactId}` | sub-account read; server-only write | Per-recipient row — the QStash fan-out unit. Doc id = contactId. Carries `toPhone`/`toName` snapshot, `status` (queued/called/skipped/failed), `skippedReason`, `callId`, `callControlUrl` (for the stop-all kill switch), `outcome`, `callDurationSec`, `endedReason`, `callSummary`, `taskId`, `attempts`. Mirrors the bulk-email `broadcasts/{id}/sends` model. |
| `subAccounts/{id}/contactPhoneIndex/{mode}_{e164}` | server-only | **Never persisted — a lock path.** `POST /api/v1/contacts/upsert` reads it and then writes a delete to it inside its transaction, so two concurrent calls for one phone contend and one re-runs. Nothing is stored, so no phone outlives its contact here. See `lib/server/contact-upsert.ts`. |
| `subAccounts/{id}/counters/voiceCampaignNumbers` | server-only | Per-sub-account sequence counter for the `VC-YYYY-NNNN` campaign code generator. Same atomic-increment shape as `quoteNumbers`. |
| `subAccounts/{id}/counters/quoteNumbers` | server-only | Per-sub-account sequence counter for the year-prefixed `Q-YYYY-NNNN` quote number generator. `{ year: number, seq: number, updatedAt }`. Atomic increment via Firestore transaction in `lib/quotes/number.ts::issueQuoteNumber()`. Never touched by clients — the resulting number returns in the create-quote API response. |
| `quotes/{id}` | sub-account read/create/update/delete | Operator-built quote. Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `contactId`, `quoteNumber` (e.g. `Q-2026-0001`), `status` (draft → sent → viewed → accepted/declined/expired → paid), `currency`, `lineItems[]`, `globalDiscount`, `globalTaxPercent`, `termsAndNotes`, `billedToOrganization`, `validUntil`, `autoCreateDealOnAccept`, lifecycle stamps (`sentAt`, `viewedAt`, `acceptedAt`, `declinedAt`, `declineReason`, `declineNote`, `paidAt`), and `publicTokenHash` (SHA-256 of the most recent HMAC-signed public token — raw token never persisted). Edits allowed on sent quotes per v1 spec. |
| `trackedLinks/{id}` | sub-account read; server-only write | Tracked link (GHL "Trigger Link", top-level like `quotes`). Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `mode` (`live`\|`test` — API-created links inherit the key's mode, dashboard links are always `live`), `name`, `destinationUrl` (validated http(s) at write AND read), and click stats (`clickCount`, `lastClickedAt`). Read from the browser so the workflow builder's link picker can list them; every write goes through Admin-SDK routes, including the click counters asserted by the public `/l/{token}` redirect. |
| `workflowEnrolmentLocks/{workflowId}_{contactId}` | server-only | Serialization point for `unless_active` / `once_ever` re-entry: the enrolment transaction reads and writes it with the new `workflowRuns` doc, so simultaneous triggers cannot both enrol. Carries `workflowId`, `contactId`, `agencyId`, `subAccountId`, `lastRunId`, `updatedAt`; nothing reads its fields. Admin SDK only (default-deny in rules). |
| `workflowEnrolmentKeys/{workflowId}_{contactId}_{enrolmentKey}` | server-only | Keyed enrolment dedupe: a trigger fired with an `enrolmentKey` (today only `prospecting.report.ready`, key `report:<reportId>`) enrols a contact in a workflow once per key. Written in the run-creation transaction with the run it admits; a run carrying a key whose doc exists is refused `reentry_blocked` under every re-entry policy, even after the first run finished. Carries `workflowId`, `contactId`, `agencyId`, `subAccountId`, `enrolmentKey`, `runId`, `createdAt`. Admin SDK only (default-deny in rules, rules-tested in `prospecting.firestore-rules.test.ts`). |
| `trackedLinks/{id}/recipients/{contactId}` | server-only | One row per contact a link was minted for; the doc id IS the contact id, so re-minting is idempotent. `destinationUrl` (per-recipient override, null = use the link's own), `clickCount`, `firstClickedAt`, `lastClickedAt`, `createdAt`. Written by `POST /api/v1/links/{id}/recipients` and by the redirect route. |
| `trackedLinks/{id}/clicks/{autoId}` | server-only | Raw click log written by the `/l/{token}` redirect. `contactId` (null for a tokenless `/l/{linkId}` click), `clickedAt`, `userAgent`, `referer`. |
| `socialPosts/{id}` | sub-account read; server-only write | Social Planner post (top-level, like `quotes`). Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `caption`, `imageUrl`, `targets` (`("facebook"\|"instagram")[]`), `status` (draft → scheduled → publishing → published/failed), `scheduledAt`, `publishedAt`, per-target `results[]` (`{platform, status, externalId, error}`), and `qstashMessageId`. Reads stream to the content calendar via `subscribeToSocialPosts`; all writes go through Admin-SDK routes (rules are read-only for members, mirrors `products`). |



### WhatsApp Cloud settings (SP15)
`whatsappCloudMeta.quality` on the parent (member-readable) holds the hourly
poll's last reading of the phone-number node: `{ rating (GREEN | YELLOW | RED |
UNKNOWN), nameStatus, status, checkedAt, changedAt }` — `changedAt` moves only
when `rating` changes. `subAccounts/{id}/whatsappQualityAlerts/{autoId}` is one
doc per drop from GREEN (`agencyId`, `subAccountId`, `createdByUid: "system"`,
`from`, `to`, `phoneNumberId`, `displayPhoneNumber`, `createdAt`, `resolvedAt`
null until the rating is next seen GREEN); member-readable, server-only write,
queried only by `resolvedAt == null` inside one sub-account, so no composite
index. `private/whatsappFakeScenario` holds the dev/CI fake settings provider's
scenario (Admin SDK only under the `private/{docId}` deny rule). The business
profile and message links are NOT cached — Meta is the source of truth.

### Google Business Profile
`subAccounts/{id}/private/googleConnection` holds the OAuth refresh/access
tokens; `private/gbpFakeScenario` holds the dev/CI fake provider's scenario.
Both are Admin SDK only under the existing `private/{docId}` deny rule. The
parent carries display data only: `googleConnectionMeta` (incl.
`reconnectRequired` / `reconnectReason`) and `googleListing` (the selected
`accounts/…` + `locations/…` pair plus title/address/links — Place ID is
display-only). Multiple listings ([MULTI_LISTING_V1_PLAN.md](../../MULTI_LISTING_V1_PLAN.md)):
`googleExtraListings` (the non-main listings, same shape, server-written,
at most 9), `googleLocationNames` (flat `[main, ...extras]` location names,
rewritten by every listing writer — `[]` when cleared — and read only by the
`array-contains` half of the `listing_shared` check in
`lib/gbp/shared-location.ts`; absent on docs written before it existed, so
that check also keeps the `googleListing.locationName ==` query; backfill:
`scripts/backfill-google-location-names.ts`) and `gbpSummaries` (per-extra
sync summaries keyed by the id after `locations/`, same shape as
`gbpSummary`) — all member-readable display data on the parent, no rules
change; the one index is under Review sync below. `subAccounts/{id}/gbpEvents/{auto}` is a server-only,
append-only audit log (`listing_selected`, `listing_cleared` with a `reason`;
`extra_listing_added` and `extra_listing_removed` with a `reason`
(`admin_removed` / `not_accessible_after_reconnect`, or the main listing's clear reason — `disconnected` / `admin_cleared` — when `clearListing` removes every extra), each with `locationName`;
`reply_posted` / `reply_deleted` with `actorUid` + `reviewDocId` — never the
reply text; `review_url_adopted` with `previousUrl`, `url`, `actorUid`;
tenant-anchored with `agencyId`, `subAccountId`, `createdByUid`); no client
rule, so default deny. No new index.

Explicit replies: `subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}`
is the reply idempotency ledger — `status` (`pending` / `succeeded` /
`failed`), `reviewDocId`, `commentHash` (sha256 of the reply, never its text),
`createdByUid` (the tenant anchor: the admin, or for an auto post whoever
switched auto-reply on) and `actorUid` (the admin, or `system:auto-reply`),
`replyUpdateTime`, `errorKind`, `at`; tenant-anchored. Written by
`lib/gbp/reply.ts` only — the reply route and the auto-reply engine (Admin
SDK); no client rule, so default deny; no index. A posted or deleted reply
changes the cached review's `reply` and `contentHash`; a posted one also
clears `pendingReply` and sets `hadReply` (and `autoReplied` for an auto post).

Review sync (all written by the sync core only, Admin SDK; no client rule, so
default deny): `subAccounts/{id}/gbpReviews/{sha256(review.name)[:40]}`
caches the reviews of every connected listing, each doc carrying its
`locationName` (tenant-anchored; `state` active/removed tombstones; deleted
after 30 days unseen). Served reads query it per listing — composite index
`gbpReviews (locationName ASC, createTime DESC)`. `subAccounts/{id}/gbpSyncRuns/{runId}`
is an append-only run record (created once per listing run, kinds and counts
and its `locationName`). Per listing
([MULTI_LISTING_V1_PLAN.md](../../MULTI_LISTING_V1_PLAN.md) H2): the main
listing's state is `private/gbpSyncState`, an extra's is
`private/gbpSyncState_{locId}` — each holds that listing's run lease, pass
cursor (with the pass's rating/count), `retentionPurgedAt` and anomaly
streak; the Sync-now cooldown lives on the main doc only. Sub-accounts that
hold a cache but can no longer sync (gate off, disconnected, no listing) get
retention-only passes from the sweep, which finds them by
`gbpSummary.lastRunAt` (kept while any `gbpSummaries` entry exists). The
member-readable `gbpSummary` (main) and `gbpSummaries.{locId}` (extras)
fields on the parent carry rating, count, freshness and health kinds.
Selecting another main listing (or the same location through another Google
account) or clearing a listing deletes that listing's reviews, sync state and
summary; disconnecting deletes every listing's.

Review sentiment (SP5 b; written only by `lib/reputation/sentiment.ts`, never by
the sync): each review may carry `sentiment {label, method, basisHash, model,
at}` and `sentimentAttempt {basisHash, failures, lastAt}` — kept by a
tombstone (a label and hashes, no content; retention deletes them with the
doc); readers ignore a label whose `basisHash` is not the review's current
basis. `private/sentimentLease` holds the classifier's lease, the Analyse-now
cooldown, `lastCompleteAt` (the last run that finished normally) and the last
run's counts and stop reason; `private/sentimentUsage {day, calls}` counts AI
calls per UTC day against the 300-call cap — sentiment calls AND reply drafts
(SP5 c). In dev/CI only, `private/reviewsAiFakeLog` holds the Reviews AI
fake's call log (ids + count, and `drafts: [{at, kind, stars}]` — never text).
`subAccounts/{id}.reviewsAiConfig {replyGuidelines, updatedAt, updatedByUid}`
(SP5 c) is server-written (PUT …/reputation/ai-settings), member-readable.
`subAccounts/{id}.reviewsAutoReply {enabled, modes {1..5: auto|approval},
includeBacklog, enabledAt, enabledByUid, listingLocationName, disabledReason,
updatedAt, updatedByUid}` (AUTO_REPLY_V1_PLAN.md) is server-written (PUT
…/reputation/auto-reply, admin; stamps set on off→on in a transaction),
member-readable; absent reads as off, 1-3★ approval, 4-5★ auto, no backlog.
The auto-reply engine (`lib/reputation/auto-reply/`, Admin SDK only; no
client rule, so default deny; no index) writes: `pendingReply {text,
textHash, basisHash, reason, at, model, slopFails?}` on a cached review (its draft, held
or queued to post — the only place draft text is stored; cleared by any
posted reply, by a reply appearing at Google and by a tombstone; purged with
the review; `reason` ∈ auto_queued, approval, texted, draft_failed,
post_failed, no_budget, cap, dismissed), `autoReplied {at, key}` on a review
it replied to (kept by the sync's merge; a person's reply sets it null),
`heldAlertBasis` (the basis hash the held alert last counted — its dedupe), `hadReply: true` on any review ever
seen with or given a reply (sticky; written by the sync and the reply record,
never cleared — auto-reply never replaces a deleted reply), `private/autoReplyLease {runId, until}` (one run per
sub-account), `private/autoReplyUsage {day (SAST), posts}` (the 20/day post
cap; auto drafts are `autoDraftCalls` in `private/sentimentUsage`, on its
`draftsDay`), and `subAccounts/{id}/autoReplyDismissed/{stableReviewKey}
{agencyId, subAccountId, createdByUid, byUid, basisHash, at, reviewDocId}` — a
Discard, outside the review cache so it survives a cache clear; an id and a
hash, no Google content, so it deliberately outlives review retention.
Likewise `subAccounts/{id}/autoReplyNever/{stableReviewKey} {agencyId,
subAccountId, createdByUid, at, reason: "replied" | "auto_replied",
reviewDocId, star?}` (`star`: the rating when auto-replied, for the
edited-to-≤3★ alert after a cache clear; the sync never rewrites an existing
marker) — written by the sync (the first time a review is seen with a
reply, now or in its cached copy; `createdByUid` is then the listing's
selector and may be null), by `recordReplyChange` on every posted reply and by
the engine's finalize of an unrecorded auto post; never deleted, outside the
cache so a cache clear cannot forget it; an id only, no Google content, so it
deliberately outlives review retention. The auto-reply engine never posts to a
review that has one. Both are keyed by `stableReviewKey` = sha256 of
`locations/{loc}/reviews/{id}` (the `accounts/{a}/` prefix of the review name
stripped, `lib/gbp/auto-reply-never.ts`), NOT the cache doc id: the same
location selected through another Google account renames its reviews, so the
cache doc id changes and this key does not; `reviewDocId` is kept for
reference. Server-only (no client rule), no index. Any listing change or
clear — including the same location through another account — also sets
`reviewsAutoReply.enabled` to false and, when it was on,
`reviewsAutoReply.disabledReason: "listing_changed"` (the settings card's
"switched off because the listing changed" note; the listing route and
`clearListing` write it, any admin switch through the settings route clears
it to null; absent reads as null).
`subAccounts/{id}/reviewAutoReplyAlerts/{alertId} {agencyId, subAccountId,
createdByUid: "system", kind, createdAt, count?, star?, reviewDocId?}` — one
doc per auto-reply alert (`lib/reputation/auto-reply/alerts.ts`), created
before the push/email so an existing id means "already sent": `held-{runId}`
(an engine run that put reviews in front of a person; `count`),
`edited-{stableReviewKey}` (an auto-replied review now at ≤3★ after an edit,
once per review ever; `star`), and auto ids for `reconnect_required` (only
while auto-reply is on) and `listing_changed` (their writers' flips are the
dedupe). No review text or reviewer name. Server-only (no
client rule), no index, no retention yet.

Public reviews widget: `gbpWidgets/{publicId}` (top level; `publicId` = 24
random bytes base64url, never derived from a tenant id) holds the widget config
`agencyId, subAccountId, createdByUid, enabled, allowedOrigins, maxReviews,
createdAt, updatedAt` — server only, no client rule, so default deny; read by
the public feed route on the Admin SDK. The member-readable `gbpWidgetMeta`
field on the parent (`{publicId, enabled, allowedOrigins, maxReviews,
updatedAt}`) mirrors it for the dashboard; both change in one transaction. One
widget per sub-account; rotate replaces the doc, revoke deletes it and nulls
the meta. No new index.
See [gbp-reviews.md](../features/gbp-reviews.md).

Review-request log: `subAccounts/{id}/reviewRequests/{auto}` — one row per
review ask any sender made (`agencyId, subAccountId, createdByUid` = the person
who sent it, else a label `"review-request"` / `"workflow"` / `"broadcast"`;
`contactId, channel` (`sms` / `whatsapp` / `email`), `source` (`dispatcher` /
`workflow` / `broadcast` / `inbox`), `trigger` (the dispatcher's, else null),
`status` (`sent` / `failed`), `failureKind, messageSid, sentAt, clickedAt: null,
feedbackAt: null`). One writer, `logReviewRequest()` (`lib/reviews/request-log.ts`),
called where each send is initiated: the dispatcher after a successful send,
and workflow send steps, the broadcast email worker and the inbox send routes /
scheduled-message worker when the rendered message carries the configured
review URL or is the `review_request` template. Rows before SP5 d1 are the
dispatcher's only, with channel `whatsapp_template` / `whatsapp_manual` and no
`source`; readers map them. SP5 d2: dispatcher rows sent while reminders are
on also carry `tracked` (the body had the `/rr/` link) and `reminder
{everyDays, maxRetries, attempts, nextAt, state, stopReason, lastAttemptAt}`
and `toHash` / `templateHash` (SHA-256 of the number and of the message
template used — never the number or the body), updated by
the reminder worker and by a newer request for the same contact (superseded); `/rr/{token}` stamps `clickedAt` (first click) and `lastClickedAt` (every counted click). Never a
message body, phone number or email.
Server only (no client rule, so default deny); read by the Reputation overview
and requests routes with single-field `sentAt` queries — no index. See
[reputation.md](../features/reputation.md).

### Workspace SMTP connection
`subAccounts/{id}/private/smtpConnection` stores host, port, TLS mode, username,
password, From email/name and verifiedAt. Admin SDK only; existing
`private/{docId}` rules deny all client reads/writes. No new index required.
The parent has `emailProvider` and password-free `smtpConfig` display metadata.
Admin settings routes verify TLS/auth before atomically switching credentials
and provider. Disconnect atomically deletes the secret and selects Resend.

### Twilio, Meta and GHL-import credentials
`subAccounts/{id}/private/twilioCredentials {authToken}`,
`private/metaCredentials {pageAccessToken}` and
`private/ghlImportCredentials {token}` hold the three integration secrets
(paths in `src/types/sub-account-secrets.ts`). Admin SDK only under the
`private/{docId}` deny rule. The parent keeps only non-secret status in
`twilioConfig` / `metaConfig` / `ghlImportConfig`. Readers use
`readSubAccountSecret`, which falls back to the legacy field on the parent for
docs written before the move; `scripts/migrate-private-credentials.ts` copies
those into the private docs and deletes the legacy fields.

### Browser dialer (softphone)
`subAccounts/{id}/private/dialer {apiKeySid, apiKeySecret, twimlAppSid, createdAt}`
(`DialerPrivateDoc`) holds the Twilio API key and TwiML App the provisioning
route (`POST /api/sub-accounts/[id]/dialer`) minted on the sub-account's own
Twilio account. Admin SDK only under the `private/{docId}` deny rule; written
by that route, deleted by its `DELETE`. The parent carries only the
non-secret `dialerConfig {enabled, recordCalls}` (`DialerConfig`, server-written).
Calls log a `call_placed` activity at `contacts/{id}/activities/dialer_{CallSid}`,
written by the dialer TwiML webhook and updated by its status callback. No new
index. See [dialer.md](../features/dialer.md).

### Web Voice (ElevenLabs)
`subAccounts/{id}/private/webVoiceConnection` (`WebVoiceConnectionSecret` in
`src/types/web-voice.ts`) holds the sub-account's own ElevenLabs `apiKey`, the
`agentId` of the private voice agent provisioned on that account, the
`endpointSecret` baked into the agent's custom-LLM URL, the operator's voice
settings, and `rev`, a random id every write replaces. Admin SDK only under the
`private/{docId}` deny rule; written only by `lib/server/web-voice-service.ts`,
whose one transactional writer (`commitWebVoiceState`) changes it together with
the parent's display copy and applies only if `rev` is still what the caller
read. The key is checked against ElevenLabs before it is ever stored. The parent
carries only the non-secret `webVoiceMeta` (`WebVoiceMeta`: settings, `ready`,
`keyLast4`, `lastError`, `connectedAt`; null = not connected; `ready` = the agent
exists and the last sync succeeded), server-written. `webVoiceMeta` (and the dialer's
`dialerConfig`) are in `CHANNEL_CONNECTION_FIELDS` (`lib/agency/channel-connections.ts`).

`subAccounts/{id}/private/webVoiceUsage` (`WebVoiceUsageDoc`) holds the call
path's counters: `day`/`secondsToday` and `month`/`secondsThisMonth` (UTC), the
live signed-URL `grants` (grant id → `{issuedAtMs, seconds, agentId,
triedConversationId?}`), the `lapsed` grants already charged and awaiting refund
(grant id → `{issuedAtMs, day, month, chargedSeconds, agentId}`), the `pending`
conversations (ElevenLabs conversation id → `{sessionId, grantId, grantIssuedAtMs,
startedAtMs}`), a ring of the last 500 counted (`settled`) conversation ids, the
reconciliation `watermarks` (agent id → ms), and `reconcileStalledSinceMs` /
`reconcileStalledSweeps` while a doubtful list item blocks reconciliation, and
`limitLog` (the last 50 changes of `maxCallSeconds` as grants saw it). Admin SDK only; written only by
the `lib/server/web-voice-{usage,claim,settle,reconcile}.ts` modules, every change
in a transaction. Disconnect deletes
it with the connection doc. No new index. See
[web-voice.md](../features/web-voice.md).

### Workspace mailbox and email conversations

`subAccounts/{id}/private/mailboxConnection` stores verified IMAPS credentials,
folder cursors (UIDVALIDITY and UID), connection version and expiring sync lease.
The parent `mailboxConfig` contains only safe display metadata and sync status.
The existing private-document deny rules cover the credentials and cursors.

`contacts/{id}/emailMessages/{sha256(messageId)}` stores plain-text inbound and
outbound email with subject, addresses, threading headers and attachment metadata.
Readers inherit the contact's tenant and territory access; all writes are server
only. Message insertion and the `conversations/{contactId}` index update are one
transaction, including the mailbox lease/version check for imported messages.
Historical imports preserve newer conversation previews and do not increment
unread counts. Imported mail does not enroll workflows or send automated replies.
With Email AI drafts on (`emailAiDraftsEnabledByAgency` + `aiAgent/email`), a new
live inbound email gets a suggested reply in `conversations/{contactId}.pendingDraft`
(`id`, `channel: "email"`, `escalationKeyword?`, and `emailReply: { subject, inReplyTo?, references }` taken
from the inbound email) after the sync pass — a draft only, never a send. A
conversation an email starts then opens with `botMode: "suggest"` instead of `"off"`.

The QStash `leadstack-email-sync` schedule runs every five minutes and fans out
bounded work across connected sub-accounts. Disconnecting a mailbox removes its
secret and prevents in-flight workers from committing further messages, while
retaining the existing conversation history.

`subAccounts/{id}/private/mailboxOperation` stores a connection-operation generation
so a pending verification cannot undo a subsequent disconnect. The server-only
`subAccounts/{id}/emailMessageIndex/{sha256(messageId)}` binds correspondents to the
contacts chosen for an existing message, preventing Sent-folder imports from
duplicating an explicitly addressed send when several contacts share an address.

Conversation documents carry the contact's `territoryId`. Contact territory moves
update linked conversation metadata atomically. Scoped client lists constrain
territory IDs, backed by the `subAccountId, territoryId` index; rules enforce the
same visibility for the preview and message body.
