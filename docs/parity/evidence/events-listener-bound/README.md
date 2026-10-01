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

The list's confirmed-status override covers the row menu and the Edit /
Reschedule dialog's actions panel: mark-status, and mark-paid (which calls the
same `onStatusChange`, so it feeds the override too; that path is untested, no
unit or E2E exercises it). These dialog writes are still snapshot-only (the
row updates when the Listen delta arrives, which can lag ~30 s):

- operator reschedule (`event-dialog.tsx` submit path)
- server-side DELETE for Google-mirrored events (`event-dialog.tsx`)

Events with no `startAt` match neither bounded query and are not listed.
Production has none (all create paths set `startAt`), so this was left as is.

Overrides expire after 60 s, so a masked change heals within a minute at
worst. Mutation evidence: [mutations.md](mutations.md).
