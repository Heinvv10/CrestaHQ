# Browser phone dialer (Softphone v1)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [README.md](README.md).*

> **Status: server side only (SP-2). NOT runtime-verified.** It merges dark behind
> `dialerEnabledByAgency` (default off). No call has gone through a real Twilio
> account. The UI (Call button, call bar, settings card) comes in SP-3. The first
> client to switch the gate on triggers a live walk (UPSTREAM_PORT_PLAN.md, Hein's
> ruling 4).

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
   - It checks the agency gate, then `dialerConfig.enabled`.
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
   - It refuses when this contact is `voiceOptedOut`, or when any opted-out contact
     in the sub-account names the same number. Contacts have no normalised phone
     field, so this is not a lookup by format. The route reads the sub-account's
     opted-out contacts (`subAccountId` + `voiceOptedOut == true`, paged) and
     compares digits only (`optOutCoversNumber` in `src/lib/comms/dialer.ts`): an
     opted-out contact blocks the call when the digits of its stored phone equal the
     target's E.164 digits, or contain the target's national significant number
     (only when that is 7 or more digits). That covers a trunk `0`, a `00` prefix,
     any punctuation and a trailing extension. It over-blocks on purpose: a
     different country's number with the same national digits also blocks.
     **Not matched:** an opted-out contact whose stored phone does not contain the
     national number at all (a typo, or a different number for the same person), and,
     for a number whose national part is under 7 digits, any spelling whose digits
     are not exactly the E.164 digits.
   - **Fail closed:** the scan reads at most 2,000 opted-out contacts. If the
     sub-account has more and none of those read matched, the call is refused with a
     spoken message and `[dialer/twiml] opt_out_scan_over_cap` is logged.

   Every one of these checks, and the `<Dial>`, reads the one canonical number: the
   contact's phone parsed once. The stored string is never dialled or checked on
   its own.

   If every check passes, it writes a `call_placed` activity (`dialer_<CallSid>`) and
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
   signature covers the query string. It updates the activity row with the outcome,
   the duration and, only when recording is on, the `RecordingUrl`.

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

- If Twilio refuses a remove, the error is logged and the disable still succeeds, so
  the key or app may be left on the client's account.
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
- Types: `DialerConfig`, `DialerPrivateDoc` (`src/types/tenancy.ts`), and the
  `call_placed` activity (`src/types/contacts.ts`)
- Tests: a `route.test.ts` beside each route, plus `e2e/specs/dialer-webhooks.spec.ts`
