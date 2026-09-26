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
| `src/lib/prospecting/public-report.ts:71` | iterate `Object.keys(s.raw)` instead of `PUBLIC_RAW_KEYS[s.key]` | public route: *returns exactly the whitelisted payload*; *pass only whitelisted scalar raw keys* |
