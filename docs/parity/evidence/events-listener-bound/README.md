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

The list's confirmed-change override (`useEventOverrides`, rules in
`src/lib/calendar/event-overrides.ts`) covers these server writes:

- the row menu's mark-status;
- from the Edit / Reschedule dialog: the actions panel's mark-status and
  mark-paid, the operator reschedule, the host reassign, and the server-side
  DELETE for Google-mirrored events.

The reschedule and delete paths were snapshot-only until 2026-10-01, and the
reassign path until 2026-10-02. Evidence is in [mutations.md](mutations.md).
The calendar grid uses the same hook for the same dialog.

Still snapshot-only (the change shows when the Listen delta arrives, which can
lag ~30 s):

- The calendar grid's "New Event" (`POST /api/events`): the new event does not
  appear until the delta.
- "Retry sync" in the dialog (`google-sync-notice.tsx`): the error notice stays
  up until the delta.
- The per-booking-page bookings list (`booking/[slug]/bookings`) opens the
  same dialog without the hook.
- A reschedule confirms `startAt` / `endAt` only. The "Rescheduled" badge
  (`rescheduleCount`) is not in the route's response.

Other known limits:

- Two of our own writes in a row to the same field (A to B to C, before any
  delta) briefly show B when the first delta lands. The override for C was set
  with `from` = A, so the snapshot reading B counts as a third value and drops
  it until the C delta arrives. Status overrides behaved the same before this
  change (#330), so this is not a regression.
- While the Listen stream is silent, the dialog's Save stays on "Saving…"
  after a reschedule. The field write that follows reads the contact first
  (`territoryIdForContact`, a `getDoc`), and that read waits on the same
  stream. The row behind it already shows the new time. Not changed here.
- The dialog's own host picker reads the page's hosts with a one-off read and
  keeps showing the old assignee after a reassign (its `event` prop does not
  update). The list row is right. A consequence: picking the original host again
  in the same open dialog, to undo, is a silent no-op (the stale prop still equals
  it, so no request is sent). Closing and reopening the dialog works around it.
  Same as before this change.
- Overrides are judged per field. A third party changing only one of
  start / end while the other still reads its old value leaves our other
  field showing until the delta or the 60 s expiry.
- mark-paid feeds the override through the same `onStatusChange`, but no unit
  or E2E test exercises that path.
- The calendar grid's use of the hook is typechecked and shares the hook's
  unit tests. No E2E drives it.

Events with no `startAt` match neither bounded query and are not listed.
Production has none (all create paths set `startAt`), so this was left as is.

Overrides expire after 60 s, so a masked change heals within a minute at
worst. Mutation evidence: [mutations.md](mutations.md).
