# QStash daily dispatcher — mutation proof

Each row: one production change (script-applied text replacement, asserted to match exactly once), the named test file run, the file restored. Run 2026-09-28 on `fix/qstash-daily-dispatcher`.

**Result: 7 mutants, 7 killed.**

| Mutant | Change | Test file | Outcome |
|---|---|---|---|
| M1 create before delete | the retired-schedule delete loop moved after the create loop in `register-schedules.ts` | `src/lib/qstash/register-schedules.test.ts` | killed — "frees the five retired slots BEFORE creating…" fails (the full 10-slot fake refuses daily-housekeeping and announce on quota) |
| M2 404 not a no-op | the `status === 404` branch disabled | `src/lib/qstash/register-schedules.test.ts` | killed — "treats an already-deleted retired schedule as a no-op on the next run" fails |
| M3 no per-job isolation | the first failing job rethrows out of the dispatcher loop | `src/app/api/cron/daily-housekeeping/route.test.ts` | killed — "keeps going past a throwing job…" and "a failure in the LAST job still answers 500" fail |
| M4 api-cleanup failure swallowed | `if (!body.ok)` → `if (false)` in the dispatcher's api-cleanup job | `src/app/api/cron/daily-housekeeping/route.test.ts` | killed — "keeps going past a throwing job and a failed api-cleanup…" fails |
| M5 dispatcher reports success | response status forced to 200 | `src/app/api/cron/daily-housekeeping/route.test.ts` | killed — 2 tests fail |
| M6 per-job api-cleanup route reports success | `{ status: body.ok ? 200 : 500 }` → `{ status: 200 }` in `api-cleanup/route.ts` after the `runApiCleanup` extraction | `src/app/api/cron/api-cleanup/*.test.ts` | killed — 2 isolation tests fail |
| M7 route not public | `"/api/cron/daily-housekeeping"` removed from `PUBLIC_PATHS` | `src/middleware.test.ts` | killed — Tests 1 failed \| 47 passed (48) |
