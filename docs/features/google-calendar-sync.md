# Google Calendar sync

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md). Ledger: SP3 rows G1–G4.*

Each member of a sub-account can connect **their own** Google Calendar. After that:

- bookings assigned to them are written to their **primary** Google calendar, and follow reschedules and cancels;
- their Google busy time blocks those slots on every booking page they host.

Code: [src/lib/google-calendar/](../../src/lib/google-calendar/). Agency gate: `googleCalendarEnabledByAgency` ([feature-gates.md](../architecture/feature-gates.md)).

## Connection (G1, G4)

- **Per member.** Stored at `subAccounts/{saId}/private/googleCalendar_{uid}`. The doc holds `uid`, `agencyId`, `subAccountId`, `googleEmail`, `refreshToken`, `accessToken`, `accessTokenExpiresAt`, `scopes`, `status` (`connected` | `revoked`), `connectedAt`, `lastError` and `lastErrorAt`. The `private/*` rules deny all client access, so only the Admin SDK can read it.
- **Scopes:** `openid email https://www.googleapis.com/auth/calendar.events`. There is no `calendarlist` scope, so only the primary calendar is used (ruling 7).
- **Routes:**
  - `GET /api/sub-accounts/[id]/google-calendar/connect` — any active member, gate on. Redirects to Google with `access_type=offline` and `prompt=consent`.
  - `GET /api/sub-accounts/[id]/google-calendar` — returns the **caller's own** status (no tokens). Answers 403 `gate_off` while the gate is off.
  - `DELETE /api/sub-accounts/[id]/google-calendar` — **ungated**. Deletes the stored tokens only; it **never revokes at Google**. This is the same OAuth client as the Business Profile connection, and Google's revoke ends the app's whole grant for that Google account, so it could take the sub-account's GBP connection down with it. The card tells the member they can remove the app's access themselves at myaccount.google.com/permissions. Events already written to Google stay there.
- **Callback:** it shares the one registered `/api/google/callback` with Business Profile. The signed OAuth state carries `p: "calendar"`. GBP states never carry `p`, so they keep their exact shape and behaviour. The callback hands calendar states to `lib/google-calendar/callback.ts`. That handler requires the finishing member to be the uid that started the flow. It redirects to Settings with `?gcal=<status>`.
- **Tokens:** the cached access token is used while more than 60 s remain; otherwise it is refreshed, and a rotated refresh token is stored. A 401 from Google earns exactly one forced refresh. `invalid_grant` sets `status: "revoked"` and `lastError`, and the card then shows **Reconnect**.
- **UI:** the Google Calendar card in Settings → Calendar sync ([google-calendar-card.tsx](../../src/components/settings/google-calendar-card.tsx)). It shows one of four states: Connect, "Connected as … (primary calendar)", Reconnect with the last error, or Disconnect. It is hidden while the gate is off.

## Busy time (G2)

`loadGoogleBusy({subAccountId, hostUids, from, to})` returns `{startAt, endAt, hostUids}[]`:

- It runs **outside** any Firestore transaction.
- Each host gets a 3 s budget.
- It uses `events.list` on the primary calendar with `singleEvents=true`.
- It skips transparent, cancelled and declined events, and events LeadStack pushed itself (`extendedProperties.private.leadstackEventId`).
- All-day events block midnight to midnight in the calendar's timezone.

**It fails open (ruling 8).** When Google errors, times out or the grant is revoked, that host gets no Google busy time and the failure is written to their connection, where their card shows it. A later successful read clears the warning. Hostless pages get no Google busy time (ruling 2). Nothing is read while the gate is off.

It reaches every slot decision through `resolvePageAvailability`'s `externalBusy` input. `loadGoogleBusyForPage` loads it for the page's hosts over the resolver's own window (padded by the page's buffers), always before any transaction. The callers are:

- the public availability route;
- the book route;
- the token reschedule route (`loadGoogleBusyForEvent` pre-reads the event and its page, because the route reads the page inside its transaction);
- the voice-booking service, for both listing and confirming.

## Push (G3)

`pushBookingToGoogle(eventId)` reads the event **after** the caller's commit and makes Google match its stored status:

- **Scheduled or awaiting payment:** inserts the Google event, or patches it if one already exists, for each host. The hosts are `hostUids` on collective events, otherwise `assignedToUid`. A patch that answers 404 re-inserts.
- **Cancelled:** deletes the Google copy. This also runs with the gate off, so a switched-off gate never leaves a cancelled booking in someone's calendar.
- **Completed or no-show:** left alone.
- **Host removed from the event:** that host's copy is deleted.

The Google event ids are stored in `googleEventIds: {[uid]: googleEventId}` on the event. A push never throws. Failures are written to `googleSyncError` on the event and to the host's connection. The client write rules lock `googleEventIds` and `googleSyncError`.

It is called once per post-commit path:

- book route and voice booking (new bookings);
- `runRescheduleSideEffects` (token and operator reschedule);
- `changeEventStatus` on a cancel (mark-status and the v1 API);
- the manage-link cancel route and payment-hold expiry;
- `markBookingPaidServerSide`;
- the assign route. A reassign moves the Google copy: it is deleted from the old host's calendar and inserted on the new host's.

Deleting an event in Google does **not** cancel the booking (ruling 9).

## Fake provider (dev/CI)

`GCAL_PROVIDER=fake` is fenced exactly like the GBP, WhatsApp and SMS fakes ([mode.ts](../../src/lib/google-calendar/provider/mode.ts)). It needs all of:

- a loopback `NEXT_PUBLIC_APP_URL`;
- `GCAL_FAKE_ALLOW_PROD_BUILD=1` in a production build;
- `GCAL_FAKE_AGENCY_ID` set to the fixture agency.

**How it behaves:**

- Each member's "Google calendar" is the Firestore doc `private/googleCalendarFake_{uid}`, shaped `{email?, revoked?, events[], failNext?}`.
- Connect skips Google and lands on the real callback.
- `revoked: true` makes refresh answer `invalid_grant` and access tokens stop working.

The deploy guard (`scripts/gbp-deploy-check.mjs`) refuses any `GCAL_PROVIDER` / `GCAL_FAKE_*` name, and checks the URL inlined into the built fake check. Spec: [e2e/specs/google-calendar-sync.spec.ts](../../e2e/specs/google-calendar-sync.spec.ts).

## Known limits

- Primary calendar only; no Outlook (G5, out of scope).
- **Known gap:** events created, edited or deleted by hand on the Calendar page write through the client SDK and are not pushed. Only booking-flow events (including reassign) reach Google.
- Disconnect does not revoke at Google (see Connection).
