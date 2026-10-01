# Events listener bound

The appointments list used to subscribe to a sub-account's whole events
history (`subscribeToEvents`). It now uses `subscribeToAppointments`: two
bounded listeners split at subscribe time.

- Upcoming: `startAt >= now`, ascending, limit 500.
- Past: `startAt < now`, descending, 200 per page. "Load older" adds a page.
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
tabs and "Load older" only.

- `1-upcoming.png`: Upcoming (0), Cancelled (85+), All (205+).
- `2-all.png`: All tab, 25 rows, "Load more (180 more)".
- `3-all-after-load-older.png`: after one "Load older": Cancelled (159+), All
  (405+), "Load more (380 more)", notice now "showing back to Sat, Sep 26".
  The notice and "Load older" button sit under the rows.
