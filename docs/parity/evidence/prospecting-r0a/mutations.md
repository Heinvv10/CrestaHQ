# Prospect report R0a (announce protocol) — mutation record

*Part of the [Prospect report redesign SOW](../../../programme/prospect-report-redesign-sow.md) (C1, "Announce protocol"). Run 2026-09-28 on branch `feat/report-r0a-announce-protocol`, Node 22.23.1.*

Each mutation was applied to the production code by a script (exact string replace, refusing a pattern that did not match exactly once), the test set below was run, and the file was restored. The set: `src/lib/prospecting/report-announce.test.ts` (A, 22 seam tests through the real report worker, poll worker, announce sweep, share mint/revoke and workflow engine on the in-memory Firestore), `src/lib/workflows/reentry-race.test.ts` (E), `src/lib/prospecting/report-ready-trigger.test.ts`, `src/app/api/automations/prospecting/**`, `src/lib/qstash/register-schedules.test.ts`, `src/middleware.test.ts`, `src/app/report/**`, `src/app/api/public/prospecting/**` — 173 tests, all green unmutated. The rules mutation ran `pnpm exec vitest run --config vitest.rules.config.mts src/lib/prospecting/prospecting.firestore-rules.test.ts` against the Rules test API.

| # | Mutation | Result (first failing test) |
|---|---|---|
| 1 | Engine: the key-doc existence check removed | **RED 5** — E: every_time, a repeat of the key is refused after the first run completed |
| 2 | Engine: a keyed `every_time` enrolment takes the unguarded batch path | **RED 5** — E: same |
| 3 | Engine: the key doc is not written with the run | **RED 6** — E: same |
| 4 | Engine: `fireWorkflowTrigger` does not pass `enrolmentKey` to `enroll` | **RED 7** — E: same |
| 5 | Announce: the `announceProtocol` check removed | **RED 1** — A: a pre-R0 report settled by the R0 poll is due, but never announced |
| 6 | Announce: the `announceDueAt` check removed | **RED 14** — A: ready with a scan announces nothing |
| 7 | Announce: the `announcedAt` check removed | **RED 1** — A: a revoke sends nothing, and a later re-mint does not make it announce |
| 8 | Announce: the "superseded" check removed | **RED 1** — A: second report while the first is pending |
| 9 | Announce: the live-share (`shareId`) check removed | **RED 1** — A: no live share, though the contact still holds a link |
| 10 | Announce: the `lastReportUrl` check removed | **RED 1** — A: a live share, but no link on the contact |
| 11 | Announce: the headline is not stamped from the final report | **RED 14** — report-ready-trigger: the WhatsApp carries the headline |
| 12 | Announce: the trigger fires without `enrolmentKey` | **RED 2** — A: crash after the fire, before `announcedAt`: one run after recovery (poll and sweep) |
| 13 | Announce: a trigger error still records `announcedAt` | **RED 1** — A: a trigger that errors leaves the report unannounced; the sweep fires it |
| 14 | Announce: `announcedAt` written BEFORE the fire | **RED 3** — A: same |
| 15 | Share: a re-mint does not re-stamp `lastReportUrl` | **RED 1** — A: a re-mint, the message carries the NEW link |
| 16 | Share: a revoke does not clear `lastReportUrl` | **RED 1** — A: a revoke records "no live link" and clears the link |
| 17 | Share: stamps the contact even when the report is not its `lastReportId` | **RED 1** — A: re-mint or revoke of a report that is not the latest |
| 18 | Settle (`settleApexgeo`: poll, sweep, worker's schedule-failure settle): `announceDueAt` not written | **RED 18** — A: done |
| 19 | Worker: ready with no scan does not set `announceDueAt` | **RED 4** — report-ready-trigger: a ready report enrols the workflow |
| 20 | Worker: the claim does not stamp `announceProtocol` | **RED 21** — same |
| 21 | Worker: the claim does not write `announcedAt: null` (the sweep's `== null` query then misses it) | **RED 6** — A: the claim stamps the protocol |
| 22 | Worker: ready does not stamp `lastReportId` | **RED 21** — report-ready-trigger |
| 23 | Worker: no announce after settling | **RED 4** — report-ready-trigger |
| 24 | Poll: the no-longer-pending path does not announce | **RED 2** — A: crash before the fire, the next poll delivery announces it once |
| 25 | Poll: a settle does not announce | **RED 15** — A: done |
| 26 | Sweep: the stuck query settles pre-R0 reports too | **RED 1** — A: pre-R0 report pending 40 minutes, the sweep neither settles nor announces it |
| 27 | Sweep: the 30-minute threshold dropped to 0 | **RED 1** — A: sweep, 29 minutes left alone |
| 28 | Sweep: the due-and-unannounced pass removed | **RED 4** — A: sweep |
| 29 | Schedule: the sweep is not registered under `leadstack-prospect-announce` | **RED 1** — register-schedules: registers the 15-minute sweep |
| 30 | Middleware: the sweep path is not public | **RED 1** — middleware: opens the exact path the schedule calls |
| 31 | Rules: `workflowEnrolmentKeys` opened to any signed-in user | **RED 4/39** — every enrolment-key case |

One survivor was found and removed rather than kept: the sweep also announced each report it had just settled, directly, in case its server-stamped `announceDueAt` sorts after the due query's clock. The in-memory store has one clock, so no test could tell it apart; the code was dropped and the due query now takes a fresh `new Date()` after the settle pass. A report whose `announceDueAt` is a few ms ahead is announced by the next sweep.
