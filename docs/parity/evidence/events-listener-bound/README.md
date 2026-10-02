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
`src/lib/calendar/event-overrides.ts`) covers every SERVER write reachable from
the list: the row menu's mark-status, and from the Edit / Reschedule dialog the
actions panel's mark-status and mark-paid, the operator reschedule, and the
server-side DELETE for Google-mirrored events. The last two were snapshot-only
until 2026-10-01 (closed; evidence in [mutations.md](mutations.md)). The
calendar grid uses the same hook for the same dialog.

Still open:

- mark-paid feeds the override through the same `onStatusChange`, but no unit
  or E2E exercises that path.
- A reschedule confirms `startAt` / `endAt` only. The "Rescheduled" badge
  (`rescheduleCount`) is not in the route's response, so it still arrives with
  the delta.
- While the Listen stream is silent, the dialog's Save stays on "Saving…"
  after a reschedule: the field write that follows reads the contact first
  (`territoryIdForContact`, a `getDoc`), and that read waits on the same
  stream. The row behind it already shows the new time. Not changed here.
- The per-booking-page bookings list (`booking/[slug]/bookings`) opens the same
  dialog and is still snapshot-only.
- The calendar grid's use of the hook is typechecked and shares the hook's
  unit tests; no E2E drives it.
- Overrides are judged per field. A third party changing only one of
  start / end while the other still reads its old value leaves our other
  field showing until the delta or the 60 s expiry.

Events with no `startAt` match neither bounded query and are not listed.
Production has none (all create paths set `startAt`), so this was left as is.

Overrides expire after 60 s, so a masked change heals within a minute at
worst. Mutation evidence: [mutations.md](mutations.md).
