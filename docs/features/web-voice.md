# Web Voice (ElevenLabs)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

> **Status: connection backend (WV-1) and call path (WV-2). NOT runtime-verified.** It
> merges dark behind `webVoiceEnabledByAgency` (default off). No real ElevenLabs key
> has been connected, so no agent has ever been provisioned on a real account and no
> real call has reached the reply endpoint. The settings card (WV-3) and widget mic
> (WV-4) come later. The first client to switch the gate on triggers a live walk
> (UPSTREAM_PORT_PLAN.md, Hein's ruling 4).

Ported from upstream LeadStack 1.0.40 (`68798611`). A sub-account connects its OWN
ElevenLabs API key, and website visitors can talk to the web-chat assistant through a
mic button in the chat widget. ElevenLabs does speech-to-text, text-to-speech and
turn-taking. Every reply comes from LeadStack's web-chat pipeline (ElevenLabs'
custom-LLM mode), so persona, knowledge base and lead capture are the same as typed
chat. The client's ElevenLabs account pays for the voice minutes. Each spoken reply
spends the agency's OpenRouter tokens, which is why the feature is agency-gated.

## Connection (`/api/sub-accounts/[id]/web-voice`, sub-account admins)

- **POST `{ apiKey }`** connects or replaces the key. The key is checked first by
  listing the account's voices, and a key ElevenLabs refuses is never stored. A new
  connection picks the first premade voice, and a re-key keeps the existing settings
  (and the voice, if the new account can see it). It then creates a **private**
  ElevenLabs agent (`enable_auth`, so only a signed URL we mint can start a
  conversation). The agent's custom-LLM URL is
  `{app}/api/webhooks/elevenlabs/llm/{subAccountId}/{endpointSecret}`, where `{app}`
  is `NEXT_PUBLIC_APP_URL` with redirects resolved (`lib/server/app-url.ts`). That
  must be a public https origin: on localhost or plain http the key is kept but the
  agent is not provisioned, and the card shows the reason (`lastError`). A different
  key may belong to a different ElevenLabs account, so a re-key provisions a new
  agent, mints a new endpoint secret (an old agent whose delete fails can no longer
  reach the reply endpoint), and deletes the old agent with the OLD key after the new
  connection is saved.
- **PATCH** saves settings (`enabled`, `voiceId`, `voiceName`, `language`, `greeting`,
  `maxCallSeconds` 60–1800, `dailyMinuteCap` 5–1440 minutes; out-of-range numbers are
  clamped, an unknown language or malformed voice id is a 400) and re-syncs the agent.
  An agent deleted on the ElevenLabs side (404) is re-created. If the re-sync fails,
  the new settings are NOT stored: the live agent still runs the old ones, so the old
  ones stay, and the failure shows as `lastError`.
- **GET** returns `gateOn`, `webChatGateOn`, the display meta, `usage`
  (`secondsToday`, `secondsThisMonth`, `activeNow`; null before a key is connected),
  `previewToken` (a widget token for the settings page's preview link, only while
  `webVoiceAvailable` is true, else null) and, with `?voices=1` and the gate on, the
  live voice list. A voice's preview URL is passed on only when it is a public https
  address.
- **DELETE** disconnects. It deletes the secret and usage docs, clears the meta, then
  deletes the agent on ElevenLabs (best-effort, logged; the key and agent id are read
  raw, so a damaged doc still gets its agent removed). When that remote delete fails,
  or cannot be tried because an agent id is stored without a key, the response
  carries a `warning` telling the client to delete the agent on
  ElevenLabs. It is **ungated**, so a client can always remove their key.

POST and PATCH answer 403 `{ code: "gate_off" }` while `webVoiceEnabledByAgency` is
off. An ElevenLabs failure during provisioning is not an error response: it is saved
as `webVoiceMeta.lastError` with `ready: false`. `connectedAt` is an ISO string in
every response.

A sync that leaves an agent in place with no error stores `ready: true`;
`webVoiceAvailable` shows the mic only when both agency gates (Web Voice and Web
Chat) are on, the meta is `ready` and the operator switch `enabled` is on.

## Storage and concurrency

The key, the agent id and the endpoint secret live only in
`subAccounts/{id}/private/webVoiceConnection` (Admin SDK only). The sub-account doc
carries the non-secret `webVoiceMeta`, which every member can read, so it never holds
a credential, and no response carries the key or the endpoint secret. See
[firestore-collections.md](../architecture/firestore-collections.md#web-voice-elevenlabs).

All state changes go through one transaction (`commitWebVoiceState` in
`lib/server/web-voice-service.ts`). It writes the secret doc and the meta together,
and only if the secret doc's `rev` is still the one the caller read before talking to
ElevenLabs. If another connect, save or disconnect committed in between, the request
gets a 409 and writes nothing, and an agent it had just created is deleted so no
orphan is left on the client's account. `rev` is a fresh random id on every write, so
a disconnect followed by a reconnect never matches a stale reader. A losing save may
already have PATCHed the live agent, so after its 409 (or any other failed commit) it
re-reads the committed connection and PATCHes the agent back to the winner's settings. It then re-reads: if
another save committed while that PATCH was in flight (same key and agent, new `rev`),
it PATCHes again with the newest settings, at most three passes. A failed PATCH, or
settings still changing after the third pass, is logged and recorded as `lastError`
("may not match these settings"), never thrown.

One race remains: a rival save that has PATCHed the agent but not yet committed when
the restore re-reads is invisible to it. The restore's PATCH can land after the
rival's, and the rival then commits normally, so the live agent keeps the restore's
(older) settings while Firestore shows the rival's, with no `lastError`, until the
next save re-syncs it. Closing this would need a lock held across the ElevenLabs call.

Outbound calls go only to the fixed host `https://api.elevenlabs.io` with the
sub-account's key. An agent or conversation id is put in a request path only if it
matches `^[A-Za-z0-9_-]{1,128}$`. ElevenLabs' error text can echo what we sent, whole
or truncated, so the client caps every error message at 1,000 characters and replaces
any run of 8 or more characters that occurs inside the key or the endpoint secret
before it is stored or returned; for a request whose body carried the secret (agent
create and update) every URL in the text is replaced too. Errors are logged as messages, never as objects.

## Call path (WV-2)

One conversation, end to end:

1. **`GET /api/web-chat/config`** (the widget loader, origin-checked against the
   channel's allowed domains) answers `voiceEnabled: true` and a 12-hour **widget
   token** (`w1.…`) only while `webVoiceAvailable` holds, an agent is provisioned and
   today's COUNTED seconds (settled calls and charged lapsed grants) leave room for one more full-length call. Anything else,
   including any error, is `voiceEnabled: false` with no token.
2. **`POST /api/web-chat/voice/start`** `{ sa, sessionId, voiceToken, pageUrl?,
   referrer? }` (body capped at 8 KB). In order: the widget token for this
   sub-account → 12 starts per IP per hour (see *Per-IP limit* below) → gates and a ready connection (403
   `voiceEnabled: false`) → the Web Chat channel on → inside business hours and the
   thread not held by a human (409, mic kept) → the workspace's monthly AI-token quota
   (429 `voiceEnabled: false`) → a sweep that settles finished calls → a **grant**
   reserved in ONE transaction on `private/webVoiceUsage` against the concurrency
   limit (3 per sub-account) and the daily cap, where every pending call and every
   live grant counts as a full `maxCallSeconds` (429; `busy` keeps the mic,
   `daily_cap` hides it). A grant is live for 2 minutes: exactly the window in which
   it counts as a grant AND can be claimed. After that it **lapses and is charged**
   its full reservation (see *Unreported calls* below). Then the chat session is created, and the answer
   is a 15-minute signed URL minted with the client's own key plus a 1-hour
   **session token** (`s1.{sa}.{session}.{grant}.{exp}.{sig}`) for the browser to pass
   to ElevenLabs as the custom-LLM extra body. A grant reserved before a later step
   fails is not released; it lapses (fail closed).
3. **`POST /api/web-chat/voice/event`** `{ token, type, conversationId }` (2 KB cap;
   also accepted as a `text/plain` beacon). `connected` moves the grant to `pending`
   under the ElevenLabs conversation id, once, and only when the grant is still live
   and ElevenLabs reports that conversation as live (`initiated`/`in-progress`) on
   this sub-account's agent, with a `start_time_unix_secs` no earlier than the grant's
   issue time (30 s skew allowed). A grant takes ONE conversation id: the first id
   tried is pinned on it in a transaction, and any other id is refused without a
   lookup. The lookup is retried up to 3 times, 1 s apart, on a 5xx only; a 404 is
   final (so the widget must not report `connected` before ElevenLabs has the
   conversation — see *WV-4 requirements*). A replay, a lapsed grant, or a settled, finished, older,
   forged or foreign id claims nothing, and so does a claim when pending calls
   alone already fill the concurrency limit (re-checked in the claim's
   transaction). It then writes the spoken greeting into the transcript.
   Ids that name an `Object.prototype` member (`__proto__`, `constructor`, …) are
   refused (400), and every map in the usage doc is read only as own properties.
   `ended` settles the call, only when the token's session is the one that claimed
   it. The route allows 6 events per grant and 120 per IP per hour (in memory,
   best-effort), since each `connected` costs the client's key a lookup. These
   pings only account for a call `start` allowed,
   so they are not gated: a call that began before the gate went off still settles.
4. **`POST /api/webhooks/elevenlabs/llm/{sa}/{endpointSecret}[/chat/completions]`**
   on every spoken turn, from ElevenLabs. The path secret is compared with the stored
   one in constant time (both hashed first, so length leaks nothing); a mismatch is
   401 before the body is read. The body is capped at 1 MB. Then, each failure
   answered as a short spoken line with HTTP 200: the session token must be valid
   and for THIS sub-account, the gates are re-checked, and the token's grant must
   still hold a reservation (a grant younger than 2 minutes, or claimed by a call
   not yet settled). Only the visitor's latest utterance is read; ElevenLabs' system
   prompt, history, `model`, `tools` and every other field are ignored. The reply
   comes from `respondToWebChat` in voice mode: the same persona, KB, hours,
   escalation, capture, inbox mirroring, AI controls and AI-token quota as typed chat,
   plus a spoken-reply prompt block, `maxTokens: 220`, no `[[form]]` (dropped, and
   the session is not stamped as "form shown"), and both turns stored with
   `via: "voice"`. The channel's own model is used; no tools are passed.

**Settling.** The duration always comes from ElevenLabs (`GET
/v1/convai/conversations/{id}`), never from the browser. A live call stays pending.
A call ElevenLabs does not know (404), attributes to another agent, or reports as
started before its grant was issued (or with no start time) is counted at the full
reservation; so is one past `maxCallSeconds + 2 min` with no duration, or
one whose lookups have failed for 30 minutes. One transaction removes the pending
entry, adds the seconds to today's and this month's counters and to the session's
`voiceSeconds`, so racing settles count a call once. Usage and grants are counted
per UTC day.

Tokens are HMACs under `AUTOMATIONS_TOKEN_SECRET` (at least 16 characters, else no
token is minted and the mic stays hidden), compared in constant time, with an expiry.
Every id in a token must be a Firestore doc id.

**ElevenLabs' list is the source of truth for minutes.** The browser reports
`connected` and `ended`; the cap does not depend on it doing so.
- A grant nobody claims within its 2 live minutes is **charged its full
  reservation** (its own stored `seconds`) in whichever transaction next reads the
  usage doc (read-only paths compute the same charge), and kept under `lapsed`.
  This provisional charge holds the cap until the list has spoken.
- The usage doc keeps a **watermark**, `reconciledThroughMs` for
  `reconciledAgentId`: every conversation of that agent that started before it has
  been counted. It starts 30 s before the agent's first grant (a private agent has
  no conversation before a signed URL we mint).
- Every sweep (each `/voice/start`, and `web-chat/config` when the cap looks
  reached, see below) lists ALL the agent's conversations that started in
  [watermark, now − (`maxCallSeconds` + 2 min)), so every one in range has ended.
  It counts each one that no claim covers (not pending, not in `settled`) at its
  real duration: an unreported call, a call started on another grant's URL, or a
  second call run on a claimed call's token are all counted. Then it refunds every
  lapsed grant of this agent whose signed URL expired before the new watermark
  (any call it started has been counted in its own right), and advances the
  watermark. All in one transaction that applies only if no other sweep moved the
  watermark first, so racing sweeps count a call once.
- Any doubt and the sweep does NOTHING and logs how many items and why: the list
  cannot be read in full (10 pages of 100), has no `conversations` array, or an
  item that is or may be in range has no id, agent id, start time or duration, or
  is still running and not pending. Pending and settled ids are excluded before
  that check.
- A refund only comes off the day and month the charge went into.
- A re-keyed connection (a new agent) starts its own watermark at its first grant.
  The old agent's calls are not on the new list, so its lapsed charges are never
  refunded and its pending calls settle at the full reservation (the new key
  cannot read them).

A visitor who taps the mic and never connects costs the cap a full call until the
sweep after the grant's signed URL expires behind the watermark (about 22 minutes
with 5-minute calls). **The config route sweeps too:** when it finds the cap
reached it runs the sweep after the response (`runAfterResponse`), at most once a
minute per sub-account per instance, so a cap filled by abandoned starts recovers
without a visitor reaching `/voice/start` (which the hidden mic would prevent).

**Per-IP limit.** `clientIpFrom` (`lib/checkout/rate-limit.ts`) keys on
`cf-connecting-ip` when `TRUST_CF_CONNECTING_IP=1`, which `deploy-velo.sh` requires
in production. On velo the app binds 127.0.0.1 and is reached only through the
Cloudflare tunnel, and `crestahq-proxy` passes the headers through untouched
(`deploy/velo/crestahq-proxy.nginx.conf`). So the bucket is per visitor, keyed on
the IP Cloudflare saw (the start call comes from the visitor's own browser). Buyer
copies on Vercel leave it unset and key on the right-most `X-Forwarded-For` hop.

**Storage.** The usage doc is under `subAccounts/{id}/private/`, which
`firestore.rules` (`match /private/{docId} { allow read, write: if false; }`
inside `match /subAccounts/{subAccountId}`) closes to every client; only the Admin
SDK reads or writes it.

**Not runtime-verified, and assumed:** that ElevenLabs appends exactly
`/chat/completions` to a custom-LLM URL (middleware opens only the bare URL and that
tail), passes the extra body through as `elevenlabs_extra_body`, reports
`agent_id`, `metadata.call_duration_secs` and `metadata.start_time_unix_secs` on a
conversation, and lists an agent's conversations with the filters, fields
(`conversation_id`, `agent_id`, `status`, `start_time_unix_secs`,
`call_duration_secs`) and paging (`has_more`, `next_cursor`) `listConversations`
expects. `src/lib/web-voice/elevenlabs.contract.test.ts` pins our reading of both
response shapes, written from the API reference (ASSUMED, not recorded): replace
them with recorded responses on the first live walk. If the start time is missing,
every claim fails closed and every list sweep does nothing, so every grant stays
charged in full.

**No end-to-end call yet.** Nothing in the widget calls this path until WV-4 wires
the mic into the chat window (and the embed iframe gets `allow="microphone"`).

**WV-4 requirements.** The widget must call `getUserMedia` (and have the
microphone granted) BEFORE `POST /voice/start`, and start the ElevenLabs session
immediately with the signed URL it gets back. A start whose call never connects
costs the cap a full call until the next sweep refunds it, and a grant can be
claimed only in its first 2 minutes. It must report `connected` once, with the
conversation id ElevenLabs gives it (a different id is refused), and `ended` once
(a beacon on page hide is fine).

**Residual risk.** A visitor who never reports a call still spends the client's
ElevenLabs minutes, up to `maxCallSeconds` per start (bounded by the per-IP start
limit and the agent's concurrency limit on ElevenLabs); the cap counts it, but only
from the next sweep. The reply endpoint cannot tie a turn to a conversation (it
sees the session token, not the conversation id), so a second, unreported
conversation can use a claimed call's token for AI replies while that claim is
pending (up to the agent's concurrency limit of 3 on ElevenLabs); its minutes are
counted by the sweep, its AI tokens by the workspace quota.

## Not yet built

- WV-3: the settings card. WV-4: the widget mic. WV-5: the website hand-off's voice
  step.
