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
