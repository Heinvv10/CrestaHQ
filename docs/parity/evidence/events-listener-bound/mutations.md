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

## Host reassign (2026-10-02, review round 1)

The assign route's 200 already returns `assignedToUid` / `assignedToName`, so
the route is unchanged. Both are now patch fields with the same per-field
rules. Unit rows were run and restored as above, and all were red.

| Guard | Mutation | Failing test |
|---|---|---|
| Reassign control reports the 200's assignee | remove `onReassigned?.(…)` in `booking-reassign.tsx` | booking-reassign.test.ts › reports the assignee from the route's 200 |
| Nothing reported without the assignee in the body | drop the `!== undefined` check | › reports nothing when the 200 does not name the assignee |
| Assignee fields are overridable | drop them from `FIELDS` | event-overrides.test.ts › records the assignee against the latest snapshot's and shows it; use-event-overrides.test.ts › shows a confirmed host reassign until the snapshot catches up |
| Assignee shown | drop the `assignedToUid` spread | › records the assignee … and shows it |
| Assignee name shown | drop the `assignedToName` spread | use-event-overrides.test.ts › shows a confirmed host reassign … |
| A missing assignee reads as null | `e[field] ?? null` → `e[field]` | › clearing the host of a doc that never had one is already shown: nothing set (survived at first; this test was added) |
| Hook patches the assignee | `noteConfirmedAssignee` leaves state as is | use-event-overrides.test.ts › shows a confirmed host reassign … |

E2E row, using the same method as above. The unmutated build passed all 9 tests
of the spec.

| Guard | Mutation | Failing test |
|---|---|---|
| Dialog hands the confirmed assignee to the page | `onReassigned={() => {}}` on the panel | › a host reassigned from the Edit dialog shows on the row without the Firestore delta (Owner cell never showed the new host) |

The first attempt at this row removed the prop outright. That is a type error,
so the build failed and the round was not counted.

## Closing the known gaps (2026-10-02)

Unit rows: each mutation was applied by a script that first checked the
original text occurred exactly once and that the file changed, ran
`pnpm exec vitest run` on the listed test files, then restored the file and
compared SHA-1 before and after. All 34 rows were red and restored.

| Item | Guard | Mutation | Failing test (first named) |
|---|---|---|---|
| 1 New Event | Insert dropped once the snapshot holds it | remove `delete entry.inserted` | event-overrides.test.ts › is dropped once the snapshot holds it, and the snapshot's copy shows |
| 1 | Insert never shown twice | drop the `!held.has(id)` check | › is never shown twice |
| 1 | Insert shown | inserted list = `[]` | › shows the created event while the snapshot does not hold it; use-event-overrides.test.ts › shows a created event, … |
| 1 | Nothing inserted when the latest snapshot already holds it | remove the early return | › sets nothing when the latest snapshot already holds it |
| 1 | Created event needs valid times | drop the start/end check | route.created-event.test.ts › a body without the stored event yields nothing to show |
| 1 | Created event needs an id | drop the id check | same |
| 1 | Create route returns the stored doc | drop `stored` from the 201 | › returns the stored event, which the client rebuilds field for field |
| 1 | Hook inserts | `noteConfirmedCreate` leaves state as is | use-event-overrides.test.ts › shows a created event, … |
| 2 Retry sync | Sync error cleared on apply | drop the `googleSyncError` spread | event-overrides.test.ts › hides the error the snapshot still shows |
| 2 | A new failure (same message, later) is not masked | read the error by message only | › a NEW failure (same message, later) is not masked |
| 2 | Route: `synced` only when no error after the push | `synced: true` | google-sync/route.test.ts › says not synced, with the reason, when the push failed again |
| 2 | Route: not synced when the event is gone | `synced: !after?.googleSyncError` | › says not synced when the event is gone after the push |
| 2 | Notice reports only `synced: true` | call `onSynced` on any 200 | google-sync-notice.test.ts › reports nothing when the retry ran but the push failed again; › … does not say whether it synced |
| 2 | Notice reports nothing on a refusal | remove the `!res.ok` throw | › reports nothing on a refusal |
| 2 | Hook clears | `noteConfirmedSyncCleared` leaves state as is | use-event-overrides.test.ts › shows a created event, … |
| 4 Badge | Reschedule stores the read count + 1 | `rescheduleCount = 1` | reschedule.test.ts › stores one more reschedule than the transaction read, and returns that count |
| 4 | Route returns the stored count | drop `rescheduleCount` from the 200 | reschedule/route.test.ts › returns the reschedule count it stored, for the Rescheduled badge |
| 4 | Save hands the count on | drop it from `onRescheduled` | booking-edit-save.test.ts › hands over the reschedule count the 200 stored, with the times |
| 4 | Count shown | drop the `rescheduleCount` spread | event-overrides.test.ts › shows the stored count the reschedule's 200 reported, … |
| 4 | Hook patches the count | drop it from the reschedule patch | use-event-overrides.test.ts › shows a created event, … |
| 5 Save | Unchanged contact dropped | return the fields unchanged | booking-edit-save.test.ts › drops an unchanged contact, … |
| 5 | Changed contact kept | drop the contact comparison | › keeps a changed contact, so its territory is re-derived |
| 5 | Event without a territory keeps the read | drop the `territoryId` check | › keeps the contact of an event that has no territory yet |
| 6 A to B to C | Superseded value of ours reads as stale | keep only on `=== from` | event-overrides.test.ts › the B delta arriving first is one of ours, …; › the same holds for status …; › an undo … |
| 6 | `ours` accumulates | `ours = [to]` | › remembers every value we confirmed, the latest last |
| 6 | Undo keeps an override while another value of ours is pending | drop the `ours.every` condition | › an undo (A -> B -> A) before B's delta keeps A over B's late delta, until the TTL |
| 6 | Re-confirming a shown value with nothing else pending sets nothing | `ours.length === 0` | › sets nothing when the latest snapshot already shows the confirmed status (and 3 more) |
| 7 Dialog | Dialog gets the page's current copy | `shownEvent` returns the picked event | › is the page's current copy, overrides applied |
| 7 | Form keyed on the event id (no reset mid-edit) | deps `[open, event, defaultDate]` | event-dialog.test.ts › keeps unsaved edits when the open event's data changes |
| 7 | Form re-initialises for another event | deps `[open, defaultDate]` | › initialises from the event when another event is opened |
| 8 Unit | Start/end key includes the end | key ignores the end | event-overrides.test.ts › start and end are kept or dropped together: … (and 3 more) |
| 8 | Reconcile judges start and end together | judge the start alone (the old per-field rule) | › start and end are kept or dropped together: a third party changing only the end drops both |
| 9 mark-paid | Mark-paid feeds the override | remove `onStatusChange("scheduled")` | booking-actions-panel.test.ts › feeds the confirmed status to the page on the route's 200 |
| 9 | Nothing fed on a refusal | remove the `!res.ok` throw | › feeds nothing when the route refuses |

E2E rows: a script applied each mutation (original text found exactly once,
file changed), rebuilt the app (E2E_PORT=3144), restored the file (SHA-1
compared), waited until no CrestaHQ CI run was in progress or queued, then ran
the one named test of `appointments-list.spec.ts` against the mutated build.
A clean rebuild then passed all 17 tests of the spec. All 10 rows were red and
restored.

| Item | Guard | Mutation | Failing test (what was seen) |
|---|---|---|---|
| 1 | Dialog hands the created event to the page | remove `onCreated?.(created)` | › the calendar grid shows a New Event from the create route's 201, … (no chip on the grid) |
| 1 | A client delete is reported as confirmed | remove `onDeleted?.(event.id)` after `deleteEvent` | same test (the created event stayed on the grid after Delete) |
| 2 | Retry sync's confirmed clear reaches the page | `<GoogleSyncNotice event={event} />` (no `onSynced`) | › Retry sync clears the Google error notice … (notice stayed) |
| 3 | Bookings list passes the dialog's status callback | remove `onStatusChange` on its `EventDialog` | › a status changed from the per-booking-page bookings list … (no "Cancelled") |
| 4 | Reschedule override carries the stored count | drop `rescheduleCount` from the hook's patch | › Save completes and the Rescheduled badge shows … (no badge) |
| 5 | Save skips the contact read for an unchanged contact | `const { startAt, endAt, ...fields } = payload` | same test (dialog still open after 5 s) |
| 6 | A superseded value of ours reads as stale | keep only on `=== from` | › a delta of our own earlier status (A -> B -> C) … (row showed "Showed") |
| 7 | The dialog gets the page's current copy | `shownEvent` returns the picked event | › the open dialog follows a confirmed reassign … (picker kept the old host) |
| 8 | Start and end judged as one unit | judge the start alone in reconcile | › a third party changing the end, with the start back at its old value, … (row kept our time) |
| 9 | The grid passes the dialog's reschedule callback | remove `onRescheduled` on `CalendarView` | › the calendar grid shows a booking rescheduled from its dialog … (chip kept "7am") |

The item 5 row survived its first run: the test then allowed 15 s for the
dialog to close, and with the contact read Save took about 10 s (the SDK gave
up on the backend and answered from its cache). The test now allows 5 s; it
went red as above, and the clean build passes it.

## Review round 1 of PR #338 (2026-10-02)

Same script and method as the unit rows above; all 9 rows were red and
restored. The three item 5 rows above for `withoutUnchangedContact` are
superseded: that helper is gone, replaced by `changedFields`. The earlier row
"Delete reconcile: gone from the snapshot drops" is superseded by R2 (a
deletion is now kept until its TTL).

| Finding | Guard | Mutation | Failing test (first named) |
|---|---|---|---|
| R1 (HIGH) | Save diffs against the copy frozen at form init | build the baseline from the live `event` at Save | event-dialog.test.ts › a third party's move while open is not reverted by a notes-only save; › … title change is not written back; › a manual event's save … |
| R1 | Baseline captured when the form initialises | never set the ref | same three, and › a time the operator changed is rescheduled to the operator's time |
| R1 | `changedFields` leaves unchanged fields out | include every field | booking-edit-save.test.ts › is empty when nothing changed …; event-dialog.test.ts › a third party's move … |
| R1 | `changedFields` leaves an unchanged time out | time always "changed" | › is empty when nothing changed (times compared by value) |
| R1 | Start and end sent together | compare the start only | › sends start and end together when either moved |
| R1 | Booking save writes no fields when none changed | always call `updateFields` | › moves the booking and writes no fields; event-dialog.test.ts › a time the operator changed … |
| R1 | Manual save writes nothing when nothing changed | always call `updateEvent` | event-dialog.test.ts › a manual event's save writes only what the operator changed, and nothing when nothing changed |
| R2 | Deletion kept when the event leaves a snapshot | drop a deletion whose event is absent | event-overrides.test.ts › is kept when the event is absent from a snapshot, … |
| R3 | `ours` capped at the last 8 | no cap | event-overrides.fields.test.ts › remembers at most the last EVENT_OVERRIDE_OURS_MAX values |

The R1 "live event" mutant is the round's reported behaviour: with it, the
notes-only save after a third-party move POSTs `/reschedule` back to the old
time, and the field write carries the stale title.

E2E after this round: a clean build passed all 17 tests of
`appointments-list.spec.ts`. The item 5 E2E row was re-run against the new
guard (method as above): with `changedFields` writing every field, the
unchanged `contactId` is written again, Save reads the contact, and
› Save completes and the Rescheduled badge shows … went red (dialog still
open after 5 s). Restored, SHA-1 compared.
