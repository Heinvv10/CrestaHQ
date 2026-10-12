# Browser phone dialer (Softphone v1)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

> **Status: server (SP-2) and UI (SP-3) merged. NOT runtime-verified.** It merges
> dark behind `dialerEnabledByAgency` (default off). No call has gone through a real
> Twilio account, and the UI (Call button, call bar, settings card, recording link)
> has **not been loaded in a browser against real Twilio**: it is covered by jsdom
> tests with the Voice SDK mocked, and by a Playwright spec that only checks the
> gate. The first client to switch the gate on triggers a live walk
> (UPSTREAM_PORT_PLAN.md, Hein's ruling 4).

Ported from upstream LeadStack 1.0.31 (read at 1.0.40, `68798611`). Team members
place outbound calls to contacts from the browser through the sub-account's own
Twilio account (Twilio Voice JS SDK). The dialer is outbound-only: the token grants
no incoming calls, and the number's inbound voice handler (Vapi BYOC / MCTB) is never
touched.

## How a call flows

1. **Provision** (`POST /api/sub-accounts/[id]/dialer`, sub-account admin). This needs
   dedicated Twilio (`twilioConfig.enabled`, accountSid, auth token, fromNumber). It
   creates a TwiML App (voice URL is our TwiML webhook) and an API key **on the
   client's own Twilio account**. The secrets go to `subAccounts/{id}/private/dialer`
   and the non-secret `dialerConfig {enabled: true, recordCalls}` goes on the
   sub-account doc. It is idempotent: when the private doc exists, a repeat call only
   refreshes the TwiML App's voice URL (this heals a changed `NEXT_PUBLIC_APP_URL`)
   and mints nothing new.
2. **Token** (`POST /api/comms/dialer/token`, body `{subAccountId}`). Any active
   member of the sub-account, or the parent agency's owner, gets a 1-hour Twilio
   AccessToken. Its identity is their uid and its only grant is outgoing calls through
   the TwiML App. The browser never sees the API key secret.
3. **TwiML webhook** (`POST /api/webhooks/twilio/dialer/twiml/[saId]`). Twilio calls
   this when the browser dials with `params: { contactId }`. In order:
   - It verifies the Twilio signature with the sub-account's token, read from
     `private/twilioCredentials`.
   - It checks the agency gate, then `dialerConfig.enabled`, then that dedicated
     Twilio is still switched on (`subAccountTwilioIsConfigured`). Switching
     dedicated Twilio off, with the credentials kept, stops new calls and new tokens.
   - It checks that the caller (`From: client:<uid>`) can still act on the contact.
     This is `requireContactAccessible`: active member or agency owner, plus territory
     scope.
   - It checks that the contact is in this sub-account (the `contactId` must be a plain
     document id; `requireContactAccessible` refuses anything containing `/`).
   - It applies the two number checks the AI outbound path uses
     (`validDialNumber` / `countryBlocked` in `outbound-compliance.ts`), parsed the
     same way: the phone must be a valid number to libphonenumber **with no default
     region**, and in the Voice channel's `allowedCountries` when that list is set.
     In practice the contact's phone must be stored in international form (`+…`).
     A locally formatted number (`082 123 4567`) is refused with a spoken message
     telling the operator to save it in international format. It is never
     interpreted through the workspace phone region: that setting can change or be
     unset (it then reads as US), and a wrong guess dials a stranger.
   - Dialer-only: a number libphonenumber gives no country for (non-geographic:
     satellite, +800, +882 and the like) is never dialled, allow-list or not. The AI
     voice path does not have this rule.
   - It refuses when the dialled contact is `voiceOptedOut`. **Voice opt-out is per
     contact**, as upstream has it: a duplicate contact holding the same number is
     not blocked. **Nothing in the app sets `voiceOptedOut` today** — there is no UI
     and no server path that writes it; it is only read (here, by the AI voice gate
     and by voice campaigns). A number-wide voice do-not-call list belongs with
     whatever feature first records a voice opt-out, using a normalised number
     written at opt-out time.

   Every one of these checks, and the `<Dial>`, reads the one canonical number: the
   contact's phone parsed once. The stored string is never dialled or checked on
   its own.

   If every check passes, it writes a `call_placed` activity (`dialer_<CallSid>`; skipped
   when the `CallSid` is not a plain document id) and
   answers `<Dial callerId=fromNumber answerOnBridge><Number>E.164</Number>`.
   **The number dialled always comes from the contact doc, normalised to E.164.** Any
   `To` or phone number in the request is ignored.

   The AI-only checks (per-call consent ack, calling window, minutes quota, daily /
   per-number / burst caps, scrub provider) are not applied: an operator is placing
   and hearing the call. **With no `allowedCountries` set, any valid number with a
   country is dialled, including a country's own premium-rate ranges (e.g. US 1-900)**,
   on the client's own Twilio account (Twilio's own Voice geo-permissions still apply).
4. **Status callback** (`POST /api/webhooks/twilio/dialer/status/[saId]?contactId=`).
   This is the `<Dial action>`. It is signature-checked the same way, and the
   signature covers the query string. It updates the activity row with the outcome
   and the duration. It is not behind the agency gate or the dedicated-Twilio
   switch, so a call already in progress still gets its outcome recorded. The body
   is signed with the tenant's own token, so its values are still checked:
   - `contactId` and `CallSid` must be plain document ids. Otherwise nothing is
     written and Twilio still gets its 200.
   - A status Twilio does not document is stored as `ended`.
   - The duration is clamped to a whole number of seconds between 0 and 24 hours.
   - `RecordingUrl` is stored as `meta.recordingUrl` only when this sub-account has
     `recordCalls` on **and** the URL is exactly a recording on its own Twilio
     account: `https://api.twilio.com/2010-04-01/Accounts/<its accountSid>/Recordings/RE<32 hex>`,
     optionally ending `.mp3` or `.wav`, with nothing before or after. Another
     account's recording, any other host, a query string, padding or control
     characters are all dropped, and nothing is stored when `twilioConfig.accountSid`
     is missing or not `AC` + 32 hex characters.
   - **Known gap for the live walk:** only `api.twilio.com` is accepted. If the
     client's Twilio account serves recordings from a regional host
     (`api.ie1.twilio.com`, `api.au1.twilio.com` and so on), the URL is dropped and
     the call's row has no recording link. Check what Twilio actually sends on the
     first recorded call.

   The timeline checks the URL again before linking it; see
   [The UI](#the-ui-sp-3).

## The UI (SP-3)

Ported from upstream `68798611`, with the changes listed here. Upstream's UI has no
agency gate and reads only `dialerConfig.enabled`.

- **Call button** (contact profile header, `contact-profile-header.tsx`). Rendered
  only when `dialerEnabledByAgency === true` **and** `dialerConfig.enabled === true`.
  With either off there is no button. It is disabled, with the reason as its
  tooltip (`title`, like the Email and SMS buttons beside it), when the contact:
  - has no phone;
  - is `voiceOptedOut`;
  - has a phone not stored in "+…" form ("Save the number in international format,
    e.g. +27…"). This is a leading-`+` hint only. The TwiML webhook still parses the
    number and is the authority; a `+…` number that is not valid is refused there,
    with the spoken message.

  The button does not look at the dedicated-Twilio switch. If dedicated Twilio is off,
  the token route's 403 shows in the call bar.
- **Call bar** (`browser-call-bar.tsx`), mounted by the click. In order: it asks the
  token route for a token, then loads `@twilio/voice-sdk` with a dynamic `import()`
  (the SDK is not in the page's main bundle), then calls
  `device.connect({ params: { contactId } })`, which is what asks the browser for the
  microphone. Nothing is requested before the click.
  - Every answer from the token route that is not a 2xx with a token ends in an error
    shown in the bar, with a Close button and no Device: 403 (locked by the agency,
    not a member, dialer or dedicated Twilio off), 404, 5xx with or without a JSON
    body, a login redirect, a dropped connection.
  - The Device is destroyed, and the call disconnected, on every way out: a Device or
    call error, the call ending, Hang up, and unmount. The first outcome wins, so the
    `disconnect` the SDK emits when the Device is destroyed does not replace a shown
    error. Hang up during a call ends it at once and does not wait for an SDK event.
  - The token is held in memory only. Nothing logs it or stores it.
  - The bar is tied to the contact it was started for. If the header shows another
    contact while a call is open, the bar unmounts and the call ends; the new contact
    is never dialled without a click. A call already open continues if the gate is
    switched off (the server lets it finish too).
- **Settings card** (Settings → Messaging → Phone dialer,
  `sub-account-dialer-section.tsx`), sub-account admins only.
  - Gate off: "Locked by your agency", no Enable and no recording toggle.
  - Gate on, dedicated Twilio not on and complete: the same "enable a dedicated
    Twilio number above first" guidance Missed Call Text Back shows. "Complete" is
    `dialerTwilioConfigured`, which a test holds equal to the server's
    `subAccountTwilioIsConfigured`. Upstream checked only `twilioConfig.enabled`.
  - Otherwise Enable (`POST`), then the Record calls toggle (`PATCH {recordCalls}`).
  - **Disable (`DELETE`) is offered whenever a dialer is provisioned**, including
    while locked or while dedicated Twilio is off. `DELETE` is ungated on the server
    for exactly that. With dedicated Twilio off, the confirm says the key and app
    cannot be removed from the Twilio account automatically.
  - The recording note says a recording link can be opened by anyone holding it
    unless the client enforces HTTP auth on media URLs. Upstream's copy said opening
    it needs a Twilio login, which is not Twilio's default.
- **Timeline** (`activity-timeline.tsx`, `activity-visuals.tsx`). A `call_placed` row
  reads "Phone call". Upstream stores `meta.recordingUrl` but never renders it; ours
  renders an "Open recording" link, and only when the row is `call_placed` and the
  value is exactly `https://api.twilio.com/2010-04-01/Accounts/<this sub-account's
  AC sid>/Recordings/RE<32 hex>`, optionally ending `.mp3` or `.wav`. `meta` is
  untrusted: members can write activity rows directly. The link opens in a new tab
  with `rel="noopener noreferrer"`. A recording is never embedded or auto-played.
  - The timeline and the status webhook apply the same function,
    `ownRecordingUrl` in `src/lib/comms/dialer-shared.ts`, pinned to the
    sub-account's current `twilioConfig.accountSid`. A recording stored before a
    sub-account changed Twilio accounts therefore shows no link (fail closed).

## Safety

- **Recording is off by default.** `recordCalls` must be `true` (set through
  `PATCH …/dialer {recordCalls}`) before `<Dial record="record-from-answer-dual">` is
  emitted. Consent laws vary by region. If recording is enabled, the stored
  `RecordingUrl` may be publicly fetchable by anyone holding it unless the client
  turns on "Enforce HTTP Auth on Media URLs" in Twilio.
- **Signatures.** Both webhooks validate `X-Twilio-Signature` against the token in
  `private/twilioCredentials`, falling back to a legacy `twilioConfig.authToken` only
  when the private doc is absent (`readSubAccountSecret`). An unknown sub-account
  gets 404 and a bad signature gets 403.
- **Public paths.** Both webhooks sit under the existing public `/api/webhooks/twilio`
  middleware prefix, so the middleware is unchanged.
- **No new env vars, no rules change.** The `private/*` docs are already deny-all.

## Agency gate

`dialerEnabledByAgency`, opt-in, **ours only** (upstream has no dialer gate). While it
is off:

- Provisioning (`POST`), the recording toggle (`PATCH`), the token route and the
  TwiML webhook (after the signature check) return 403 `{ code: "gate_off" }`.
- `DELETE …/dialer` stays ungated, so a sub-account can always tear down what it
  provisioned.
- The status callback stays ungated, so a call already in progress still gets its
  outcome recorded.
- Switching the gate off does not tear anything down.

See [feature-gates.md](../architecture/feature-gates.md).

## Disable and remote clean-up

`DELETE /api/sub-accounts/[id]/dialer` (sub-account admin) matches upstream:

- It tries to remove the TwiML App and the API key from the client's Twilio account.
- It deletes `private/dialer` and sets `dialerConfig: null`.

The remote clean-up is **best-effort**:

- If Twilio refuses a remove, the error's message is logged and the disable still
  succeeds, so the key or app may be left on the client's account. Only the message
  is ever logged: the error object a failed Twilio call rejects with carries the
  account's credential in its request headers.
- If dedicated Twilio creds are no longer configured when the dialer is disabled, the
  remote resources cannot be reached and are left in place (logged).
- A failed first provision (app created, then key creation fails) also leaves that
  app behind, as upstream does.

## Files

- `src/lib/comms/dialer.ts`: gate, creds (`readSubAccountSecret`), signature check,
  token minting, URLs
- `src/app/api/sub-accounts/[id]/dialer/route.ts`: provision, toggle recording,
  disable
- `src/app/api/comms/dialer/token/route.ts`
- `src/app/api/webhooks/twilio/dialer/{twiml,status}/[subAccountId]/route.ts`
- `src/lib/comms/dialer-shared.ts`: the rules the server and the browser both apply
  (the recording URL rule, dedicated-Twilio readiness, the "+…" hint). Client-safe.
- `src/components/contacts/browser-call-bar.tsx`, and the Call button in
  `contact-profile-header.tsx`
- `src/components/settings/sub-account-dialer-section.tsx`
- `src/components/contacts/activity-timeline.tsx` / `activity-visuals.tsx`: the
  `call_placed` row and its recording link
- Types: `DialerConfig`, `DialerPrivateDoc` (`src/types/tenancy.ts`), the
  `call_placed` activity (`src/types/contacts.ts`), and `meta.recordingUrl`
  (`src/types/activities.ts`)
- Dependency: `@twilio/voice-sdk` pinned to `2.18.4`, the version upstream's lockfile
  resolves
- Tests: a `route.test.ts` beside each route, plus `e2e/specs/dialer-webhooks.spec.ts`.
  UI: `browser-call-bar.test.ts`, `browser-call-bar.unmount.test.ts`,
  `contact-profile-header.dialer.test.ts`, `activity-timeline.recording.test.ts`,
  `sub-account-dialer-section.test.ts`, `dialer-shared.test.ts` (the Voice SDK is
  mocked by `src/test/fake-voice-sdk.ts`), plus `e2e/specs/dialer-ui.spec.ts`
