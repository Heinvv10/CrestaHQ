# Firestore Collections

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*
| Collection | Scope | Notes |
|---|---|---|
| `agencies/{agencyId}` | agency-read | Agency profile + Stripe billing (one per deployment in v1) |
| `agencies/{agencyId}/agencyMembers/{uid}` | agency-read | Owner / staff list |
| `agencies/{agencyId}/plans/{planId}` | server-only | Client Billing v1 plan docs (monthly price + feature-gate bundle + Stripe product/price ids). All access via the owner-only `/api/agency/plans` routes |
| `billingEvents/{id}` | server-only | Client Billing v1 append-only audit trail (plan assigned/switched, comped, activated, dunning transitions) |
| `subAccounts/{subAccountId}` | members + agency owner | Workspace metadata; reserved fields for Workflow-Recipes Twilio/Resend/booking/sendWindow |
| `subAccounts/{subAccountId}/subAccountMembers/{uid}` | admins | Per-sub-account membership rows |
| `userMemberships/{uid}/subAccounts/{saId}` | self-read | Denormalized index powering the sub-account switcher |
| `userMemberships/{uid}/agencies/{agencyId}` | self-read | Denormalized index for agency-level access |
| `users/{uid}` | self only | Slim profile (display name, photoURL, primaryAgencyId) |
| `appConfig/main` | active members | Bootstrap singleton: `firstAgencyId`, `firstAgencyOwnerUid` |
| `system/heartbeat` | server-only | Instance id + last-heartbeat timestamp (gitpage status checks) |
| `system/gitpageStatus` | active members read | Cached gitpage subscription state; drives the activate-banner UI |
| `invites/{auto}` | agency owner / sub-account admin | Typed invites (carry `subAccountId` + `subAccountRole`) |
| `contacts/{id}` | sub-account | Carries `agencyId`, `subAccountId`, `createdByUid` |
| `contacts/{id}/notes/{id}` | inherits | Free-text notes |
| `contacts/{id}/activities/{id}` | inherits | Typed events |
| `deals/{id}` | sub-account | One contact → many deals |
| `events/{id}` | sub-account | Calendar events |
| `tasks/{id}` | sub-account | Todos |
| `forms/{id}` | sub-account | Form config |
| `forms/{id}/submissions/{id}` | sub-account read, server-write | Inbound submissions; route stamps tenancy from the form doc |
| `usage/{subAccountId}/users/{uid}` | self/owner read | Email + SMS quotas |
| `mail/{id}` | server-only | Trigger-Email extension queue |
| `automations/{id}` | sub-account; admin-write | Recipe configs (one per attached form). Carries `agencyId`, `subAccountId`, `recipeType`, `trigger`, `config`, `enabled` |
| `message_templates/{id}` | sub-account; admin-write | Reusable email + SMS bodies with merge tags |
| `automation_executions/{id}` | sub-account read; server-only write | Per-firing run rows; the QStash callback executor mutates these |
| `contacts/{id}/messages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | SMS chat thread when the sub-account has dedicated Twilio enabled. Doc id = Twilio MessageSid for natural dedupe on retries. |
| `contacts/{id}/whatsappMessages/{id}` | sub-account read; server-only create/delete; client `readAt`-only update | WhatsApp chat thread (same model as `messages`). Populated by the WhatsApp inbound webhook + `/api/comms/whatsapp/send` + `/api/comms/whatsapp/send-template`. Doc id = Twilio MessageSid. |
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
| `subAccounts/{id}/counters/voiceCampaignNumbers` | server-only | Per-sub-account sequence counter for the `VC-YYYY-NNNN` campaign code generator. Same atomic-increment shape as `quoteNumbers`. |
| `subAccounts/{id}/counters/quoteNumbers` | server-only | Per-sub-account sequence counter for the year-prefixed `Q-YYYY-NNNN` quote number generator. `{ year: number, seq: number, updatedAt }`. Atomic increment via Firestore transaction in `lib/quotes/number.ts::issueQuoteNumber()`. Never touched by clients — the resulting number returns in the create-quote API response. |
| `quotes/{id}` | sub-account read/create/update/delete | Operator-built quote. Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `contactId`, `quoteNumber` (e.g. `Q-2026-0001`), `status` (draft → sent → viewed → accepted/declined/expired → paid), `currency`, `lineItems[]`, `globalDiscount`, `globalTaxPercent`, `termsAndNotes`, `billedToOrganization`, `validUntil`, `autoCreateDealOnAccept`, lifecycle stamps (`sentAt`, `viewedAt`, `acceptedAt`, `declinedAt`, `declineReason`, `declineNote`, `paidAt`), and `publicTokenHash` (SHA-256 of the most recent HMAC-signed public token — raw token never persisted). Edits allowed on sent quotes per v1 spec. |
| `socialPosts/{id}` | sub-account read; server-only write | Social Planner post (top-level, like `quotes`). Carries tenancy (`agencyId`, `subAccountId`, `createdByUid`), `caption`, `imageUrl`, `targets` (`("facebook"\|"instagram")[]`), `status` (draft → scheduled → publishing → published/failed), `scheduledAt`, `publishedAt`, per-target `results[]` (`{platform, status, externalId, error}`), and `qstashMessageId`. Reads stream to the content calendar via `subscribeToSocialPosts`; all writes go through Admin-SDK routes (rules are read-only for members, mirrors `products`). |

