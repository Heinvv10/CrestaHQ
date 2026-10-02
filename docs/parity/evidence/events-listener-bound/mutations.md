# Events listener bound — mutation evidence

Each guard was mutated in place, the named test file run with
`pnpm exec vitest run <file>`, then the file restored byte-for-byte (SHA-1
compared before and after). Each mutation was checked to have changed the
file before the run. Re-run 2026-10-01 against the code after merging
origin/main (b5dcd832); all rows below were red and restored.

| Guard | Mutation | Failing test | Restored |
|---|---|---|---|
| Upcoming date bound (`events.ts`) | delete `where("startAt", ">=", boundary)` | events.appointments.test.ts › upcoming half: startAt >= now, soonest first, capped | yes |
| Past date bound (`events.ts`) | delete `where("startAt", "<", boundary)` | events.appointments.test.ts › past half: startAt < the same instant, newest first, limited to pastLimit | yes |
| Upcoming limit (`events.ts`) | delete `limit(APPOINTMENTS_UPCOMING_LIMIT)` | events.appointments.test.ts › upcoming half: … capped | yes |
| Past limit (`events.ts`) | delete `limit(opts.pastLimit)` | events.appointments.test.ts › past half: … limited to pastLimit | yes |
| Past truncation flag (`events.ts`) | `pastTruncated: false` | events.appointments.test.ts › waits for both halves, merges them oldest first, and flags a full half as truncated | yes |
| Upcoming truncation flag (`events.ts`) | `upcomingTruncated: false` | events.appointments.test.ts › flags the upcoming half as truncated when it returns a full page | yes (added 2026-10-01: this mutation survived the original suite, so the test was added) |
| "Older not loaded" notice (`appointments-window.ts`) | `showOlderNotice` returns `false` | appointments-window.test.ts › showOlderNotice › on Cancelled and All whenever older events were not loaded | yes |
| Partial tab count (`appointments-window.ts`) | Cancelled/All ignore `pastTruncated` | appointments-window.test.ts › tabIsPartial › Cancelled and All span both halves | yes |
| Reaper scope guard (`reap-events.ts`) | delete `assertReapableSubAccount(subAccountId)` | reap-events.test.ts › refuses a non-fixture sub-account before querying anything | yes |
| Reaper match: title prefix (`reap-events.ts`) | delete the `"E2E "` prefix check | reap-events.test.ts › deletes only stale E2E-titled events in the fixture | yes |
| Reaper match: staleness (`reap-events.ts`) | age check → `return true` | reap-events.test.ts › deletes only stale E2E-titled events in the fixture; › keeps an E2E event exactly at the stale boundary | yes |
| Reaper match: unknown age (`reap-events.ts`) | missing `createdAt` → reapable | reap-events.test.ts › keeps an event with no createdAt (age unknown) | yes |

## Response-driven status override (2026-10-01)

| Guard | Mutation | Failing test | Restored |
|---|---|---|---|
| Override applied to rows (`status-overrides.ts`) | `applyStatusOverrides` maps rows to themselves | appointments-list.spec.ts › a cancelled row reads Cancelled without waiting for the Firestore delta (E2E, fixture row stayed "Confirmed"); status-overrides.test.ts › shows the overridden status on that row only | yes (SHA-1 compared); E2E green 3/3 repeats after rebuild with the fix |

An earlier attempt at this mutation (removing only the empty-overrides early
return) left the E2E green because the mapping below it still applied; it was
not a valid mutation and is not counted.

The E2E holds Firestore Listen traffic by routing new `Listen/channel`
requests to a never-settling handler and cutting the open stream with an
offline blip. Routing alone does not work: the open stream is one long
response a later route never sees (measured: the test passed with the
override disabled).

## Review round 1 (2026-10-01)

Unit rows run with `pnpm exec vitest run <file>`; E2E rows rebuild the app with
the mutation and run the named spec test against the fixture (CI idle first).
Every file restored (SHA-1 compared).

| Guard | Mutation | Failing test |
|---|---|---|
| 1a no override when latest snapshot already shows it | condition forced false | status-overrides.test.ts › sets nothing when ...; › and clears an older override |
| 1a `from` taken from the latest snapshot | hard-coded `no_show` | › records the latest snapshot's status as `from` |
| 1a page reads the snapshot via a ref | `noteConfirmedStatus` uses the click-time `snapshotEvents` | E2E › a delta that beats the response does not leave an override masking a later change |
| 1b TTL | `nowMs - at < TTL` → `true` | status-overrides.test.ts › drops an override once it is older than the TTL |
| 1b expiry timer delay | delay ignores TTL | › reports when the next override expires |
| 1b page expiry timer | handler does nothing | E2E › a status override expires after a minute instead of masking the row |
| 2 dialog status change reaches the page | remove `onStatusChange?.(...)` in event-dialog.tsx | E2E › a status changed from the Edit dialog reads on the row without the Firestore delta |
| 3 error reported once | drop the `errored` guard | events.appointments.test.ts › both halves failing: one error report |
| 3 failed past half blocks the other | `past = null` on error | › one half failing: the other still renders ... |
| 3 failed upcoming half blocks the other | `upcoming = null` on error | › both halves failing ... |
| 3 `failedHalves` not reported | drop the past entry | › one half failing ... |
| 4 past probe | `limit(pastLimit + 1)` → `limit(pastLimit)` | › past half: ... limited to pastLimit (+1) |
| 4 upcoming probe | same for upcoming | › upcoming half: ... capped (limit + 1 ...) |
| 4 probe doc shown (past / upcoming) | drop the `slice` | › waits for both halves ...; › flags the upcoming half ... |
| 4 truncated at exactly the limit (past) | `>` → `>=` | › a half that returns exactly its limit is NOT truncated |
| 4 truncated at exactly the limit (upcoming) | `>` → `>=` | survived at first; test added: › the upcoming half returning exactly its limit is NOT truncated |

Note: an early E2E "stall" using only `page.route` stayed green with the
override disabled (the open stream is never re-routed); the final tests cut the
stream with an offline blip first.

## Dialog server writes: reschedule and Google-mirrored delete (2026-10-02)

The status override became a per-event confirmed-change override
(`event-overrides.ts`, page wiring in `use-event-overrides.ts`). Unit rows ran
`pnpm exec vitest run` on the listed test files; each file was restored and
SHA-1 compared, and each mutation was checked to have changed the file. All
rows were red.

| Guard | Mutation | Failing test (first named) |
|---|---|---|
| Patch: nothing set when the latest snapshot already shows the value | `if (row && from === to)` → `if (false)` | event-overrides.test.ts › sets nothing when the latest snapshot already shows the confirmed status; › … the new times; › never masks the later correction back to no-show |
| Patch: `from` taken from the latest snapshot | `from = to` | › records the latest snapshot's status as `from`; › records each time against the latest snapshot's |
| Patch reconcile: stale snapshot keeps | drop the `=== o.from` check | › keeps the override while the snapshot is stale; use-event-overrides.test.ts › shows a confirmed status, reschedule and delete over a snapshot that has not caught up |
| Patch reconcile: third value drops | drop only when `=== o.to` | › drops it when a third party moves the booking again, so their time shows; › … a different status (someone else changed it) |
| Patch reconcile: times compared by value | compare `Date` objects | › keeps the override while the snapshot is stale (reschedule) |
| Delete: nothing set when the snapshot already dropped the event | remove the early return | › sets nothing when the latest snapshot already dropped the event |
| Delete reconcile: gone from the snapshot drops | never drop a deletion | › is dropped once the snapshot no longer holds the event |
| Delete reconcile: still present keeps | drop a deletion on any snapshot | › hides the row while the snapshot still holds it; hook › shows a confirmed … delete |
| TTL, all kinds | expiry check → `true` | › a reschedule and a deletion expire the same way; hook › expires overrides after the TTL |
| Expiry timer delay | delay = pad only | › reports when the next override expires; › fields of one event expire on their own clocks |
| Apply: deleted row hidden | remove `if (o.deleted) return []` | › leaves out a deleted row only; › a deleted event leaves every tab's count |
| Apply: confirmed start shown | drop the `startAt` spread | › shows the confirmed times on a rescheduled row only; › a booking rescheduled from the past into the future joins Upcoming |
| Apply: confirmed end shown | drop the `endAt` spread | › shows the confirmed times on a rescheduled row only |
| Apply: confirmed status shown | drop the `status` spread | › shows the overridden status on that row only |
| Hook reconciles on every snapshot | remove the reconcile call | use-event-overrides.test.ts › drops each override when a snapshot settles it |
| Hook reads the newest snapshot via the ref | never update the ref | › judges a confirmation against the newest snapshot, not the first render's |
| Hook expiry timer | handler does nothing | › expires overrides after the TTL, falling back to the snapshot |
| Save: only a 200 confirms a time (refused / `no_change` apply nothing) | confirm on any response | booking-edit-save.test.ts › confirms no time when the reschedule is refused or was not needed |
| Save: confirms the server's times, not the ones asked for | use the requested `startAt` | › hands over the times the server's 200 confirmed, not the ones asked for, before the field write |
| Save: nothing confirmed without times in the body | drop the NaN check | › confirms no time when the response carries none |
| Save: confirmation handed over before the field write | call it after `updateFields` | › hands over the times … before the field write |
| Route returns the stored start / end | drop `newStartAt` / `newEndAt` | reschedule/route.test.ts › returns the times it stored |

The "before the field write" row exists because the first E2E run failed. After
the reschedule's 200, `updateEvent` reads the contact (`territoryIdForContact`,
a client `getDoc`), and with the Listen stream silent that read does not
return. If the time is confirmed only after the field write, the row never
updates and Save stays on "Saving…".

E2E rows: `event-dialog.tsx` was mutated, the app rebuilt (E2E_PORT=3143) with
the mutation, the file restored (SHA-1 compared), and the one named test of
`appointments-list.spec.ts` was run against that build with CI idle. The
unmutated build passed all 8 tests of the spec first.

| Guard | Mutation | Failing test |
|---|---|---|
| Dialog hands the confirmed reschedule to the page | remove the `onRescheduled` callback passed to `saveBookingPageEdit` | › an operator reschedule from the Edit dialog shows the new time without the Firestore delta (row kept the old time) |
| Dialog hands the server delete to the page | remove `onDeleted?.(event.id)` | › deleting a Google-mirrored event removes the row without the Firestore delta (row still present) |
