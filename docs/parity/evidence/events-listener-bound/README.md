# Events listener bound

The appointments list used to subscribe to a sub-account's whole events
history (`subscribeToEvents`). It now uses `subscribeToAppointments`: two
bounded listeners split at subscribe time.

- Upcoming: `startAt >= now`, ascending, limit 500.
- Past: `startAt < now`, descending, 200 per page. "Fetch older appointments" adds a page.
- Tab counts get a "+" and a notice says when older or later events are not
  loaded, so nothing disappears silently.
- `subscribeToEvents` is untouched; the calendar and command palette keep it.
- Three `events` composite indexes back the queries (already deployed
  2026-09-29): `subAccountId+startAt DESC`, and the territory-filtered
  `subAccountId+territoryId+startAt` in both directions.
- E2E: `reapStaleE2eEvents` deletes fixture events titled "E2E ..." older
  than 6h, refusing any non-fixture sub-account.

## Measured 2026-09-29 (previous session; not re-run since)

On the E2E fixture at 1,898 events:

- Write-to-listener delivery was about 50 ms both bounded and unbounded.
- First load improved from about 2 s to about 0.4 s.

So the bound is a first-load improvement. It is NOT the cause of the
`appointments-list.spec.ts:210` flake, which is delivery latency and was
unchanged by the bound.

Mutation evidence: [mutations.md](mutations.md).

## Rendered (2026-10-01, read-only browser walk)

Standalone build of this branch on 127.0.0.1:3141, logged in as the E2E
fixture user, appointments page of the primary fixture sub-account. Clicked
tabs and "Fetch older appointments" only.

The reaper has since cleared the fixture to ~23 events, far under the real
200-event page, so no notice would appear. For these shots ONLY the build was
made with `APPOINTMENTS_PAST_PAGE = 10` (reverted; not in the commit):

- `1-upcoming.png`: Upcoming (1), Cancelled (8+), All (16+).
- `2-all.png`: All tab, "+" on the counts, notice "Older appointments have
  not been fetched ... 'Load more' above only reveals rows already fetched."
  and the "Fetch older appointments" button.
- `3-all-after-load-older.png`: after one fetch, everything is loaded:
  Cancelled (8), All (23), no "+", notice gone.

Not shown: the "Load more (N more)" button coexisting with the notice, since
with a 10-row past page all rows fit on one 25-row page. That combination was
seen in the earlier shots at the real 200 limit (fixture then had ~1,900
events); those were replaced by these.

## Known gaps

The confirmed-change override (`useEventOverrides`, rules in
`src/lib/calendar/event-overrides.ts`) now covers every server write the
appointments list, the calendar grid and the per-booking-page bookings list
make:

- the row menu's mark-status (list);
- from the Edit / Reschedule dialog, on all three pages: mark-status,
  mark-paid, the operator reschedule (times plus the stored `rescheduleCount`,
  so the "Rescheduled" badge shows), the host reassign, Retry sync (the error
  notice clears when the 200 says `synced`), and the server-side DELETE for
  Google-mirrored events;
- the grid's "New Event": the created event is shown from the create route's
  201, which now carries the stored fields (`stored`). The list cannot create
  events, so this applies to the grid only.

The dialog is given the page's current copy of its event (overrides applied),
so its host picker, status panel and sync notice use confirmed values, and
re-picking the original host sends a request. The form initialises only when
the dialog opens or another event is opened, so an update arriving while it
is open never wipes unsaved edits. Start and end are judged as one unit, and
an override remembers every value we confirmed for its field, so our own
earlier value arriving late (A to B to C) no longer flashes back. Save after a
reschedule no longer reads the contact when the contact is unchanged, so it
completes while the stream is silent. Evidence: [mutations.md](mutations.md).

Still true:

- Changing the contact in the dialog (or saving an event that has no
  `territoryId` yet) still reads the new contact to derive the territory.
  That read waits on the Listen stream, so during a silence Save stays on
  "Saving…": about 10 s under the E2E stall, until the SDK gave up on the
  backend and answered from its cache (not measured on a real silent
  stream). Using the contact list the page already
  holds would avoid it, but that list can be territory-filtered or stale, so
  the read was kept for correctness.
- Saving with the contact unchanged now keeps the event's territory instead of
  re-deriving it from the contact's current territory. An event whose
  contact moved territory since the last save keeps its old territory until
  the contact is changed.
- An event created in the last minute and edited (plain field write) while the
  stream is silent shows its created values until the delta or the 60 s
  expiry. The client's own write is not reflected because its cache never
  held the document; deleting it is reflected.
- The host picker's host list is a one-off read (`getDoc`). Opened while the
  stream is already silent, the picker does not appear until the stream
  answers. Same as before this change.
- Blind spots, each bounded by the 60 s expiry: a third party setting a field
  back to its value before our change, or to one of our own superseded
  values, reads as a stale snapshot and is masked. After an undo (A to B to
  A) the override holds A for the full minute, since a snapshot showing A
  cannot be told apart from a stale one.
- The A to B to C end-to-end test answers the second write's 200 itself
  (the route is not run), then writes that value for real: a lagging stream
  that delivers B after C was confirmed cannot be produced on demand. The
  unit tests cover the same ordering directly.

Events with no `startAt` match neither bounded query and are not listed.
Production has none (all create paths set `startAt`), so this was left as is.

Overrides expire after 60 s, so a masked change heals within a minute at
worst. Mutation evidence: [mutations.md](mutations.md).
