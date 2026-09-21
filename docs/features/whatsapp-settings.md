# WhatsApp settings (SP15)

Settings → WhatsApp (`/sa/[id]/dashboard/settings/whatsapp`, `max-w-3xl`) is
GHL's Settings → WhatsApp page for a sub-account's connected Meta Cloud
number. Decisions and recorded Meta fixtures: [docs/parity/sp15.md](../parity/sp15.md).

## What the page shows

- **Header** — flag (dial-code → ISO), display number, verified name, a
  "Connected" pill from the node's `status`, and the quality badge
  (`quality_rating` → Green / Yellow / Red / Unknown). All read LIVE from the
  phone-number node on every load; the stored hourly reading is returned
  alongside but the badge is Meta's current answer.
- **Profile tab** — the WhatsApp Business Profile: photo (resumable upload →
  `profile_picture_handle`), display name (read-only; Meta changes it through
  name review, so `name_status` is shown instead), about (139), description
  (512), category (Meta's `vertical` enum), address (256), email (128), up to
  two http(s) websites (256 each). Save PUTs the full form; the response is
  re-read from Meta so the form shows what Meta stored. A phone-frame preview
  renders from the live form state. Nothing is cached in Firestore.
- **Message Links tab** — Meta `message_qrdls`: create with a prefilled text
  (≤140), copy the `wa.me/message/<code>` link, show the SVG QR, delete
  (inline confirm). No edit — Meta has none.
- **Templates tab** — a pointer to `/sa/[id]/ai-agents/whatsapp/templates`.
- Gate off → locked card; no Cloud number → empty card linking to Settings →
  Messaging. Non-admins see everything read-only.

## Routes (`/api/sub-accounts/[id]/whatsapp/*`)

Read = any active member, write = sub-account admin; all require
`whatsappEnabledByAgency`. No Cloud connection → 409 `{error:"not_connected"}`.
A Meta failure is relayed with its status (clamped 400–502) and Meta's
message with the token redacted. The photo route sniffs JPEG/PNG magic bytes
and caps at 5 MB. `status` also returns `openAlert` (the newest unresolved
quality alert) for the banner.

## Quality poll and alert

`leadstack-whatsapp-quality` (QStash, `15 * * * *` → `POST /api/cron/whatsapp-quality`,
signature-bound to that path) polls every sub-account with
`whatsappProvider == "cloud"` and a `whatsappCloudMeta.phoneNumberId`, and
stores `whatsappCloudMeta.quality = { rating, nameStatus, status, checkedAt, changedAt }`.

`evaluateQualityTransition` (pure): **drop** iff the stored rating was GREEN
and the new one is YELLOW or RED; **recovered** iff stored was YELLOW/RED and
the new one is GREEN; a first reading never alerts. A drop writes
`subAccounts/{id}/whatsappQualityAlerts/{auto}` (tenant-anchored,
`createdByUid: "system"`, `resolvedAt: null`), pushes to the sub-account
(`sendPushForEvent`, tag `wa-quality-<phoneNumberId>`) and emails the agency
owner (ownerUid → `users/{uid}.email`, else `agency.supportEmail`; via the
sub-account's email rail when configured, `archive: false`). Recovery sets
`resolvedAt` on the open alerts and sends nothing — an "all clear" every
time Meta flaps would train people to ignore the real one. Tenants are
isolated: one failure is counted, the sweep continues.

## Provider seam and the fake

`src/lib/comms/whatsapp/settings/`: `WhatsappSettingsProvider` with a Graph
arm (`graph.ts`, fetch-injectable, unit-tested over the recorded fixtures)
and a fake arm (`fake.ts`, scenario at `private/whatsappFakeScenario`,
every mutating call logged to `calls`). Obtain one ONLY via
`getWhatsappSettingsProviderFor(subAccountId)`.

The fake is selected from server env alone and refused (never silently
replaced by Meta) unless ALL of: `WHATSAPP_SETTINGS_PROVIDER=fake`,
`NEXT_PUBLIC_APP_URL` is exactly `127.0.0.1` / `localhost` / `[::1]`,
`NODE_ENV !== "production"` or `WHATSAPP_FAKE_ALLOW_PROD_BUILD=1`, and
`WHATSAPP_FAKE_AGENCY_ID` is set and the sub-account belongs to it (dev and
CI use the production Firestore). `scripts/gbp-deploy-check.mjs` refuses a
deploy whose env even mentions these names and requires the loopback check
inlined into the build to carry the production URL — for BOTH fakes.

Env: [docs/environment.md](../environment.md) — `WHATSAPP_GRAPH_VERSION`
(optional), and the three dev/CI-only `WHATSAPP_SETTINGS_PROVIDER` /
`WHATSAPP_FAKE_ALLOW_PROD_BUILD` / `WHATSAPP_FAKE_AGENCY_ID`.

No outbound message is sent from anywhere in this feature.
