# Slack notifications

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

> **Status: NOT runtime-verified.** No real Slack Incoming Webhook URL has been
> connected on any deployment, so no post has ever reached Slack. The code is
> inert until a sub-account admin pastes a URL; the first one triggers a live walk
> (connect, a ticked event posts, Send test, Disconnect). The e2e spec
> (`e2e/specs/slack-settings.spec.ts`) covers only the card and the refusals.

Ported from upstream LeadStack 1.0.54 (`bceae0fc`), unit E1 of
`UPSTREAM_PORT_PLAN_1_0_54.md`. One Slack Incoming Webhook URL per sub-account,
posted to from the webhook event stream. No Slack app, no OAuth, no inbound
actions. The assistant tools (`slack_status`, `configure_slack_events`,
`connect_slack`) are a separate unit (T2) and are not here.

## Settings card

Settings → Admin tab → **Slack notifications**
([sub-account-slack-section.tsx](../../src/components/settings/sub-account-slack-section.tsx)),
admins only. Paste the URL (and an optional channel label), and the server posts a
test message before anything is stored. The card says in one line that posts carry
contact names, emails, phone numbers and amounts to the client's Slack workspace.
Once connected it shows the label, the URL's last 4 characters, the last post time
and last error, the event picker (every `WEBHOOK_EVENT_CATEGORIES` entry) and the
"Include the message text" option. Reconnect means pasting a new URL; the old one is
never shown again.

Defaults on connect: `contact.created`, `message.received`, `booking.created`,
`call.missed`, `quote.accepted`, `quote.declined`, with `includeMessagePreview` off.
A reconnect keeps the ticked set and the preview choice.

## Routes (`/api/sub-accounts/[id]/slack`, sub-account admins)

`isDocId` on `[id]`, then `requireSubAccountAdmin`. No agency gate: the client's own
channel is all it spends.

- **GET** — `{ config }`: display meta only. Never the URL.
- **POST `{ webhookUrl, channelLabel?, events? }`** — validate, test-post, store.
  400 on a URL that isn't a Slack hook, 502 when Slack refuses the test post
  (nothing stored).
- **PATCH `{ events?, includeMessagePreview? }`** — at least one; unknown event
  names are dropped, `includeMessagePreview` must be a boolean.
- **DELETE** — deletes the private doc and sets `slackMeta` to null.
- **POST `…/slack/test`** — re-sends the "connected" message.

All five are `human-only` in `scripts/agent-coverage.json` until T2.

## The URL is a secret

It lives at `subAccounts/{id}/private/slack` (Admin SDK only); the sub-account doc
carries `slackMeta`, which every member can read, so it never holds the URL. See
[firestore-collections.md](../architecture/firestore-collections.md#slack-notifications).

`isSlackWebhookUrl` (`src/types/slack.ts`) is upstream's
`https://hooks.slack.com/services/…` regex AND a `new URL` check (https, host exactly
`hooks.slack.com`, default port, no credentials, `/services/` path), capped at 300
characters. It runs on the pasted URL and again on every read of the stored one, so a
doc that somehow holds another URL is never posted to.

## Posting

`postSlackMessage` ([client.ts](../../src/lib/slack/client.ts)) goes through
`publicFetch`: no redirect is followed (a 3xx is a failure), production connects
only to public addresses, the response read is capped at 4 KB, and one 5 s deadline
covers DNS, connect and read. A thrown error is logged by message only and recorded
as "Could not reach Slack."

The consumer ([events.ts](../../src/lib/slack/events.ts)) is registered in
`emitWebhookEvent` next to push, live mode only, as its own `runAfterResponse` task.
It never throws, and webhook deliveries never wait on it. It loads the hook (60 s
per-instance cache, dropped by the settings routes and after a revoke), skips events
that aren't ticked, spaces posts ~1/s per sub-account (overflow during a bulk import
is dropped with a log line, never retried) and stamps the outcome.

Stamps (`recordSlackResult`) run in a transaction that applies only while the stored
URL is still the one posted to. Successes stamp `lastSentAt` at most once a minute
per instance; failures always record `lastError`; only a 404/410 sets
`needsReconnect`, after which nothing posts until a new URL is saved.

## Messages

[format.ts](../../src/lib/slack/format.ts) builds a bold one-liner, a context line
and an "Open in {CUSTOM_BRAND.name}" button under `NEXT_PUBLIC_APP_URL` (no button
without it; ids in the path are URL-encoded). Event layouts: leads, inbound messages,
bookings, missed calls, quotes, deals, forms, tasks, orders, AI captures, and a
generic line for the rest.

Tenant text is escaped once, at the end: `&`, `<`, `>` become entities (so no
`<link|label>` or `<!channel>`), `*`, `~` and `` ` `` are dropped, the headline is
capped at 150 and the context at 400 characters before escaping; whitespace and
newlines in the headline collapse to single spaces.

`message.received` posts "New message from <first name>" and nothing else unless the
hook's `includeMessagePreview` is on; then it posts the name, channel and the first
200 characters of the message.

A write made with a public-API key or by an agent posts fixed copy ("<Category>
changed by an API agent", "New contact added by an API agent"), never the text the
key chose. It is keyed off the emit input: `byAgent`, or `actorUid` starting
`apikey:`. `actorUid` is set on every v1 route that emits (contacts delete, deals
create/update/delete, tasks create/update, events create/cancel, form submissions)
and by the services the agent tools write through (`createContactServerSide` /
`upsertContactByPhone` via `createdByUid`, `createDealServerSide`,
`updateDealServerSide`, `deleteDealServerSide`, `createTaskServerSide`,
`setTaskCompletedServerSide`, `patchTaskServerSide`, `createEventServerSide`).
Paths left without it post only fixed text anyway: `contact.updated` from
`updateContactServerSide`, `member.*`, and quote events (number, totals and signer
are server- or recipient-written). Billing and community events are not in the
picker.

**Limit (same as push):** the gate is on who made *this* write, not on where the
text came from. Text a key chose (a deal title, a task title, a contact name) still
posts when a person or a workflow later acts on that record: a member moving the
key-created deal, completing its task, or a workflow step updating it emits with
that actor, and the layout reads the stored title. Closing that would mean marking
key-written fields on the record and checking them here; it is not done.

## Tests

- `src/lib/slack/format.test.ts` — URL validator refusals, escaping, caps, headline
  whitespace, message preview on/off, agent copy.
- `src/lib/slack/agent-copy.test.ts` — v1 task and deal writes (create, complete,
  stage move, won) through the real routes post fixed copy; a person's task is the
  control.
- `src/lib/slack/cache.test.ts` — disconnect, reconnect and PATCH reach the next event.
- `src/lib/slack/throttle.test.ts` — ~1 s spacing; the 31st waiting post is dropped.
- `src/lib/slack/events.test.ts` — through the real `emitWebhookEvent`: posts,
  skips, deliveries still scheduled when Slack throws or hangs, 404/410 revoke, a
  stale revoke not flagging a replaced URL.
- `src/app/api/sub-accounts/[id]/slack/route.test.ts` — real admin check, GET never
  carries the URL, refused URLs never posted or stored.
- `src/lib/webhooks/ssrf-callers.test.ts` — a post to loopback is never reached; a
  302 is not followed.
