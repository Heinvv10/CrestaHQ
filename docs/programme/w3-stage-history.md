# W3 · Deal stage history

*Part of the [CRM gap programme](README.md) (Sales intelligence: "Stage history + time-in-stage").*

**Goal:** each deal stage move writes one history row, so the Reports page can show real
time-in-stage, stage-to-stage conversion and velocity for a date range. Until now a deal
held only `stageChangedAt`, the time it entered its current stage. Each move overwrote it.

| PR | Scope | State |
|---|---|---|
| PR1 | History row written in the same commit as every stage-changing write, tested through each entry point | this PR |
| PR2 | Reports: median time-in-stage, conversion, velocity on the Reports page (inline SVG). One number reconciled against a raw Firestore count | after PR1 merges |
| — | Backfill from `stageChangedAt`: dry-run script only, labelled as an estimate. A production write needs Hein | after PR2 |

## The row

`dealStageHistory/{autoId}`: top-level collection, append-only, written only through the Admin SDK
([`src/lib/server/deal-stage-history.ts`](../../src/lib/server/deal-stage-history.ts)).

| Field | Meaning |
|---|---|
| `agencyId`, `subAccountId`, `createdByUid` | Tenancy keys. `createdByUid` is whoever made the move: a uid, `apikey:<prefix>`, the workflow owner, or the operator who ran the import |
| `mode` | `live` / `test`. Test-mode API keys write test rows |
| `source` | `app` · `api` · `workflow` · `ai` · `quote` · `form` · `import` |
| `dealId`, `pipelineId`, `stageId` | The stage the deal just entered |
| `fromPipelineId`, `fromStageId` | The stage it left. `null` on the row written when the deal is created |
| `fromStageEnteredAt` | The deal's previous `stageChangedAt`: when it entered the stage it just left |
| `enteredAt` | Server timestamp from the same commit as the deal's new `stageChangedAt` |

## Writers (all covered)

| Entry point | Code | Commit |
|---|---|---|
| Dashboard create / Kanban drag / edit dialog | `createDealServerSide` / `updateDealServerSide` via `/api/deals` | batch / transaction |
| AI Suite `create_deal`, `move_deal_stage` | same service | batch / transaction |
| Workflow `move_stage` | same service (`engine.ts` `moveContactDeal`) | transaction |
| Quote accepted, with a linked deal | same service (`terminal: "won"`) | transaction |
| Quote accepted, deal auto-created | `autoCreateDealForAcceptedQuote` | batch |
| Public API v1 `POST` / `PATCH /deals` (and the QContact stage sync, which calls it) | v1 routes | batch / transaction |
| Public form submit with "create a deal" | `/api/forms/[id]/submit` | batch |
| Bulk import (GHL + generic chunk) | `writeImportChunk` | the import's own batch |

Client SDK writes to `deals` are denied by the rules, so no writer is missing from this table.
Each writer has a test that goes red when its row is removed. The tests are listed in the PR body.

## Decisions

Each decision was made without an interactive grill. The rejected alternative is listed with it.

1. **Top-level collection, not `deals/{id}/stageHistory`.** Reports ask "all moves in
   sub-account X between dates A and B". A top-level collection answers that with one
   composite index on `subAccountId + enteredAt`. *Rejected:* a subcollection. It needs
   collection-group queries, indexes and rules, and when a deal is deleted its subcollection
   is left orphaned where nothing lists it.
2. **Creation writes a row with `fromStageId: null`.** Without it, time in a deal's first
   stage would need a join back to `deal.createdAt`, and deleted deals would lose it.
   *Rejected:* rows for moves only.
3. **What counts as a move:** any change of `stageId` or `pipelineId`. Reopening from Lost is
   a move, and so is moving to another pipeline. A write that leaves the stage unchanged
   (an edit, or a PATCH that repeats the current stage) writes no row. *Rejected:* rows for
   every write that touches `stageId`, which would add noise from the edit dialog echoing
   the stage.
4. **Written in the same commit.** Updates read the deal *inside* a transaction, so
   `fromStageId` is the stage the deal actually left, even when two moves race. The
   concurrency test goes red if the read is moved outside the transaction. Creates use a
   batch. *Rejected:* a best-effort write after the deal write, which can silently skip a
   row. That failure is exactly what the reports cannot detect.
5. **`fromStageEnteredAt` is stored on the row.** One row gives the time spent in the stage
   the deal left, so a date-range query does not need earlier rows the range cuts off.
   *Rejected:* working it out by ordering all rows of a deal.
6. **No PII on the row** (no title, value or contact). Deleting a deal leaves its rows in
   place. PR2 decides whether reports count moves of deleted deals. *Rejected:* cascading
   deletes into four deletion paths (deal delete, v1 delete, contact cascade, demo unseed)
   for data that identifies nobody. Consequence: after its deals are deleted, a sub-account
   can still hold rows (see Open items).
7. **`source` is required** on both service functions, so a new caller has to name itself.
   Reports can then leave out `import` rows (import time is not when the stage was entered)
   and `test` mode.
8. **Import now stamps `stageChangedAt` when a re-import changes the stage.** Before this it
   changed `stageId` and left the old `stageChangedAt`, so the deal's current time-in-stage
   was wrong. A re-import at the same stage writes no row and leaves `stageChangedAt` as it
   was.
9. **The dev-only demo seed is not covered.** Seeded deals behave like pre-feature deals
   (no rows). The backfill and PR2 handle deals that have no creation row.

## Rules and indexes

None in PR1. Rows are written only by the Admin SDK, and the default-deny catch-all in
`firestore.rules` already blocks client reads and writes. PR2 adds the read path, plus any
composite index it needs (`subAccountId` + `enteredAt`), and decides whether reads happen on
the server or through a territory-aware rule. **Nothing to deploy for PR1.**

## Open items for PR2 / backfill

- Deals that existed before this ships have no rows. The backfill estimates one entry row per
  deal from `stageChangedAt` and marks it (`source: "backfill"`, estimate).
- `deleteSubAccountForAgency` does not yet clear `dealStageHistory`. The rows hold no PII,
  but PR2 should add the collection to the clean-up.
- The v1 PATCH still validates `stage` against the pipeline from its pre-transaction read. A
  pipeline change between that read and the commit is not re-checked. This is unchanged
  from before.
