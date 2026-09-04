# Public API v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

A versioned REST surface under `/api/v1/*` for the sub-account-scoped resources (contacts, deals, tasks, events, form submissions) plus signed outbound webhooks. Built so an agency's clients can plug LeadStack into Zapier, Make, n8n, or custom integrations without operator hand-holding.

## Authentication + keys

- Sub-account admin mints keys from the dashboard's **API Keys** section. Keys are scoped to one sub-account and one mode (`live` or `test`). Format: `lsk_{mode}_{prefix}_{secret}`. Only the SHA-256 hash of the secret is persisted (`subAccounts/{id}/apiKeys/{keyId}.secretHash`); the raw secret is shown ONCE at creation time and never again.
- Every `/api/v1/*` request includes `Authorization: Bearer lsk_…`. The auth helper `lib/api/auth.ts::requireApiKey()`:
  1. Parses the bearer header, looks up the key by prefix + verifies the SHA-256 hash matches the stored hash.
  2. Loads the sub-account doc, checks `apiAccessEnabledByAgency === true` (returns 403 `api_access_disabled` otherwise — see Agency feature gates).
  3. Returns a `{ subAccountId, agencyId, keyId, mode }` context. Every downstream Firestore query filters by `subAccountId` so a leaked key only ever sees its own sub-account.
- **Test mode** (`lsk_test_*`) lets the buyer's clients exercise the API without firing real automations / SMS / emails — the form-submission route, for example, gates `fireTriggers()` on `ctx.mode === "live"`.

## Infrastructure modules

All under `src/lib/api/`:
- `auth.ts` — `requireApiKey()` + key hashing.
- `keys.ts` — mint / list / revoke helpers.
- `responses.ts` — uniform `{ data, error }` envelope + pagination cursors.
- `versions.ts` — version-pinning header (`x-api-version`) so future v2 doesn't break v1 callers.
- `idempotency.ts` — replay protection. POSTs accept `Idempotency-Key`; the helper stores `(key, requestHash, responseSnapshot)` on `idempotency/{subAccountId}/{key}` for 24h and replays the saved response on duplicate keys.
- `rate-limit.ts` — per-key token bucket (in-memory LRU, defaults to 60 req/min). Returns `429` with `Retry-After`.
- `redact.ts` — installs a console wrapper that masks `lsk_*` secrets in logs so a stray `console.log(req.headers)` doesn't leak a tenant key.
- `logs.ts` — append-only request log per key for debug visibility in the dashboard.
- `serializers/{contacts, deals, tasks, events}.ts` — strict wire-format mappers so internal field renames don't accidentally break API consumers.

## Webhooks

Outbound webhooks let the sub-account react to platform events (contact created, deal moved, event booked, …) without polling.

- Sub-account admin creates a subscription from the dashboard's **Webhooks** section: target URL + event-type allowlist + signing secret (auto-generated).
- `lib/api/webhooks/dispatch.ts::emitWebhookEvent({subAccountId, type, payload})` is the fan-out helper called from every state-changing route (contact.created, form.submission.created, event.booked, etc.). It looks up matching subscriptions for the sub-account, signs each payload (`lib/api/webhooks/signing.ts` — HMAC-SHA256 with the subscription secret), and POSTs in the background with retries on 5xx.
- Receivers verify by recomputing HMAC over the raw body using the secret they were shown at creation. Standard `Webhook-Signature` + `Webhook-Timestamp` headers; reject requests older than 5 minutes to defeat replays.
- **Assistant actions** (AI Suite, sub-account level + agency-delegated): `list_webhooks` (readonly; output includes the subscription ids), `create_webhook` (confirm-gated; creates + fires one synchronous signed test via [lib/webhooks/direct-test.ts](../../src/lib/webhooks/direct-test.ts) and reports the HTTP result, with n8n test-vs-production URL coaching), `send_webhook_test` (confirm-gated; re-fires a signed sample event at an EXISTING subscription — the chat equivalent of the Webhooks section's send-test button, for "my n8n node is listening now, test it again" loops; optional `eventType` override, refuses paused hooks), and `update_webhook_url` (confirm-gated; repoints an existing subscription at a new URL and tests the new URL immediately — `switchToN8nProduction: true` derives the `/webhook/` Production URL server-side from the stored `/webhook-test/` URL, so "activate the n8n workflow, then ask the assistant to make it live" is one confirm; auto-resumes a circuit-breaker-paused hook since the pause belonged to the old URL; events/secret/mode unchanged). All honor the `apiAccessEnabledByAgency` kill switch; test deliveries land in Logs → Webhooks like real ones.

## Operator surfaces

Three sub-account settings sections:
- **API Keys** ([components/settings/sub-account-api-keys-section.tsx](../../src/components/settings/sub-account-api-keys-section.tsx)) — mint, label, revoke; one-time secret reveal modal on create.
- **API Recipes** ([components/settings/sub-account-api-recipes-section.tsx](../../src/components/settings/sub-account-api-recipes-section.tsx)) — curated recipe library (Zapier, Make, n8n, plain cURL) wired to the live API base URL + per-key auth header so the buyer's client can copy-paste.
- **Webhooks** ([components/settings/sub-account-webhooks-section.tsx](../../src/components/settings/sub-account-webhooks-section.tsx)) — subscription CRUD + delivery log viewer (last 50 attempts, with status code + retry count).

All three render a "locked by your agency" state when `apiAccessEnabledByAgency !== true`, mirroring the email-domain section's pattern.

## Setup contract

**No new env vars.** Reuses `NEXT_PUBLIC_APP_URL` (for the docs base URL displayed in API Recipes), Firebase (key/subscription storage). The API key hash uses the same SHA-256 utility the rest of the codebase uses — no separate signing secret needed.

