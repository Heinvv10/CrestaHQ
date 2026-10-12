# Web Voice (ElevenLabs)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

> **Status: connection backend only (WV-1). NOT runtime-verified.** It merges dark
> behind `webVoiceEnabledByAgency` (default off). No real ElevenLabs key has been
> connected, so no agent has ever been provisioned on a real account. The call path
> (WV-2), settings card (WV-3) and widget mic (WV-4) come later. The first client to
> switch the gate on triggers a live walk (UPSTREAM_PORT_PLAN.md, Hein's ruling 4).

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
- **GET** returns `gateOn`, `webChatGateOn`, the display meta and, with `?voices=1`
  and the gate on, the live voice list. A voice's preview URL is passed on only when
  it is a public https address.
- **DELETE** disconnects. It deletes the secret and usage docs, clears the meta, then
  deletes the agent on ElevenLabs (best-effort, logged; the key and agent id are read
  raw, so a damaged doc still gets its agent removed). When that remote delete fails
  the response carries a `warning` telling the client to delete the agent on
  ElevenLabs. It is **ungated**, so a client can always remove their key.

POST and PATCH answer 403 `{ code: "gate_off" }` while `webVoiceEnabledByAgency` is
off. An ElevenLabs failure during provisioning is not an error response: it is saved
as `webVoiceMeta.lastError` with `ready: false`. `connectedAt` is an ISO string in
every response.

**Never `ready` before WV-2.** The agent's custom-LLM URL points at
`/api/webhooks/elevenlabs/llm/...`, which WV-2 adds; until then it answers 404. So a
provisioned connection is stored with `ready: false` and `lastError` set to
`WEB_VOICE_CALL_PATH_PENDING` ("Voice replies aren't available on this deployment
yet"), and `webVoiceAvailable` never shows the mic. WV-2 removes that constant and lets
a clean sync report ready.

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
already have PATCHed the live agent, so after its 409 it re-reads the committed
connection and PATCHes the agent back to the winner's settings; if that fails it is
logged and recorded as `lastError` ("may not match these settings"), never thrown.

Outbound calls go only to the fixed host `https://api.elevenlabs.io` with the
sub-account's key. An agent or conversation id is put in a request path only if it
matches `^[A-Za-z0-9_-]{1,128}$`. ElevenLabs' error text can echo what we sent, so the
client cuts the key and the endpoint secret out of every error message before it is
stored or returned. Errors are logged as messages, never as objects.

## Not yet built

- WV-2: the call path. Signed-URL start, the custom-LLM reply webhook, usage
  metering and the daily cap, and `voiceEnabled` on `web-chat/config`.
- WV-3: the settings card. WV-4: the widget mic. WV-5: the website hand-off's voice
  step.
