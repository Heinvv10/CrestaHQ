# Firestore Collections

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*
| Collection | Scope | Notes |
|---|---|---|
| `agencies/{agencyId}` | agency-read | Agency profile + Stripe billing (one per deployment in v1) |
| `agencies/{agencyId}/agencyMembers/{uid}` | agency-read | Owner / staff list |
| `agencies/{agencyId}/plans/{planId}` | server-only | Client Billing v1 plan docs (monthly price + feature-gate bundle + Stripe product/price ids). All access via the owner-only `/api/agency/plans` routes |
| `agencies/{agencyId}/snapshots/{snapshotId}` | server-only | Agency config template — forms/workflows/templates/products/custom-fields/AI-persona payload captured from one sub-account, applied to another. Carries no customer data and no credentials. All access via the owner-only `/api/agency/snapshots` + apply routes. An imported copy carries `importedFrom: { importedAt, via?: "file" }` (no source ids), `sourceSubAccountId: null`, re-minted `sourceId`s, and cleared workflow destinations |
| `agencies/{agencyId}/snapshots/{snapshotId}/shares/{shareId}` | server-only | Snapshot share link: `snapshotName`, `tokenHash` (sha256 hex — the raw token is never stored), `expiresAt`, `singleUse`, `usedCount`, `revokedAt` + tenancy stamps. Via `/api/agency/snapshots/[snapshotId]/shares` and `/api/agency/snapshots/shares` |
| `snapshotShareIndex/{tokenHash}` | server-only | `{agencyId, snapshotId, shareId, createdByUid, createdAt}` — resolves a presented share token to its share without a collection-group query. Deleted on revoke; read by the public `/s/snapshot/{token}` page + download and by `POST /api/agency/snapshots/import` |
| `agencies/{agencyId}/templates/{templateId}` | server-only | Template library — ONE workflow / email template / form (plus a workflow's trigger form) as a `SnapshotPayload`, with `kind`, `name`, `description`, `tags`, `sourceSubAccountId`. Owner-readable; all writes via the owner-only `/api/agency/templates` routes; pushed into sub-accounts through `applySnapshot` |
| `paymentLinks/{id}` | members + agency owner read; server-only write | Paystack payment link paid into the sub-account's OWN Paystack: `invoiceId` (null = ad-hoc), `description`, `amountCents`, `currency` ("ZAR"), `mode` (`test`/`live`, the mode it was issued in; paid only in that mode), `token`, `active`, `status` (`open`/`paid`), `paystackReference`, `payerEmail`, `paidAt` + tenancy keys. Flips to paid only in the verified webhook. Spec: [w4-paystack-payment-links.md](../programme/w4-paystack-payment-links.md) |
| `paymentAttempts/{reference}` | members + agency owner read; server-only write | One per Paystack checkout, keyed by the reference, written before Paystack is called: `paymentLinkId`, `amountCents`, `currency`, `mode`, `keyFingerprint` (truncated SHA-256, never the key), `state` (`open`/`settled`/`refused`/`flagged`), `reason` + tenancy keys. The webhook records a payment only when the verifying key and Paystack's domain match it; a connection change flags open attempts. Spec: [w4-paystack-payment-links.md](../programme/w4-paystack-payment-links.md#test-mode) |
| `billingEvents/{id}` | server-only | Client Billing v1 append-only audit trail (plan assigned/switched, comped, activated, dunning transitions) |
| `auditEvents/{id}` | agency owner + sub-account admin read; server-only write | Append-only "who changed what": `action`, `actor {type, id}`, `target {type, id}`, `changes [{field, before, after}]` (free-text values stored as `[redacted]`) + tenancy keys; `subAccountId: null` = agency-level, owner-only. Written only by `recordAuditEvent()` (`src/lib/audit`). Contract: [audit-events.md](audit-events.md) |
| `subAccounts/{subAccountId}` | members + agency owner | Workspace metadata; reserved fields for Workflow-Recipes Twilio/Resend/booking/sendWindow |
| `subAccounts/{subAccountId}/subAccountMembers/{uid}` | admins | Per-sub-account membership rows |
| `userMemberships/{uid}/subAccounts/{saId}` | self-read | Denormalized index powering the sub-account switcher |
| `userMemberships/{uid}/agencies/{agencyId}` | self-read | Denormalized index for agency-level access |
| `users/{uid}` | self only | Slim profile (display name, photoURL, primaryAgencyId) |
| `appConfig/main` | active members | Bootstrap singleton: `firstAgencyId`, `firstAgencyOwnerUid` |
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
| `subAccounts/{id}/pipelines/{pipelineId}` | server-only | Deal pipelines with stages embedded (`{ id, label, tone, terminal? }[]`; `terminal` = `won`/`lost` drives `deal.won`/`deal.lost`). `pipelines/default` is seeded lazily on first read from the canonical six stages + the legacy `subAccounts/{id}.pipelineStages` label/order overrides, keeping the SAME stage ids. Read via `GET /api/sub-accounts/[id]/pipelines`; written only by those Admin-SDK routes. Deleting a stage / pipeline that still holds deals is refused (409) |
| `events/{id}` | sub-account | Calendar events. Booking-page events may carry `hostUids` (collective) and `serviceId`/`serviceName` (service pages) — server-written only; rules refuse them from clients. `isLong` (> 8 h) is written with the event's times and read by availability's long-event query |
| `events/{id}/reminderSends/{offset_tokenHash}` | server only | Create-only claim per booking reminder (offset × schedule), so a QStash redelivery doesn't email twice. Deleted again when a send fails in a way a retry could fix |
| `tasks/{id}` | sub-account | Todos; optional `assignedToUid` (a `subAccountMembers` uid or null — rules refuse any other value) |
| `forms/{id}` | sub-account | Form config |
| `forms/{id}/submissions/{id}` | sub-account read, server-write | Inbound submissions; route stamps tenancy from the form doc |
| `usage/{subAccountId}/users/{uid}` | self/owner read | Email + SMS quotas |
| `mail/{id}` | server-only | Trigger-Email extension queue |
| `automations/{id}` | sub-account; admin-write | Recipe configs (one per attached form). Carries `agencyId`, `subAccountId`, `recipeType`, `trigger`, `config`, `enabled` |
| `message_templates/{id}` | sub-account; admin-write | Reusable email + SMS bodies with merge tags |
| `automation_executions/{id}` | sub-account read; server-only write | Per-firing run rows; the QStash callback executor mutates these |
| `contacts/{id}/messages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | SMS chat thread when the sub-account has dedicated Twilio enabled. Doc id = Twilio MessageSid for natural dedupe on retries. |
| `contacts/{id}/whatsappMessages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | WhatsApp chat thread (same model as `messages`). Populated by the WhatsApp inbound webhook + `/api/comms/whatsapp/send` + `/api/comms/whatsapp/send-template`. Doc id = Twilio MessageSid. |
| `contacts/{id}/scheduledMessages/{id}` | server-only (read and write) | "Send later" (SP2 T5). One booked conversation message: tenancy keys (`agencyId`, `subAccountId`, `createdByUid`), `contactId`, `channel` (email/sms/whatsapp/messenger/instagram), FINAL `body` (+ email `subject`, `inReplyTo`, `references`), `sendAt`, `status` (pending → sending → sent / failed / unconfirmed — attempted, outcome unknown — or cancelled), `failureReason`/`failureCode`, `dismissedAt` (failed/unconfirmed taken off the thread), booked at most 7 days ahead (QStash Free max delay), a delivery >15 min late fails as `delivered_late`, `qstashMessageId`, `sentMessageId`. Lives under the contact so it inherits the thread's lifetime (deleted with the contact) and needs no index. Booked/cancelled/listed by `/api/sub-accounts/[id]/scheduled-messages` (authorised like the send routes), fired by the QStash worker `/api/scheduled-messages/fire`, which re-runs every send-time check through `lib/server/conversation-send`. |
| `subAccounts/{id}/smartLists/{id}` | members read/create/update/delete | Saved contacts-list filter: `name`, `filters` (a workflow `ConditionGroup`, evaluated client-side by `lib/contacts/filter.ts`), plus `agencyId`, `subAccountId`, `createdByUid`. Tenant keys locked on update. No composite index — the list is read by subcollection path alone. |
| `subAccounts/{id}/media/{mediaId}` | members read; server-only write | Media Library file (SP13a): `name`, `folderId` (null = root), `storagePath` (`media/{subAccountId}/{mediaId}/{fileName}` in Firebase Storage), `contentType` + `size` read back from the bucket by `POST /api/sub-accounts/[id]/media` (never the client's), `downloadUrl`, `kind` (image/video/document), plus tenancy keys. The browser uploads the bytes directly under `storage.rules` (sub-account admin/agency owner, ≤25 MB, image/video/PDF, create-only; any member reads); register/rename/move/delete are admin-only routes over `lib/media/service.ts`. No composite index — read whole, ordered by `createdAt`. |
| `subAccounts/{id}/mediaFolders/{folderId}` | members read; server-only write | Media Library folder: `name`, `parentId` (null = root), tenancy keys. Delete is refused (409) while it holds files or sub-folders. |
| `subAccounts/{id}/emailSuppressions/{sha256(email)}` | server-only | Email suppression list: `email` (trimmed, lower-case), `reason` (`hard_bounce` / `complaint` / `manual`), `note` + tenancy keys. The doc id is the sha256 of the address, so `sendEmail` checks with one `get()`. Admin-only access via `/api/sub-accounts/[id]/email-suppressions`. Covered by the default-deny rule; no index. Spec: [w4-email-tracking](../programme/w4-email-tracking.md) |
| `subAccounts/{id}/workflowFolders/{folderId}` | server-only | Workflow-list folder: `name`, `order`, tenancy keys. A workflow points at one via optional `workflows.folderId` (absent/null = Unfiled; the engine never reads it). All access through the member-gated `/api/sub-accounts/[id]/workflow-folders` routes; delete unfiles its workflows in the same transaction. Does not travel in snapshots or template pushes — capture strips `folderId`, so applied workflows land Unfiled. |
| `subAccounts/{id}/whatsappTemplates/{id}` | members read; server-only write | WhatsApp message templates (v2). Carries the body + positional variables, Twilio `contentSid`, and the Meta approval `status`. Written by the `whatsapp-templates/*` Admin-SDK routes; status synced live by the QStash approval poll. |
| `broadcasts/{id}` | sub-account read; server-only write | Bulk-email batch metadata (template, audience filter, totals, status). One per "Send bulk email" action. |
| `broadcasts/{id}/sends/{contactId}` | sub-account read; server-only write | Per-recipient delivery row. Doc id = contactId for natural dedup. Status: queued/sent/skipped/failed. Carries Resend message id + error string. |
| `subAccounts/{id}/aiAgent/profile` | sub-account read; server-only write | Shared AI Agent identity. `systemPrompt`, `businessName`, `hoursStart/End`, `timezone`, `escalationKeywords`, `escalationNotifyEmail`, plus optional `websiteUrl` + `websiteKb` (Firecrawl snapshot, ≤6000 chars) + `websiteKbFetchedAt`. One per sub-account. |
| `subAccounts/{id}/aiAgent/{channelId}` | sub-account read; server-only write | Per-channel operational config. Channels today: `sms`, `web-chat`, `whatsapp`, `voice`. Carries `enabled`, `contextMessageCount`, `modelOverride`, `escalationKeywordsOverride`, `escalationNotifyEmailOverride`, `totalTokensUsed`. The `web-chat` doc nests a `webChat` block (`allowedDomains`, `welcomeMessage`, `accentColor`, `position`); the `whatsapp` doc nests `whatsapp` (`sessionWindowHours`); the `voice` doc nests `voice` (Vapi linkage + render prefs + the **Outbound** block: `outboundEnabled`, `outboundFirstMessage`, `outboundSystemPrompt`, `outboundWindow`, the per-minute/daily/per-number caps, `allowedCountries`). Outbound has no separate channel doc — it rides the `voice` doc. |
| `subAccounts/{id}/aiConfig/main` | sub-account read; server-only write | **Legacy.** Pre-refactor combined config. Kept readable so `lib/comms/ai/agent.ts::maybeMigrateLegacy()` can lazily split it into the new `aiAgent/profile` + `aiAgent/sms` shape on first read. Safe to remove after every sub-account has been migrated. |
| `subAccounts/{id}/webChatSessions/{sessionId}` | sub-account read; server-only write | One row per Web Chat thread. Anonymous-first — `contactId: null` until the bot captures identity. Carries `pageUrl`, `referrer`, `origin`, `visitorIp`, `visitorUserAgent`, `status` (active/closed/escalated), `messageCount`, `tokensUsed`, `capturedName/Email/Phone`, `capturePromptShownAt`, `captureSkipped`, `pendingFollowUpTaskId`. Session id = a UUID generated client-side and stored in localStorage. |
| `subAccounts/{id}/webChatSessions/{id}/messages/{id}` | sub-account read; server-only write | Per-turn transcript. `direction` inbound/outbound, `body`, `tokens`, `aiGenerated`. Visitor sees the body with any `[[capture …]]` / `[[form …]]` markers stripped. |
| `subAccounts/{id}/voiceCalls/{callId}` | sub-account read; server-only write | One summary doc per voice call (doc id = Vapi `call.id` for retry-dedup). Carries `direction` (`inbound` \| `outbound`), `callerPhone`, `toPhone`, `durationSec`, `summary`, `endedReason`, `contactId`, captured fields, `callbackRequested`, `taskId`, inline `transcript[]`, and live-status fields. Written by the Vapi end-of-call + status webhooks. |
| `voiceCampaigns/{campaignId}` | sub-account read; server-only write | Bulk Outbound Voice campaign (top-level, like `quotes`). Carries tenancy, `code` (`VC-YYYY-NNNN`), `name`, `audienceFilter` (reuses `BroadcastAudienceFilter`), `suppression`, `consentAck`, `status` (queued → calling → completed/cancelled/failed), and `totals` (audienceSize/queued/called/skipped/failed/interested). |
| `voiceCampaigns/{campaignId}/recipients/{contactId}` | sub-account read; server-only write | Per-recipient row — the QStash fan-out unit. Doc id = contactId. Carries `toPhone`/`toName` snapshot, `status` (queued/called/skipped/failed), `skippedReason`, `callId`, `callControlUrl` (for the stop-all kill switch), `outcome`, `callDurationSec`, `endedReason`, `callSummary`, `taskId`, `attempts`. Mirrors the bulk-email `broadcasts/{id}/sends` model. |
| `subAccounts/{id}/contactPhoneIndex/{mode}_{e164}` | server-only | **Never persisted — a lock path.** `POST /api/v1/contacts/upsert` reads it and then writes a delete to it inside its transaction, so two concurrent calls for one phone contend and one re-runs. Nothing is stored, so no phone outlives its contact here. See `lib/server/contact-upsert.ts`. |
| `subAccounts/{id}/counters/voiceCampaignNumbers` | server-only | Per-sub-account sequence counter for the `VC-YYYY-NNNN` campaign code generator. Same atomic-increment shape as `quoteNumbers`. |
| `subAccounts/{id}/counters/quoteNumbers` | server-only | Per-sub-account sequence counter for the year-prefixed `Q-YYYY-NNNN` quote number generator. `{ year: number, seq: number, updatedAt }`. Atomic increment via Firestore transaction in `lib/quotes/number.ts::issueQuoteNumber()`. Never touched by clients — the resulting number returns in the create-quote API response. |
| `quotes/{id}` | sub-account read/create/update/delete | Operator-built quote. Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `contactId`, `quoteNumber` (e.g. `Q-2026-0001`), `status` (draft → sent → viewed → accepted/declined/expired → paid), `currency`, `lineItems[]`, `globalDiscount`, `globalTaxPercent`, `termsAndNotes`, `billedToOrganization`, `validUntil`, `autoCreateDealOnAccept`, lifecycle stamps (`sentAt`, `viewedAt`, `acceptedAt`, `declinedAt`, `declineReason`, `declineNote`, `paidAt`), and `publicTokenHash` (SHA-256 of the most recent HMAC-signed public token — raw token never persisted). Edits allowed on sent quotes per v1 spec. |
| `trackedLinks/{id}` | sub-account read; server-only write | Tracked link (GHL "Trigger Link", top-level like `quotes`). Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `mode` (`live`\|`test` — API-created links inherit the key's mode, dashboard links are always `live`), `name`, `destinationUrl` (validated http(s) at write AND read), and click stats (`clickCount`, `lastClickedAt`). Read from the browser so the workflow builder's link picker can list them; every write goes through Admin-SDK routes, including the click counters asserted by the public `/l/{token}` redirect. |
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
display-only). `subAccounts/{id}/gbpEvents/{auto}` is a server-only,
append-only audit log (`listing_selected`, `listing_cleared` with a `reason`;
`reply_posted` / `reply_deleted` with `actorUid` + `reviewDocId` — never the
reply text; `review_url_adopted` with `previousUrl`, `url`, `actorUid`;
tenant-anchored with `agencyId`, `subAccountId`, `createdByUid`); no client
rule, so default deny. No new index.

Explicit replies: `subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}`
is the reply idempotency ledger — `status` (`pending` / `succeeded` /
`failed`), `reviewDocId`, `commentHash` (sha256 of the reply, never its text),
`replyUpdateTime`, `errorKind`, `at`; tenant-anchored. Written by the reply
route only (Admin SDK); no client rule, so default deny; no index. A posted or
deleted reply changes only the cached review's `reply` and `contentHash`.

Review sync (all written by the sync core only, Admin SDK; no client rule, so
default deny; no composite index): `subAccounts/{id}/gbpReviews/{sha256(review.name)[:40]}`
caches the CURRENT listing's reviews (tenant-anchored; `state` active/removed
tombstones; deleted after 30 days unseen); `subAccounts/{id}/gbpSyncRuns/{runId}`
is an append-only run record (created once per run, kinds and counts only);
`private/gbpSyncState` holds the run lease, the pass cursor (with the pass's
rating/count), `retentionPurgedAt`, the anomaly streak and the Sync-now
cooldown. Sub-accounts that hold a cache but can no longer sync (gate off,
disconnected, no listing) get retention-only passes from the sweep. The
member-readable `gbpSummary` field on the parent carries rating, count,
freshness and health kinds. Selecting another listing, clearing it or
disconnecting deletes the reviews, the sync state and the summary.

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
