# Prospecting PR 4 — mutation record

*Part of the [Prospecting programme](../../../programme/prospecting-module.md). Run 2026-09-27 on branch `feat/prospecting-pr4-trigger-guard`, Node 22.23.1, `pnpm exec vitest run <file>`.*

Each mutation was applied to the production code, the named test file was run, and the file was restored (`git diff --stat` checked unchanged afterwards). Test numbers are the ones in the PR brief.

Files: `G` = `src/lib/workflows/prospecting-approach-guard.test.ts` (9 tests), `R` = `src/lib/prospecting/report-ready-trigger.test.ts` (3 tests). Both are seam tests through the real `runStep` / report worker on the in-memory Firestore.

| # | Mutation | File run | Result |
|---|---|---|---|
| M1 | `engine.ts` runStep: the `guardProspectSend(...)` call replaced by `null` (guard never runs) | G | **RED 6/9** — stamp-before-dispatch (2), second workflow refused (3), same-workflow not recounted (4), cap 21st held (5), custom cap 2 (5), guard throws (8) |
| M2 | Stamp moved AFTER the send: `tx.update(contact…)` removed from `claimApproach`, and a stamp written after `exec` in runStep | G | **RED 2/9** — stamp-before-dispatch (2), opted-out not stamped (7) |
| M3 | Worker idempotency removed: claim accepts any existing report (`report.status !== "queued"` check dropped) | R | **RED 1/3** — retry mints no second share / fires no second run (10): runner called twice |
| M3b | Worker re-announces on retry: the skipped-delivery branch calls `announceReadyReport` for a ready report | R | **RED 1/3** — (10): `prospectReportShares` has 2 docs |
| M4 | Opt-out ordering: guard runs before the opt-out / no-address skip (`!sendSkips(...)` dropped) | G | **RED 1/9** — opted-out prospect stamped (7) |
| M5 | Cap off by one: `used >= cap` → `used > cap` | G | **RED 2/9** — 21st held (5), custom cap 2 (5) |
| M6 | Guard fails open: `guardProspectSend(...).catch(() => null)` | G | **RED 1/9** — guard transaction throws → no send (8) |
| M7 | `mergeSubject` drops the headline (`headline: ""`) | R | **RED 1/3** — workflow WhatsApp carries headline + link (1) |
| M8 | Same-workflow pass removed (`approachedWorkflowId === workflowId` → `false`) | G | **RED 1/9** — same workflow's second send (4) |

All restored; both files green afterwards (G 9/9, R 3/3).

Test 9 (a person's composer WhatsApp still reaches an approached prospect) guards against the guard spreading to manual sends; no production mutation applies to it in this PR, because the manual path was deliberately left untouched.
| M9 | Cap parser accepts any number (`typeof cap === "number"`), so NaN/Infinity/negative pass | RED: quota.test "falls back to the default…" |
