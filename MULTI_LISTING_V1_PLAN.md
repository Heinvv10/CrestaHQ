# Multiple Google Business Profile listings per sub-account — v1

> Status: **PLAN (rev 1, 2026-09-27)** — nothing built. Owner rulings locked by Hein on 2026-09-27 (below, final). Format follows [AUTO_REPLY_V1_PLAN.md](AUTO_REPLY_V1_PLAN.md). First customer: Blitz Fibre #1001. Velocity #1002's live single-listing auto-reply must keep working byte-for-byte through every PR — every PR here is additive and green on its own.

## Goal

A sub-account can manage more than one Google Business Profile listing from its one Google connection. The Reviews tab shows all of them (combined by default, filterable per listing, each row labelled); Reply / Draft with AI / Discard work on any review and go to that review's own listing; review requests can target a listing; auto-reply can be switched on per listing, with settings and daily caps shared. Insights, widgets, the public feed, the Overview and sentiment stay on the main listing in v1.

## Owner rulings (Hein, 2026-09-27 — final)

1. **Build it.** One Google connection, several listings. Blitz #1001: main = `locations/16687126082355686779` (Pretoria); second = `locations/17056136057407481399` ("Blitz Fibre", Gqeberha); both under `accounts/115813935832651833776` on the existing grant (verified).
2. **Reviews tab** gets a listing dropdown: "All listings" (default, combined) + each listing by title. Every row shows its listing label.
3. **Reply, Draft with AI, Discard** and every per-review action work for a review from any connected listing and go to that review's own listing.
4. **Auto-reply:** settings shared per sub-account; on/off per listing. Caps (20 posts / 40 drafts per SAST day) stay per sub-account.
5. **Review requests** can pick the listing (default = main).
6. **Insights, widgets, public feed, Overview, sentiment** stay on the MAIN listing in v1.
7. **Sequencing:** auto-reply on any non-main listing ships in the LAST PR, only after the safety fixes are in and mutation-tested.

## What exists (verified 2026-09-27 against `origin/main` @ `6d35cfa7`)

- **One listing per sub-account, everywhere.** `SubAccountDoc.googleListing: GoogleListing | null` (`src/types/tenancy.ts:590`, shape in `src/types/google.ts:51-74`). Written only by `PUT /google/listing` (`src/app/api/sub-accounts/[id]/google/listing/route.ts:85-126`), cleared by `clearListing` (`src/lib/gbp/listing-events.ts:26-77`) and the reconnect re-verify (`listing-events.ts:87-108`, called from `src/app/api/google/callback/route.ts:152-164`).
- **Cache and sync state, one per sub-account.** `subAccounts/{id}/gbpReviews/{sha256(review.name)[:40]}` docs carry `locationName` (`src/lib/gbp/sync/types.ts:113-146`); one `private/gbpSyncState` (lease + pass cursor + `anomalyStreak` + `retentionPurgedAt` + `lastManualAt`, `sync/types.ts:99-110, 161`); one member-readable `gbpSummary` (`types.ts:83-96`). `syncListing` (`src/lib/gbp/sync/run.ts:222-236`) loads the whole cache (`run.ts:96` → `loadCache(sa)`, `sync/store.ts:60-77`) and `planReconcile` counts a miss for every active cached review the pass did not see (`sync/reconcile.ts:36-62`, applied at `run.ts:139-144`). `clearGbpCache(subAccountId)` takes a `clearing` lease, deletes every review doc, nulls `gbpSummary`, deletes the state doc (`sync/store.ts:220-231`); callers: listing PUT (`listing/route.ts:128`), `clearListing` (`listing-events.ts:75`), Google gate off (`src/lib/server/feature-gates-service.ts:147`).
- **The lease pins the listing.** `acquireLease` refuses `listing_changed` unless `sub.googleListing.locationName === expect.locationName` (`sync/lease.ts:66-71`). `recordFailedRun` only advances the summary if the listing is still the same (`sync/record.ts:26-41`).
- **Reply / draft / dismiss** all go through `loadReplyTarget`, which refuses unless `review.locationName === sub.googleListing.locationName` (`src/lib/gbp/reply.ts:41-49`). The Google call itself uses `target.reviewName` (the full resource name — account + location + review), so a review already addresses its own listing (`reply.ts:117`). `draftInputFor` uses `sub.googleListing.title` as the business name (`src/lib/reputation/draft.ts:105`).
- **`listing_shared` refusal is an equality query in three places:** `src/app/api/sub-accounts/[id]/reputation/auto-reply/route.ts:121`, `src/lib/reputation/auto-reply/confirm.ts:56`, `src/app/api/sub-accounts/[id]/gbp/reviews/route.ts:52` — all `where("googleListing.locationName", "==", X)`.
- **Auto-reply is enabled "for a listing":** `reviewsAutoReply.listingLocationName` stamped on off→on (`src/lib/reputation/auto-reply/settings.ts:101-113`); checked in `run.ts:89-91`, `confirm.ts:64-67`, `decide.ts:108` (`other_listing`), and the reviews route's `autoPostsFor` (`gbp/reviews/route.ts:44-56`). Any listing change or clear sets `reviewsAutoReply.enabled: false` + `disabledReason: "listing_changed"` (`listing/route.ts:93-98`, `listing-events.ts:50-55`) and sends one alert.
- **Markers are already location-scoped.** `stableReviewKey` = sha256 of `locations/{loc}/reviews/{id}` (`src/lib/gbp/auto-reply-never.ts:23-26`), so `autoReplyNever/{key}`, `autoReplyDismissed/{key}` and the `edited-{key}` alert ids are unique across listings and live outside the review cache. `pendingReply` and `heldAlertBasis` live on the review doc (`auto-reply/store.ts:14-16, 219-228`).
- **Main-only readers already filter by `googleListing.locationName`:** `loadServedReviews` (`sync/served.ts:18-35`, used by the reviews route, Overview `reputation/overview/route.ts:55-62`, sentiment `reputation/sentiment.ts:198-208`, agent capability `ai-suite/capabilities/reputation.ts:31-32`); the public feed (`gbp/feed/build.ts:82-93`); insights (`reputation/insights/route.ts:43-52`, already accepts `?location=` for admins); sentiment's `beginCall` (`sentiment-calls.ts:82`). This is why extra listings can share the collection: everything ruling 6 keeps on main is invisible to extra docs by construction.
- **Review requests** use exactly one URL: `googleReviewConfig.reviewUrl`, adopted from `googleListing.newReviewUri` by a compare-and-set (`src/lib/reviews/canonical-url.ts`, `google-review/adopt-listing-url/route.ts`), sent by `maybeSendReviewRequest` (`src/lib/reviews/request.ts:96-101`; "a listing's proposed link is never sent"); the manual surfaces are `POST /api/comms/review-request/send` (contact profile + Reputation → Requests "Send Review Request", `components/reputation/send-review-request.tsx`). Reminders and the `/rr/{token}` click redirect resolve the configured URL (`lib/reviews/click.ts:31-36`).
- **Fake provider** already serves two locations (`LOC_A`, `LOC_B = locations/e2e-velo-gqeberha-north`, `src/lib/gbp/provider/fake-scenario.ts:147-186`) with reviews only on A; the picker route walks all of them (`google/locations/route.ts`). The E2E copy (`e2e/lib/gbp.ts:47-75`) serves only `LOC_A`. Unit harness: `src/test/memory-firestore.ts` models `array-contains` (line 14, 109); `src/test/google-oauth-harness.ts:115` models `==` only.
- **Docs to update:** `docs/features/gbp-reviews.md` ("Firestore model" §, "Data written", "UI"), `docs/features/reputation.md` ("Review auto-reply" §, "Requests"), `docs/architecture/firestore-collections.md` (rows for `subAccounts/{id}` fields, `gbpReviews`, `private/gbpSyncState`).

## Data model (no migration of live data)

All new fields are **additive**; `googleListing` keeps its exact meaning (the MAIN listing). A sub-account with no extras is byte-identical to today, so Velocity #1002 never changes shape.

| Path / field | New? | Content |
|---|---|---|
| `subAccounts/{id}.googleListing` | no | The MAIN listing, unchanged. Invariant (new): **a sub-account with extras always has a main** (see route rules). |
| `subAccounts/{id}.googleExtraListings: GoogleListing[]` | yes | The non-main listings, same shape, server-written from the provider re-fetch (never from the request), ordered as selected, at most `MAX_EXTRA_LISTINGS = 9`. Member-readable display data like `googleListing`. |
| `subAccounts/{id}.googleLocationNames: string[]` | yes | Flat denormalised `[main.locationName, ...extras.map(locationName)]`, rewritten by EVERY writer of either listing field (listing PUT/DELETE, `clearListing`, callback re-verify, the extra-listings route). Exists only on docs written after PR 1; absence is handled (below). |
| `subAccounts/{id}.gbpSummaries: Record<locId, GbpSummary>` | yes | Per-EXTRA-listing summaries (`locId` = `locationName` after `locations/`, chars `[A-Za-z0-9_-]` per `LOCATION_NAME_RE`, so it is a safe map key). Main stays in `gbpSummary`. |
| `subAccounts/{id}/private/gbpSyncState` | no | Main listing's lease/pass/anomaly/retention + the sub-account-wide `lastManualAt`. Unchanged. |
| `subAccounts/{id}/private/gbpSyncState_{locId}` | yes | The same shape per EXTRA listing (its own lease, pass, anomalyStreak, retentionPurgedAt). Path from `syncStatePath(sa, locationName)` — main → the legacy path. |
| `subAccounts/{id}/gbpReviews/{docId}` | no | Shared collection; `locationName` already on every doc is the scope key. |
| `subAccounts/{id}/gbpSyncRuns/{runId}` | no | One record per listing per run (`locationName` already on it). |
| `subAccounts/{id}/gbpEvents` | no | New `type`s: `extra_listing_added`, `extra_listing_removed {reason}`. |
| `subAccounts/{id}.reviewsAutoReply.extraListings: Record<locId, {enabledAt, enabledByUid}>` | yes (PR 6) | Extra listings auto-reply is ON for; a missing key = off. `enabled` / `enabledAt` / `listingLocationName` keep their meaning: the MAIN listing's switch and stamps. |
| `subAccounts/{id}.googleReviewConfig.listingUrls: Record<locId, string>` | yes (PR 5) | Per-EXTRA-listing configured review URL, adopted by the same compare-and-set as today. `reviewUrl` stays the main/default. |
| `subAccounts/{id}/reviewRequests/{id}.locationName` | yes (PR 5) | Which listing a request was sent for (`null`/absent = main). |
| `firestore.indexes.json` | yes (PR 2) | `gbpReviews` COLLECTION: `locationName ASC, createTime DESC` — for the per-listing served query. **This is the only index this plan adds.** The `array-contains` query on `googleLocationNames` alone uses Firestore's automatic single-field index and needs no entry. |
| `firestore.rules` | no | The new sub-account fields are display data on an already member-readable doc, like `googleListing`; every new subcollection path is under `private/*` (default deny). No rules change; `pnpm test:rules` unchanged. |

**Why one collection + a `locationName` filter rather than per-listing collections:** every main-only reader already filters by `locationName` (see "What exists"), markers are already keyed by location, and the main listing's cache stays exactly where it is — no doc moves, no dual-read code. The cost is one composite index so the 500-record cap is per listing, not shared.

**Helper (PR 1):** `src/lib/gbp/listings.ts` (pure, ≤60 lines): `MAX_EXTRA_LISTINGS`, `locId(locationName)`, `allListings(sub)` = `[main, ...extras]` (derived from `googleListing` + `googleExtraListings`, NOT from the flat array — legacy docs have no array), `locationNamesOf(sub)`, `listingFor(sub, locationName)`, `isMain(sub, locationName)`.

## Per-hazard resolution

### H1 — `listing_shared` refusal fails OPEN with a list
Sites: `reputation/auto-reply/route.ts:121`, `auto-reply/confirm.ts:56`, `gbp/reviews/route.ts:52`.

Resolution (PR 1): one helper `src/lib/gbp/shared-location.ts` — `heldByAnotherSubAccount(db, tx | null, locationName, exceptId): Promise<boolean>` that runs **both** queries and unions them: `where("googleListing.locationName","==",loc)` (catches every legacy doc, no backfill needed) **and** `where("googleLocationNames","array-contains",loc)` (catches extras). All three sites call it; the equality query can be retired in v2 once the backfill has run. Per-listing semantics: `confirm.ts` asks about the REVIEW's `locationName` (not the sub-account's main); the settings route asks per listing being switched on; the reviews route's `autoPostsFor(star, locationName)` asks per review.

Tests that go red when broken (both harnesses on `memory-firestore`, which models `array-contains`):
- `shared-location.mutation.test.ts`: OTHER_SA holds `LOC_A` **only as an extra** (`googleExtraListings` + `googleLocationNames`, `googleListing` = `LOC_NORTH`) → `PUT …/reputation/auto-reply {enabled:true}` on SA is 409 `listing_shared`; delete the `array-contains` branch → green→red.
- Same file: OTHER_SA is a **legacy doc** (`googleListing.locationName = LOC_A`, no `googleLocationNames`) → still 409; delete the equality branch → red.
- Engine: extra-holder appears mid-run → `confirmAutoPost` returns `paused` (extends `run.midrun.test.ts`).

Index: none (single-field automatic). Optional backfill script (PR 1, its own step, additive, idempotent, dry-run default — modelled on `scripts/backfill-event-is-long.ts`): `scripts/backfill-google-location-names.ts` writes `googleLocationNames` only where absent and a listing exists; never touches other fields; re-run plans zero writes.

### H2 — sync assumes one listing (one cache/state/cursor/anomaly/retention/summary; cross-listing tombstoning)
Resolution (PR 2), all keyed by `(sa, locationName)`:
- `syncStatePath(sa, locationName)` (`sync/types.ts:161`): main → `private/gbpSyncState` (legacy, unchanged), extra → `private/gbpSyncState_{locId}`. Each listing has its **own lease**, so `acquireLease` / `commitGuarded` / `releaseLease` (`sync/lease.ts`) and the page commit in `sync/pass.ts:262-263` are unchanged except for the path they receive. `claimManualSlot` stays on the main doc (Sync now is sub-account-wide, one cooldown).
- `loadCache(sa, locationName)` (`store.ts:60`) returns only that listing's docs (in-memory filter on `locationName`; the read is the same full-collection read as today). `planReconcile` and `planRetention` (`reconcile.ts`) are unchanged — they now receive a per-listing cache. **A listing-A pass can no longer tombstone listing B.**
- Summary per listing: `summaryFor(sub, loc)` / summary write op (`gbpSummary` for main, `gbpSummaries.{locId}` for an extra); `stampIfAbsent` likewise; `retentionBasis` uses that listing's summary + that listing's `retentionPurgedAt`.
- `acquireLease`'s expectation (`lease.ts:67`): "`expect.locationName` is still in `locationNamesOf(sub)` (derived, not the flat array)" instead of `=== main`. `recordFailedRun` (`record.ts:33`) the same membership check and the per-listing summary.
- New `syncSubAccount(sa, opts): Promise<{ runs: SyncRunRecord[]; synced: SyncedRun }>` in `src/lib/gbp/sync/sub-account.ts` loops `allListings(sub)` sequentially, calling the existing per-listing core (`syncListing(sa, opts, listing)`, `run.ts` reduced to the core to stay ≤300 lines). `synced` aggregates `created + updated` and the earliest `startedAt` — one `SyncedRun` per sub-account, so auto-reply and sentiment still run once per tenant (`after-sync.ts`). Callers: Sync now route (answers `{run: publicRun(main), runs: [...]}`), `sweep.ts` (`onRun` gets the aggregate; per-listing statuses tallied), `retainListing` (loops the same way; discovery by `gbpSummary.lastRunAt` unchanged because extras imply a main).
- Served reads: `loadServedReviews(sa, locationNames: string[], now)` runs one `where("locationName","==",loc).orderBy("createTime","desc").limit(501)` per listing (the new composite index) and merges newest-first; `truncated` is per listing OR'd. Main-only callers pass `[main]`.

Tests that go red when broken:
- `sync/two-listing.test.ts` (gbp-sync-harness, two listings seeded, reviews on both): after two complete single-run passes of A, every B doc is `state: "active", missedPasses: 0`; replace `loadCache(sa, loc)` with `loadCache(sa)` → red. A's retention purge leaves B's docs and summary; B's lease does not refuse A (`already_running` only per listing).
- `sync/served.test.ts`: 501 reviews on A + 3 on B → B's 3 all served, `truncated` true for A only; drop the per-listing query → red.

Deploy: `firebase deploy --only firestore:rules,firestore:indexes` **before** PR 2 merges; wait for the index to read READY in the console; the served query otherwise fails `FAILED_PRECONDITION` at runtime.

### H3 — `clearGbpCache` wipes everything; a listing change switches auto-reply off sub-account-wide
Resolution (PR 2 for the cache, PR 3/6 for the switch):
- `clearGbpCache(sa, locationName)` (moved to `src/lib/gbp/sync/clear.ts`): takes the `clearing` lease on THAT listing's state doc, deletes only docs `where("locationName","==",loc)` (single-field), nulls that listing's summary (`gbpSummary` or `gbpSummaries.{locId}` via `FieldValue.delete()`), deletes that listing's state doc. `clearAllGbpCaches(sa)` = loop over `allListings(sub)` **plus** a final sweep of any doc whose `locationName` is not in the current set (an orphan from a removed listing that failed mid-clear) — used by the Google gate off (`feature-gates-service.ts:147`) and disconnect. Markers (`autoReplyNever`, `autoReplyDismissed`, `reviewAutoReplyAlerts`) are untouched, as today.
- Listing PUT (main change, `listing/route.ts:128`): `clearGbpCache(id, previousMain)`; `reviewsAutoReply.enabled: false` + `disabledReason` as today (main's switch only); `extraListings` untouched. Refuses 409 `already_extra` if the new main is one of the extras (remove it as an extra first — default chosen over auto-swap).
- Listing DELETE (main) with extras present → 409 `has_extra_listings` (default chosen: keeps the "extras imply a main" invariant simple; disconnect still clears everything).
- Extra removal (`PUT /google/extra-listings`, PR 3): per removed listing — `clearGbpCache(id, loc)`, gbpEvent `extra_listing_removed`, and (PR 6) `FieldValue.delete()` of `reviewsAutoReply.extraListings.{locId}` + one `listing_changed` alert only if that key existed. Main's cache, drafts, `heldAlertBasis`, settings: untouched.

Tests that go red when broken:
- `sync/clear.test.ts`: A and B synced, B has a fresh `pendingReply` and `heldAlertBasis`, A too; remove B → A's docs (with `pendingReply`, `heldAlertBasis`), A's summary, A's state doc, and all `autoReplyNever`/`autoReplyDismissed` docs still present; B's docs and `gbpSyncState_{B}` gone; make the clear whole-collection → red.
- `extra-listings.route.test.ts` (PR 3): removing B leaves `reviewsAutoReply` byte-equal; (PR 6) removing B with B on deletes only its key, main stays `enabled: true`, exactly one `listing_changed` alert doc.

### H4 — `reply.ts` and the engine check a single listing
Resolution (PR 4 for reply/draft/dismiss; PR 6 for the engine): `loadReplyTarget` (`reply.ts:46-47`) → `review.locationName ∈ locationNamesOf(sub)` — no weaker: an unknown, cleared or foreign location is still a 404; the Google call still uses the review's own `reviewName`. `draftInputFor` (`draft.ts:105`) uses `listingFor(sub, review.locationName)?.title`. Engine (`run.ts:89-91`, `confirm.ts:64-67`, `decide.ts:108`, `reviews/route.ts:50`): `DecideSettings` gets `listings: Record<locationName, { enabledAtMs }>` (built by `readAutoReplyListings(raw)` in `settings.ts`: main from `enabled`/`enabledAt`/`listingLocationName`, extras from `extraListings`); `other_listing` = not in the map; `before_enabled` uses THAT listing's `enabledAt`; the engine runs when the map is non-empty; `confirm` re-derives the map inside the transaction and refuses `paused` if the review's listing is missing from it or is shared.

Tests that go red when broken: `reply/route.multi.test.ts` — a review on the extra listing is replied to via the real route → the fake's `calls` log carries B's review name, the cached doc under B has the reply; a review whose `locationName` is not connected → 404 (mutate the membership to "any active doc" → red). `run.multi.test.ts` (PR 6) — B on, main off: B's rating-only 5★ posts, main's `fake-a1` does not (mutate the map to `[main]` → red; mutate to "any listing" → red).

### H5 — markers stay correct
`stableReviewKey` already strips only `accounts/{a}/` and keeps `locations/{loc}/reviews/{id}` (`auto-reply-never.ts:23-26`), so the same review id on two listings cannot collide, and per-listing clears never touch marker collections (H3). Test (PR 2, `clear.test.ts`): B replied → marker written; remove B, re-add B, sync → `hadReply` re-derived from the marker, decide skips `never`.

## PR DAG

| PR | Scope | Depends on | Merge gate |
|---|---|---|---|
| 1 | Types + `listings.ts` helper; dual-query `shared-location.ts` replacing the three equality sites; `googleLocationNames` written by every listing writer; backfill script (dry-run) | — | green CI + blind review (Level 3: additive, no customer-facing change) |
| 2 | Sync scoped per listing (`syncStatePath(sa, loc)`, `loadCache`, `clearGbpCache`/`clearAllGbpCaches`, `gbpSummaries`, `syncSubAccount`, per-listing served query + index) | 1 | index deployed READY **before** merge; green CI + blind review + **breaker** (sync is live for #1000/#1001/#1002) |
| 3 | `PUT /google/extra-listings` route + multi-select on the Google Business page; main PUT/DELETE rules; callback re-verify per listing | 2 | green CI + blind review |
| 4 | Reviews tab: `?listing=` filter, dropdown, row label, per-listing summary; reply/draft/dismiss across listings; draft business name per listing | 2 (3 for E2E) | green CI + blind review |
| 5 | Review requests: per-extra-listing URL adoption, listing pick on the manual send, request log `locationName` | 3 | green CI + blind review + **Hein approves** (outbound customer messages) |
| 6 | Auto-reply per listing: `extraListings`, PUT `listings`, card rows, engine map, removal hook, alert | 1–4 (5 not required) | green CI + blind review + **adversarial breaker** + **Hein approves the merge** (posts publicly) |

Each PR is independently mergeable: with no extras stored, every PR's runtime behaviour for a single-listing sub-account is unchanged, and each PR's tests assert that explicitly (a "single listing: unchanged" case in every new test file).

### PR 1 — foundations (no behaviour change)
- **Files:** `src/types/tenancy.ts` (`googleExtraListings?`, `googleLocationNames?`, `gbpSummaries?` — types only), new `src/lib/gbp/listings.ts`, new `src/lib/gbp/shared-location.ts`, edits: `reputation/auto-reply/route.ts:119-125`, `auto-reply/confirm.ts:53-57, 67`, `gbp/reviews/route.ts:44-56`, `google/listing/route.ts` (write `googleLocationNames` on PUT, `[]` on DELETE), `listing-events.ts:56-59` (`googleLocationNames: []` alongside `googleListing: null`), new `scripts/backfill-google-location-names.ts` (+ `.test.ts` for `plan()` like `backfill-event-is-long.test.ts`), `docs/architecture/firestore-collections.md` row.
- **Tests:** `shared-location.mutation.test.ts` (H1, both branches), existing `auto-reply/route.test.ts` + `confirm.test.ts` + `reviews/route.approval.test.ts` still green; listing route tests assert `googleLocationNames` after PUT/DELETE (extend `src/test/google-oauth-harness.ts:115` to model `array-contains` — 5 lines — or move the new assertions to the sync harness).
- **Verify:** `pnpm ci:check`; then on prod after deploy, run the backfill dry-run, read the count (expect 3: #1000, #1001, #1002), then `--apply`, then re-run → 0 planned.
- **Rules/index:** none.

### PR 2 — sync per listing
- **Files:** `sync/types.ts` (`syncStatePath(sa, loc)`, `locId`), `sync/store.ts` (`loadCache(sa, loc)`; move `clearGbpCache` out), new `sync/clear.ts`, `sync/lease.ts:66-71` (membership), `sync/record.ts:26-41`, `sync/run.ts` (per-listing core; summary read/write via `summaryFor`/`summaryOp`), new `sync/sub-account.ts` (`syncSubAccount`, `retainSubAccount`), `sync/sweep.ts:478-495` (call the aggregate), `sync/served.ts` (per-listing queries), `sync/public.ts` (`publicRun.locationName`), `gbp/sync/route.ts:55-58`, `cron/gbp-sync/route.ts`, `feature-gates-service.ts:147` (`clearAllGbpCaches`), `listing/route.ts:128` + `listing-events.ts:75` (`clearGbpCache(id, previous)`), callers of `loadServedReviews` pass `[main]`; `firestore.indexes.json`; `docs/features/gbp-reviews.md` Firestore model §.
- **Tests:** `sync/two-listing.test.ts` (H2 mutation), `sync/clear.test.ts` (H3 + H5 mutations), `sync/served.test.ts`, extend `sync/run.test.ts` / `sweep.test.ts` / `gbp/sync/route.test.ts` for the `runs` array and the single aggregate `onRun`; `fix-round2.test.ts` (`clearGbpCache` lease) re-pointed at `(SA, LOC_A)`; existing sync tests must stay green unmodified except for the signature.
- **Verify:** `pnpm ci:check`; after deploy: Sync now on #1002 → one run, cache and summary unchanged in shape.
- **Rules/index:** `firebase deploy --only firestore:rules,firestore:indexes` first (index `gbpReviews: locationName ASC, createTime DESC`); merge only when READY.

### PR 3 — connect extra listings
- **Files:** new `src/app/api/sub-accounts/[id]/google/extra-listings/route.ts` (`PUT {listings: [{accountName, locationName}]}`, admin, `gbpPreconditions`, body ≤ `MAX_EXTRA_LISTINGS`, one `discoverLocations` walk then match every pair — 400 `unknown_location` / `unverifiable_truncated` / `is_main` / `too_many`; transaction writes `googleExtraListings`, `googleLocationNames`, a gbpEvent per add/remove; after the transaction `clearGbpCache(id, loc)` per removed) + new `src/lib/gbp/extra-listings.ts` (diff + transaction, ≤150 lines); `listing/route.ts` (`already_extra`, `has_extra_listings`); `listing-events.ts` (`reverifyListingsAfterReconnect`: main missing → clear all with reason `not_accessible_after_reconnect`; else remove each missing extra); `google/callback/route.ts:152-164`; `google/route.ts` DELETE (disconnect clears all); UI: `components/gbp/listing-picker.tsx` gains `mode: "single" | "multi"` (checkboxes, main excluded, "Save additional listings"), `google-business-panel.tsx` "Additional listings" block under the main summary (page is already `max-w-3xl`); `docs/features/gbp-reviews.md` UI + Routes §§.
- **Tests:** `extra-listings/route.test.ts` through the real route (auth 403s, gate, body limits, unknown/truncated refusals, add two, remove one → only its cache cleared, events, `googleLocationNames` exact, a legacy doc without the array works); callback test: extra not visible after reconnect is removed, main kept; `listing/route.test.ts` new refusals; `listing-picker.test.ts` multi mode.
- **E2E:** extend `e2e/lib/gbp.ts` with `twoListingScenario()` (`LOC_B` + 2 reviews on B), `seedConnectedListing({extras})`, and `clearGbp()` deleting `googleExtraListings`, `googleLocationNames`, `gbpSummaries` and every `private/gbpSyncState_*` doc; new `gbp-extra-listings.spec.ts`: tick the second listing, save, Sync now, assert docs exist for both `locationName`s and two `gbpSyncRuns` were created.
- **Verify:** `pnpm ci:check`; E2E job green.
- **Rules/index:** none.

### PR 4 — Reviews tab across listings
- **Files:** `lib/gbp/inbox-filters.ts` (`listing` param: `LOCATION_NAME_RE` + membership → else 400 `invalid_filter field:"listing"`), `gbp/reviews/route.ts` (served over `locationNamesOf(sub)` or the one filtered; `summary` = selected listing's, main's for "All"; `listings: [{locationName, title, main}]`; `autoPostsFor(star, locationName)`), `sync/public.ts` (`PublicReview.listing: {locationName, title}`; `reviewName` stays hidden), `reply.ts:41-49`, `draft.ts:105`, UI: `review-filters.tsx` (dropdown, `?listing=`), `review-item.tsx` (label chip when the response has >1 listing), `reviews-section.tsx` (passes `listings`), `recent-syncs.tsx` (listing title per run); docs.
- **Tests:** `reviews/route.listing.test.ts` (default = both listings newest-first with labels; `?listing=B` → only B; unknown → 400; a member sees the same; `needsApproval` counts both), `reply/route.multi.test.ts` (H4 mutation), `draft/route.test.ts` (business name = B's title for a B review), `dismiss/route.test.ts` (B review dismissible), `review-filters.test.ts`, `reviews-section.test.ts` (dropdown hidden with one listing).
- **E2E:** extend `gbp-reply.spec.ts`: select the second listing in the dropdown, reply to its review, assert `replyCalls()` last entry names `${ACCOUNT}/${LOC_B}/reviews/…` and the row shows the reply; "All listings" shows both labels.
- **Verify:** `pnpm ci:check`; E2E green.
- **Rules/index:** none.

### PR 5 — review requests per listing
- **Files:** `types/tenancy.ts` (`GoogleReviewConfig.listingUrls?`), `lib/reviews/canonical-url.ts` (`resolveReviewUrl(sub, locationName?)`), `google-review/adopt-listing-url/route.ts` (optional `locationName`; same compare-and-set on the per-key value), `components/gbp/review-url-card.tsx` (one card per listing), `lib/reviews/request.ts` (`SendReviewInput.locationName?`: extra → its configured URL or `listing_url_not_configured`; channel must be `sms` or `whatsapp_manual` else `listing_needs_template`; no reminders/tracking for an extra-listing send in v1; `logReviewRequest` gets `locationName`), `lib/reviews/request-log.ts`, `app/api/comms/review-request/send/route.ts` (optional body `locationName`, validated), `components/reputation/send-review-request.tsx` (listing select, shown only with extras, default main), `reputation/requests/route.ts` + `components/reputation/requests.tsx` (listing title per row); docs `reputation.md` Requests §.
- **Tests:** `request.listing.test.ts` (extra listing send → body contains B's URL, log row `locationName: B`; mutate the lookup to the main URL → red; unconfigured extra → refused, nothing sent; template channel → refused), `adopt-listing-url/route.test.ts` per-key CAS, `send/route.test.ts` body validation, `canonical-url.test.ts`.
- **E2E:** extend `gbp-review-request.spec.ts`: adopt B's link, send with B selected, assert the outbound body contains B's URL.
- **Verify:** `pnpm ci:check`; E2E green; Hein reviews the send-path diff.
- **Rules/index:** none.

### PR 6 — auto-reply per listing (LAST)
- **Files:** `types/tenancy.ts` (`ReviewsAutoReplySettings.extraListings?`), `auto-reply/settings.ts` (`parseAutoReplyBody` accepts optional `listings: Record<locationName, boolean>`; `readAutoReplyListings(raw)`; per-listing `enabledAt`/`enabledByUid` on each off→on), `reputation/auto-reply/route.ts` (per-listing `listing_shared`, `no_listing` only when nothing is on; GET returns `listings`), `auto-reply/decide.ts` (`DecideSettings.listings` map), `auto-reply/run.ts:87-100`, `confirm.ts:64-67, 81`, `gbp/reviews/route.ts` `autoPostsFor`, `lib/gbp/extra-listings.ts` (removal deletes the key + one alert), `listing/route.ts` + `listing-events.ts` (main change/clear leaves `extraListings` alone; disconnect clears all keys), `components/reputation/auto-reply-card.tsx` (a row per listing with its own switch; caps note "shared across listings"), `AUTO_REPLY_V1_PLAN.md`, `reputation.md` auto-reply §.
- **Tests (mutation set):** `run.multi.test.ts` — (a) B on, main off → B's rating-only 5★ posted once to B's review name, main's not (map→`[main]` red; map→"any" red); (b) both on → both post, one shared cap (21st held `cap`); (c) B switched on later with backlog off → B's older review `before_enabled` (mutate to main's `enabledAt` → red); (d) OTHER_SA adds B as an extra mid-run → `confirm` `paused` for B's review, main's still posts; (e) remove B while on → key gone, one `listing_changed` alert, main posts next run; (f) change main while B on → main `enabled:false`, B still posts; (g) legacy doc → identical to `run.test.ts` today (run unmodified). Plus `settings.test.ts`, `decide.test.ts`, `route.test.ts`, `auto-reply-card.test.ts`.
- **E2E:** extend `gbp-auto-reply.spec.ts`: switch on B only → Sync now → B's rating-only 5★ auto-replied, main's untouched; the row's label reads the second listing's title.
- **Verify:** `pnpm ci:check`; breaker session on the merged branch (H1/H3/H4 mutation files go red under their stated mutations — record the output in the PR); Hein approves.
- **Rules/index:** none.

## Rollout order for Blitz (#1001)

Prod deploys are `bash scripts/deploy-velo.sh` on velo-server outside business hours, with Hein's approval per deploy.

1. **PR 1 deployed** → backfill dry-run, then `--apply` (expect 3 docs). Nothing visible changes.
2. **Index deployed, READY; PR 2 deployed** → Reputation → Reviews on #1001 → **Sync now**; the run shows as before.
3. **PR 3 deployed** → Google Business page on #1001 → "Additional listings" → tick **Blitz Fibre (Gqeberha)** → **Save additional listings** → Reviews → **Sync now**. Expect two runs in Recent syncs.
4. **PR 4 deployed** → Reviews tab dropdown shows "All listings / Blitz Fibre (Pty) Ltd / Blitz Fibre"; first live reply to a Gqeberha review (Hein approves the text).
5. **PR 5 deployed** → Gqeberha's review-link card → **Use it**; one review request to a contact Hein picks.
6. **PR 6 deployed, breaker evidence attached** → Reputation → Settings → Auto-reply → Gqeberha row → **on** (backlog off).

Velocity #1002 is never touched by any step; its doc gains only `googleLocationNames` (step 1).

## Defaults chosen (not open questions)

- DELETE of the main listing while extras exist → 409 `has_extra_listings`; disconnect clears everything.
- Reconnect that can no longer see the main listing → all listings cleared (audited per listing); a missing extra is removed alone.
- Sync now cooldown is per sub-account; it syncs every listing.
- Extra-listing review requests: SMS / WhatsApp manual only, no reminders or click tracking in v1.
- At most 9 extra listings (10 total).
- The equality `listing_shared` query is kept beside the `array-contains` one until v2; no migration gates any PR.
