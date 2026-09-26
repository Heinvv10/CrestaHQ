# Prospecting PR 2 — route mutation tests

Each guard was mutated, the named test file run, and the mutation reverted
(script-driven: copy, replace one literal, run, restore; `git diff` clean
afterwards). All 15 went RED. Line numbers are at the time of the run.

| File:line | Mutation | Red test |
|---|---|---|
| `src/lib/prospecting/reports.ts:63` | `used >= input.quota` → `used > input.quota` | reports route: *accepts at used = quota - 1 and refuses at used = quota*; *concurrent POSTs cannot exceed the quota* |
| `src/lib/prospecting/reports.ts:62` | transactional `tx.get(usageRef)` → plain `usageRef.get()` | reports route: *concurrent POSTs cannot exceed the quota* |
| `src/lib/prospecting/reports.ts:34` | gate check deleted | reports route: *POST, GET, report GET and share all answer 403 gate_off* |
| `src/app/api/sub-accounts/[id]/prospecting/reports/route.ts:89` | contact tenant check deleted (`!contact.exists` only) | reports route: *a contact of another sub-account is the same 404 as a missing one* |
| `src/app/api/sub-accounts/[id]/prospecting/reports/route.ts:121` | release after publish failure removed | reports route: *publish returns null / throws → 503, report failed, charge released* |
| `src/lib/prospecting/share.ts:27` | mint's `status !== "ready"` check deleted | reports route: *refuses to share a report that is not ready* |
| `src/app/api/automations/prospecting/report/route.ts:52` | claim guard `status !== "queued"` removed | worker: *a replayed delivery after completion is a 200 no-op*; *a report already running/failed is not re-run* |
| `src/app/api/automations/prospecting/report/route.ts:34` | signature verification removed | worker: *refuses an unsigned call, or one signed for another route* |
| `src/app/api/automations/prospecting/report/route.ts:34` | signature not bound to this route's URL | worker: *refuses … one signed for another route* |
| `src/app/api/automations/prospecting/report/route.ts:75` | failed outcome written without `failAndRelease` | worker: *a failed outcome releases the quota* |
| `src/lib/prospecting/reports.ts:99` | decrement in `failAndRelease` deleted | worker: *a failed outcome releases the quota*; *a runner that throws …*; *a contact moved …* |
| `src/lib/prospecting/reports.ts:95` | settle guard weakened to `status === "ready"` | `reports.test.ts`: *releases once* |
| `src/lib/prospecting/public-report.ts:99` | `share.revokedAt` check deleted | public route: *a share stamped revoked is dead even while the report still points at it* |
| `src/lib/prospecting/public-report.ts:104` | `status !== "ready"` check deleted | public route: *… byte-identical 404s* (not-ready case) |
| `src/lib/prospecting/public-report.ts:106` | share/report tenancy check deleted | public route: *… byte-identical 404s* (tenancy case) |

The revoked-check mutation first SURVIVED: revoking also clears
`prospectReports.shareId`, which the resolver checks too, so the only test
path never reached `revokedAt` alone. The added test seeds a revoked share the
report still points at. The settle-guard mutation also survived at the route
level (the worker's claim prevents a second call) and is covered by
`reports.test.ts`.

Follow-up (public raw whitelist filled in from builder-sections' final raw shapes):

| File:line | Mutation | Red test |
|---|---|---|
| `src/lib/prospecting/public-report.ts:68` (now `public-sections.ts`, `publicSection`) | iterate `Object.keys(s.raw)` instead of `PUBLIC_RAW_KEYS[s.key]` | public route: *returns exactly the whitelisted payload*; *pass only whitelisted scalar raw keys* |

Fix round (PR #288 adversarial review). Each finding's test was run RED
against the unfixed code first (14 new tests failing), then green after the
fix. Guards mutated afterwards, same method; 13 of 14 went RED. Line numbers
at the time of the run.

| Finding | File:line | Mutation | Red test |
|---|---|---|---|
| M1 | `src/lib/prospecting/report-runner.ts:77` | drop `!STORED_FACT_SECTIONS.has(s.key)` | runner: *an all-null contact is failed*; *every outbound fetch failing is failed, even with a stored rating* |
| M3a | `src/lib/prospecting/report-runner.ts:64` | homepage fetch outside `withFetchSlot` | runner: *three reports at once never exceed ENRICH_CONCURRENCY page fetches in flight* |
| M3a | `src/lib/prospecting/sections/listings.ts:120` | directory fetch outside `withFetchSlot` | runner: *three reports at once …* |
| L2 | `src/lib/prospecting/sections/gbp.ts:49` | place-id check disabled | gbp: *a malformed place id (`..`, `a/b`, 301 chars) is unavailable with no call* |
| M3b | `src/lib/prospecting/reports.ts:93` | in-progress check in the reservation deleted | reports route: *refuses 409 report_in_progress …*; *concurrent POSTs for one contact reserve exactly one report* |
| M2 | `src/lib/prospecting/reports.ts:138` | `olderThanMs` age guard in `failAndRelease` deleted | worker: *a retry while the report is still within its deadline leaves it running* |
| M2a | `src/app/api/automations/prospecting/report/route.ts:69` | interrupted threshold → never | worker: *a retry of a report stuck running past the deadline + 60s settles it failed* |
| L3 | `src/app/api/automations/prospecting/report/route.ts:80` | gate check deleted | worker: *the gate turned off after queueing: not run, settled failed, quota released* |
| M2b | `src/app/api/sub-accounts/[id]/prospecting/reports/route.ts:59` | sweep skips every report | reports route: *settles a queued/running report older than 10 min …* |
| L3 | `src/lib/prospecting/public-report.ts:75` | gate check deleted | public route: *… byte-identical 404s* (gate off / gate field missing) |
| L3 | `src/lib/prospecting/public-report.ts:75` | `!contact \|\| contact.subAccountId !== …` → `contact?.subAccountId !== …` | SURVIVED — equivalent: a missing contact still fails the tenancy comparison |
| L1 | `src/lib/prospecting/public-report.ts:81` | `showName = true` | public route: *a person's name on a non-prospecting contact without a company is never published* |
| L1 | `src/lib/prospecting/public-report.ts:81` | `showName = company !== null` (prospecting source ignored) | public route: *a prospecting import's name is the business name* |
| L4 | `src/lib/prospecting/reports.ts:185` | member sections passed through with `raw` | reports route: *… whitelisted details, no raw (L4)* |

Fix round 2 (PR #288). The 5 new tests were run RED against 6ba391fe first
(the pool tests with only `REPORT_FETCH_CONCURRENCY` in place, so they failed
on behaviour: peak 6 > 4, and the lead's email `null`), then green. All 6
mutations went RED.

| Finding | File:line | Mutation | Red test |
|---|---|---|---|
| NEW-M1 | `src/app/api/automations/prospecting/report/route.ts:76` | `running` within the window → 200 skipped | worker: *a retry while the report is still within its window answers 503 so QStash retries again* |
| NEW-L2 | `src/app/api/automations/prospecting/report/route.ts:107` | final write no longer requires `running` | worker: *a report settled while the runner was working keeps its settled state* |
| NEW-M2 | `src/lib/prospecting/fetch-slots.ts:13` | report pool size 4 → 6 | runner: *three reports at once never exceed REPORT_FETCH_CONCURRENCY page fetches in flight* |
| NEW-M2 | `src/lib/prospecting/report-runner.ts:65` | homepage fetch outside the report pool | runner: *three reports at once …* |
| NEW-M2 | `src/lib/prospecting/sections/listings.ts:121` | directory fetch outside the report pool | runner: *three reports at once …* |
| NEW-L1 | `src/lib/prospecting/public-sections.ts:96` | `metaAdLibraryUrl` removed from `NAME_BEARING_KEYS` | public route: *drops the Meta Ad Library link, which searches by that name* |

The shared-pool regression itself (reports on Get Leads' slot) is what the
RED run of *six hung reports do not block a Get Leads enrichment from
fetching its lead* shows.
