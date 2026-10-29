# Google Calendar sync

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md). Ledger: SP3 rows G1–G4.*

Each member of a sub-account can connect **their own** Google Calendar. After that:

- bookings assigned to them are written to their **primary** Google calendar, and follow reschedules and cancels;
- their Google busy time blocks those slots on every booking page they host.

Code: [src/lib/google-calendar/](../../src/lib/google-calendar/). Agency gate: `googleCalendarEnabledByAgency` ([feature-gates.md](../architecture/feature-gates.md)).

> **Before any agency turns the gate on:** deploy this branch's `firestore.rules` **and** indexes (`firebase deploy --only firestore:rules,firestore:indexes`). The rules are what stop a client from pointing a push at someone else's calendar (the locked host fields) or orphaning a Google copy (the delete refusal); the member-removal cleanup queries events by host and start time.

## Connection (G1, G4)

- **Per member.** Stored at `subAccounts/{saId}/private/googleCalendar_{uid}`. The doc holds `uid`, `agencyId`, `subAccountId`, `googleEmail`, `refreshToken`, `accessToken`, `accessTokenExpiresAt`, `scopes`, `status` (`connected` | `revoked`), `connectedAt`, `lastError` and `lastErrorAt`. The `private/*` rules deny all client access, so only the Admin SDK can read it.
- **Scopes:** `openid email https://www.googleapis.com/auth/calendar.events`. There is no `calendarlist` scope, so only the primary calendar is used (ruling 7).
- **Routes:**
  - `GET /api/sub-accounts/[id]/google-calendar/connect` — any active member, gate on. Redirects to Google with `access_type=offline` and `prompt=consent`.
  - `GET /api/sub-accounts/[id]/google-calendar` — returns the **caller's own** status (no tokens). Answers 403 `gate_off` while the gate is off.
  - `DELETE /api/sub-accounts/[id]/google-calendar` — **ungated**. Deletes the stored tokens only; it **never revokes at Google**. This is the same OAuth client as the Business Profile connection, and Google's revoke ends the app's whole grant for that Google account, so it could take the sub-account's GBP connection down with it. The card tells the member they can remove the app's access themselves at myaccount.google.com/permissions. Events already written to Google stay there.
- **Callback:** it shares the one registered `/api/google/callback` with Business Profile. The signed OAuth state carries `p: "calendar"`. GBP states never carry `p`, so they keep their exact shape and behaviour. The callback hands calendar states to `lib/google-calendar/callback.ts`. That handler requires the finishing member to be the uid that started the flow. It redirects to Settings with `?gcal=<status>`.
- **Tokens:** the cached access token is used while more than 60 s remain; otherwise it is refreshed (within the caller's time budget, which aborts the refresh too), and a rotated refresh token is stored. A 401 from Google earns exactly one forced refresh. `invalid_grant` sets `status: "revoked"` and `lastError` — only if the stored refresh token is still the one that failed, so a member who reconnected meanwhile is not marked dead. The card then shows **Reconnect**.
- **Two error fields:** `lastError` is a busy-time/token failure, cleared by the next successful read. `lastPushError` is a booking write that failed, cleared by the next successful write for that member. A busy read that works never clears a push error.
- **UI:** the Google Calendar card in Settings → Calendar sync ([google-calendar-card.tsx](../../src/components/settings/google-calendar-card.tsx)). It shows one of: Connect, "Connected as … (primary calendar)" with any busy or push error, Reconnect with the last error, or Disconnect. While the gate is off it shows only a Disconnect, and only when the member still has a stored connection (`GET` answers `{gateOff, connected, googleEmail}`).
- **Member removal** deletes the member's connection doc and their imported events. Busy and push also refuse any connection whose owner is not an active member (or the agency owner).

## Busy time (G2)

`loadGoogleBusy({subAccountId, hostUids, from, to})` returns `{startAt, endAt, hostUids}[]`:

- It runs **outside** any Firestore transaction.
- Each host gets a 3 s budget.
- It uses `events.list` on the primary calendar with `singleEvents=true`.
- It skips transparent, cancelled and declined events, and events LeadStack pushed itself (`extendedProperties.private.leadstackEventId`).
- All-day events block midnight to midnight in the calendar's timezone.

**It fails open (ruling 8).** When Google errors, times out or the grant is revoked, that host gets no Google busy time and the failure is written to their connection, where their card shows it. A later successful read clears the warning. Hostless pages get no Google busy time (ruling 2). Nothing is read while the gate is off.

It reaches every slot decision through `resolvePageAvailability`'s `externalBusy` input. `loadGoogleBusyForPage` loads it for the page's hosts — plus, on a reschedule, the moving booking's own hosts — over the resolver's own window (padded by the page's buffers), always before any transaction. The window is clamped to `[now − pad, now + visibleDays + pad]`, so a public caller's `from`/`to` can never make it read a host's calendar outside the page's horizon. The callers are:

- the public availability route;
- the book route;
- the token reschedule route (`loadGoogleBusyForEvent` pre-reads the event and its page, because the route reads the page inside its transaction);
- the voice-booking service, for both listing and confirming.

## Push (G3)

`pushBookingToGoogle(eventId)` reads the event **after** the caller's commit and makes Google match its stored status:

- **Scheduled or awaiting payment:** writes the event for each eligible host under a deterministic Google id per (event, host) — `ls` + 40 hex of sha256, all base32hex. The write is an insert that turns into an overwrite when the id exists (409), so two racing pushes cannot duplicate. Re-writing an event the member deleted in Google restores it (ruling 9).
- **Cancelled:** deletes the Google copy. This also runs with the gate off, so a switched-off gate never leaves a cancelled booking in someone's calendar.
- **Completed or no-show:** left alone.
- **Host no longer on the event** (reassign, collective change): that host's copy is deleted.
- After the Google calls it re-reads the event; if its status, time or hosts changed meanwhile, it converges once more.

**Who it may write to.** One rule, shared with busy loading (`activeGoogleHosts`): of the event's own hosts — `assignedToUid` ∪ `hostUids` — the **active members** (or the agency owner). A host taken off the page but still assigned keeps (and moves) their copy; a host who left the sub-account is skipped and the skip is written to `googleSyncError`. The fields that decide the target — `assignedToUid`, `assignedToName`, `source`, `bookingPageSlug`, `hostUids`, `googleEventIds`, `googleSyncError`, `googleSyncRetryAt` — are locked from client writes in `firestore.rules`, and a client cannot delete an event whose `googleEventIds` is non-empty. The calendar dialog deletes such an event through `DELETE /api/events/by-id/[id]` (active member of the event's sub-account, within their territory scope), which takes the Google copies down first; so does the v1 API's delete. Both then re-read the event and **refuse** (409 `google_removal_failed`, reason on `googleSyncError`) while any copy is left, rather than delete and orphan it; the dialog says "Couldn't remove it from <host>'s Google Calendar — try again". When a push has nothing to do (completed / no-show, cancelled with no Google copy, gate off) it clears any stale `googleSyncError`. Removing a member takes their Google copies of upcoming bookings down before their tokens are deleted (five at a time, 20 s in all; a copy it could not remove is recorded on that booking).

**Time budget.** Hosts run in parallel, each with a 5 s budget that aborts the underlying Google calls. The public book route and the voice agent run the push after the response via Next's `after()`, so neither waits on Google; outside a request scope (tests) it runs detached.

**Failures** never throw. They are written to `googleSyncError` on the event, naming the host ("Not in Ann's Google Calendar: …"), and to that member's `lastPushError`. Nothing retries automatically: the calendar event dialog shows the reason with a **Retry sync** button, which calls `POST /api/events/by-id/[id]/google-sync` (any active member of the event's sub-account; same eligibility rule; one retry per event per 30 s, 429 otherwise). The member's card words a push failure apart from a busy-read failure ("Last booking change not synced: …", with removals worded separately).

It is called once per post-commit path:

- book route and voice booking (new bookings, after the response);
- `runRescheduleSideEffects` (token and operator reschedule);
- `changeEventStatus` on a cancel (mark-status and the v1 API);
- the manage-link cancel route and payment-hold expiry;
- `markBookingPaidServerSide`;
- the assign route — a reassign moves the Google copy from the old host's calendar to the new host's.

Deleting an event in Google does **not** cancel the booking (ruling 9).

## Import (C1, port of 1.0.54) — NOT runtime-verified

> Merged dark: no Settings UI yet (C2), and not walked against a real Google account. Nothing is imported until an admin allows it through the API below.

A member's own Google events shown on the CRM calendar as read-only `events` docs. Code: [import.ts](../../src/lib/google-calendar/import.ts) (the pass), [import-map.ts](../../src/lib/google-calendar/import-map.ts) (what is stored), [import-state.ts](../../src/lib/google-calendar/import-state.ts) (keys and cleanups).

- **Three keys, all required:** the agency gate `googleCalendarEnabledByAgency`; the workspace allowance `calendarImportAllowed` on the sub-account (a sub-account admin); and the member's own `importMode` on their connection (`busy` or `details`; absent = off). Plus the member still being active. Any key off: no Google call, and that member's imports are deleted.
- **Detail level (Decision 4):** `busy` (the default the UI should offer first) stores times only — title "Busy", no place, and Google is not even asked for titles. `details` stores the title and place too, which every member of the workspace can then read; a Google-private/confidential event stays "Busy". Descriptions, guests, conference links and attachments are never fetched in either mode.
- **What is imported:** the same rule as busy time — cancelled, Free (transparent), declined events and LeadStack's own pushed copies are skipped, as are `workingLocation` and `birthday` entries. **All-day events** are imported only when marked Busy (Google makes all-day events Free by default), midnight to midnight in the calendar's zone; a multi-day one carries `isLong`.
- **Doc shape:** see `events/{id}` in [firestore-collections.md](../architecture/firestore-collections.md). Deterministic ids, so a re-run never duplicates; an unchanged event is not rewritten. Never `assignedToUid`, `hostUids`, `mode`, `publicTokenHash` or `bookingPageSlug`. Every event reader skips it (C0) except availability, where it is busy for its owner only — from the Firestore copy, so it holds while their live Google busy fails open.
- **Sync:** `events.list` on the primary calendar under the existing `calendar.events` scope (no new scope). A full walk covers 30 days back to 180 days ahead and deletes what Google no longer returns; later passes are incremental from Google's sync token. A refused token (410) falls back to a full walk; a full walk also runs daily and on every mode change. At most 20 pages (5,000 events) per walk and 2,000 imported events per member (upcoming first); a walk cut short deletes nothing and says so in `importError`.
- **Races:** every switch-off writes its key first and deletes after; each write batch commits in a transaction that re-reads the sub-account and connection and refuses if their fingerprint moved — then the pass re-applies the current keys itself. So a member who opts out (or an admin, or the agency) mid-sync never keeps an import.
- **Cleanups:** opt-out, workspace switch off (also resets every member to off, so allowing it again exposes nobody), agency gate off (`applyFeatureGates`, every path), disconnect, reconnect (the doc is replaced, so the opt-in resets), member removal and sub-account delete (imported events don't block the delete guard; they go with it). The daily housekeeping job `calendar-import-orphans` deletes anything a failed cleanup left.
- **Schedule:** no QStash schedule of its own. The 15-minute `email-sync` tick publishes one message to `POST /api/cron/calendar-import` (QStash-signed, URL-bound) when any workspace allows import; it syncs members least recently attempted first, three at a time, within 45 s.
- **API:** `PATCH /api/sub-accounts/[id]/google-calendar/import` with exactly one of `{allowWorkspace: boolean}` (admin; on needs the gate and a configured deployment), `{mode: "off"|"busy"|"details"}` (the caller's own calendar only; on needs the gate, the allowance and a connected calendar; off always works) or `{syncNow: true}` (the caller's full pass, awaited). `GET /api/sub-accounts/[id]/google-calendar` adds `importAllowed`, `importMode`, `importStatus`, `importError`, `importLastSyncAt`, `importedCount`.
- **Rules:** no client may update or delete a `source: "google"` event (nor create one — `source` was already server-only). Every member may read them; a per-doc read condition would break the calendar's list queries ("rules are not filters"), which is why sharing details is the owner's explicit choice.
- **Not built (C1 scope):** no contact linking from guest emails (upstream links one in details mode); no UI (C2).

## Fake provider (dev/CI)

`GCAL_PROVIDER=fake` is fenced exactly like the GBP, WhatsApp and SMS fakes ([mode.ts](../../src/lib/google-calendar/provider/mode.ts)). It needs all of:

- a loopback `NEXT_PUBLIC_APP_URL`;
- `GCAL_FAKE_ALLOW_PROD_BUILD=1` in a production build;
- `GCAL_FAKE_AGENCY_ID` set to the fixture agency.

**How it behaves:**

- Each member's "Google calendar" is the Firestore doc `private/googleCalendarFake_{uid}`, shaped `{email?, revoked?, events[], failNext?}`.
- Connect skips Google and lands on the real callback.
- `revoked: true` makes refresh answer `invalid_grant` and access tokens stop working.
- Import walks: an incremental walk returns every event as changed plus `deletedIds` as cancelled; `expireSyncToken: true` answers the next incremental walk with a 410 once.

The deploy guard (`scripts/gbp-deploy-check.mjs`) refuses any `GCAL_PROVIDER` / `GCAL_FAKE_*` name, and checks the URL inlined into the built fake check. Spec: [e2e/specs/google-calendar-sync.spec.ts](../../e2e/specs/google-calendar-sync.spec.ts).

## Known limits

- Primary calendar only; no Outlook (G5, out of scope).
- **Manual Calendar-page events** (created, edited or deleted through the client SDK) are never pushed.
- **Client edits of a booking-page event's title, notes, location or time** from the Calendar page are not pushed either; the next server-side push for that booking (reschedule, cancel, reassign, Retry sync) brings Google up to date.
- **Re-enabling the gate does not reconcile** bookings made, moved or cancelled while it was off; only later changes (or Retry sync on a booking) are pushed.
- Disconnect does not revoke at Google (see Connection). The reverse is known and left as is: the **Business Profile** disconnect does revoke, which can end a Calendar connection made with the same Google account on this OAuth client — the member then sees Reconnect.
