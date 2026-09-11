# Google Business Profile reviews & reputation

Owned replacement for GHL's Google Business Profile (GBP) dependency: a
sub-account admin connects the Google account that manages the business's
Business Profile, picks the listing, and (in later PRs) syncs, reads and replies
to genuine Google reviews and publishes a feed for an external website.

Delivered as four stacked PRs. **This document reflects PR 2**
(`feat/gbp-2-sync`, on top of PR 1 `feat/gbp-1-provider`): PR 1's provider
boundary, token lifecycle, hardened OAuth state, listing discovery + selection,
picker UI and fenced fake provider, plus PR 2's review sync — Firestore model,
sync core, Sync now, the signed 6-hourly cron, reconciliation, retention and
the synced-reviews view. Rows marked for PRs 3–4 are not built yet.

**Four states, kept apart:** fixtures-tested ✅ · real-Google-tested ❌ ·
deployed ❌ · Velocity-connected ❌. Live Google access waits on the v4 API
approval (case `4-6894000042302`); until then the GCP project has quota 0 and
everything is proven against the deterministic fake provider.

## Capability matrix (as of PR 2)

`proven` = implemented and proven by the named test. Evidence paths are
relative to `src/` unless they start with `e2e/`.

| # | Capability | State | Evidence / where it lands |
|---|---|---|---|
| 1 | Google OAuth configuration | proven | `lib/google/oauth.ts`; `lib/google/oauth.test.ts` (scope, offline+consent, exact redirect URI, configured/unconfigured); fake counts as configured — `app/api/google/callback/provider.test.ts` |
| 2 | Agency gate (`googleEnabledByAgency`) | proven | `lib/google/gate.ts`, `lib/gbp/route-support.ts`; gate_off in `…/google/route.test.ts`, `callback/route.test.ts`, `…/google/locations/route.test.ts`, `…/google/listing/route.test.ts`; disconnect + listing DELETE stay ungated (same files) |
| 3 | Sub-account admin authorization | proven | `requireSubAccountAdmin` on connect, callback, disconnect, locations, listing; non-member / collaborator / other-sub admin refused in the route tests above |
| 4 | Secret storage | proven | tokens only at `subAccounts/{id}/private/googleConnection`; substring checks in `callback/route.test.ts`, `callback/provider.test.ts`; admin-SDK scan in `e2e/specs/gbp-connect-select.spec.ts` |
| 5 | Access-token refresh | proven | `lib/gbp/tokens.ts`; `lib/gbp/tokens.test.ts` (60s margin, single-flight, rotation — also when another writer won — other-writer adoption, revoked → reconnect-required only if the failed grant is still stored, scope check). `lib/gbp/access.ts` `withGbpAccess`: a 401 on a data call expires the cached token, refreshes once, retries once — `…/locations/route.test.ts` › detects a grant revoked while the cached access token is still FRESH. The sync uses it for every page (`lib/gbp/sync/pass.ts`; `sync/run-failures.test.ts` › revoked with a still-FRESH cached token → `reconnect_required`) |
| 6 | Account discovery | proven (fixtures) | `lib/gbp/provider/google.ts` `listAccounts`; `provider/google.test.ts` (URL, paging); `…/locations/route.test.ts`; E2E 1. Real Google: blocked on approval |
| 7 | GBP location discovery | proven (fixtures) | `listLocations` (readMask required); `provider/google.test.ts`; `lib/gbp/discovery.ts`; `…/locations/route.test.ts` (all pages, 20-page bound); E2E 1 |
| 8 | Listing selection / mapping | proven (fixtures) | `…/google/listing/route.ts` (server re-fetch, unknown_location); `…/listing/route.test.ts`; E2E 1 selects the second of two similar listings |
| 9 | Manual sync | proven (fixtures) | `POST …/gbp/sync` → `lib/gbp/sync/run.ts` `syncListing`; `…/gbp/sync/route.test.ts` (admin only, collaborator / non-member / other-sub admin 403, gate_off 403, other agency refused writing nothing); E2E 3 clicks Sync now |
| 10 | Scheduled sync | proven (fixtures) | `POST /api/cron/gbp-sync` (QStash-signed) → `lib/gbp/sync/sweep.ts`; `app/api/cron/gbp-sync/route.test.ts` (unsigned / forged / wrong-body 401, 500 when the sweep cannot start, manual and cron write identical docs), `sync/sweep.test.ts`; E2E 2. The production schedule is an owner step — see the checklist below |
| 11 | Pagination | proven (fixtures) | provider + discovery paging (`provider/google.test.ts`, `provider/fake.test.ts` 3/3/1, `…/locations/route.test.ts`); review sync pages, persists the cursor per page, resumes a <24h pass and restarts a stale cursor once (`sync/run-failures.test.ts` › resume); E2E 2 (3 pages) |
| 12 | Review storage | proven (fixtures) | `subAccounts/{id}/gbpReviews/{sha256(review.name)[:40]}`, byte-exact comment (`sync/run.test.ts` › first full sync; E2E 2 asserts the translated block in Firestore and on the page) |
| 13 | Summary rating / count | proven (fixtures) | `subAccounts/{id}.gbpSummary` from the provider page on success, null when absent — never invented (`sync/run.test.ts`, `…/gbp/reviews/route.test.ts`, E2E 2) |
| 14 | Owner reply read | proven (fixtures) | parsed (`provider/google.test.ts`), stored and hashed so a changed reply updates the doc (`sync/run.test.ts` › changed owner reply), shown under the review (`components/gbp/reviews-section.test.ts`, E2E 2 / 3) |
| 15 | Owner reply create/update | partial | `putReply` / `deleteReply` in the provider (`provider/google.test.ts`, `provider/fake.test.ts`); route + UI PR 4 |
| 16 | Edit / deletion reconciliation | proven (fixtures) | content hash → update in place; full-pass tombstoning with the anomaly guard (`lib/gbp/sync/reconcile.ts`; `sync/run.test.ts` › idempotency and reconciliation, anomaly guard); E2E 3 |
| 17 | Idempotency | partial | sync: deterministic doc id + content hash + one lease per sub-account (`sync/run.test.ts` › repeated sync creates and updates nothing; `sync/run-failures.test.ts` › overlapping runs; E2E 2 rerun `created:0`). Reply idempotency PR 4 |
| 18 | Sync run / audit history | proven (fixtures) | `subAccounts/{id}/gbpEvents`: `listing_selected` and `listing_cleared` (reasons `admin_cleared`, `disconnected`, `not_accessible_after_reconnect`) — `…/listing/route.test.ts`, `…/google/route.test.ts`, `callback/provider.test.ts`, E2E 1; append-only `subAccounts/{id}/gbpSyncRuns` — one per run, created at its end, kinds and counts only (`sync/run.test.ts`, `…/gbp/reviews/route.test.ts` last 10; E2E 2 / 3 / 6) |
| 19 | Reviews inbox UI | partial | read-only list, newest first, byte-exact with replies (`components/gbp/reviews-section.test.ts`, E2E 2); filters + reply composer PR 4 |
| 20 | Sync health UI | proven (fixtures) | connection health only: reconnect guidance with its reason on the page (`components/gbp/google-business-panel.test.ts`; E2E 1 flags reconnect, sees `gbp-state-reconnect`, reconnects) and on the Settings card (`components/settings/sub-account-google-section.test.ts`); not-configured state (`google-business-panel.test.ts`). Sync health (PR 2): `gbp-health-<health>` badge, stale / partial (outage-guard wording for `skipped_anomaly`) / reconnect / sync-pending / error banners, "Last synced …" plus the truthful schedule line, recent syncs, health re-derived per request from the live connection (`lib/gbp/sync/health.test.ts`, `components/gbp/reviews-section.test.ts`, `…/gbp/reviews/route.test.ts`; E2E 6 shows the reconnect banner over cached reviews) |
| 21 | Public feed API | absent | PR 3 |
| 22 | Widget configuration | absent | PR 3 |
| 23 | CORS / domain controls | absent | PR 3 |
| 24 | No-JS / degraded website fallback | absent | PR 3 |
| 25 | Review-request compatibility | partial | untouched by PR 1 — `lib/reviews/*.test.ts`, `app/api/sub-accounts/[id]/google-review/route.test.ts` stay green; the listing stores `newReviewUri` for the URL-reconciliation seam in PR 4 |
| 26 | Documentation / environment / runbook | partial | this file, `docs/environment.md`, `docs/architecture/firestore-collections.md`; deploy checks `scripts/gbp-deploy-check.mjs` (`scripts/gbp-deploy-check.test.ts`); sync model, algorithm, retention and the schedule command below; RUNBOOK sync-health section; full rollout in PR 4 |

## Provider boundary

`src/lib/gbp/provider/` is server-only. `types.ts` defines `GbpProvider`:

- OAuth: `authorizeUrl`, `exchangeCode`, `refresh`, `revoke` (returns `GoogleTokens`).
- Data: `listAccounts`, `listLocations`, `listReviews` (`{reviews, averageRating,
  totalReviewCount, nextPageToken}`), `putReply`, `deleteReply`.

`google.ts` is the real implementation (`google-http.ts` maps responses,
`google-parse.ts` maps payloads, `google-token.ts` is the OAuth token endpoint).
Endpoints, verified 2026-09-11:

| Call | Endpoint |
|---|---|
| accounts | `GET mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20` |
| locations | `GET mybusinessbusinessinformation.googleapis.com/v1/{accounts/a}/locations?readMask=name,title,storefrontAddress,websiteUri,metadata&pageSize=100` |
| reviews | `GET mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews?pageSize=50&orderBy=updateTime%20desc` |
| reply | `PUT` / `DELETE mybusiness.googleapis.com/v4/{review.name}/reply` |

Every failure is a `GbpProviderError` whose `kind` is one of `auth_expired`
(401), `revoked` (OAuth `invalid_grant`), `insufficient_scope` (403
`ACCESS_TOKEN_SCOPE_INSUFFICIENT` / "insufficient authentication scopes", or
OAuth `invalid_scope`), `permission_denied` (other 403), `not_found` (404),
`rate_limited` (429, `retryAfterMs` from `Retry-After`), `transient` (5xx,
network, body read failure) or `malformed` (non-JSON, wrong shape, other 4xx).
The message is fixed per kind + status — never a response body, URL query or
token. Payloads fail closed: `STAR_RATING_UNSPECIFIED`, a missing id or a
wrong type is `malformed`. Review `comment` is kept byte-exact, including
Google's "(Translated by Google) … (Original) …" block.

## Identifier model

| Identifier | Shape | Source | Role |
|---|---|---|---|
| GBP account | `accounts/{a}` | Account Management API | resource key |
| GBP location | `locations/{l}` | Business Information API | resource key (`googleListing.locationName`) |
| v4 review parent | `accounts/{a}/locations/{l}` | composed from the two above | reviews / reply path |
| Place ID | `ChIJ…` | `metadata.placeId` | display + link only — **not** a GBP key |
| Maps URI / new-review URI | URLs | `metadata.mapsUri` / `newReviewUri` | display + link only |

## Selecting the provider — the fake guard

`getGbpProviderFor(subAccountId)` in `provider/select.ts` is the only way to
obtain a provider; connect, callback exchange, token refresh, discovery,
selection and disconnect revoke all go through it. It reads server env only.
The fake is used only when **all** hold:

1. `GBP_PROVIDER === "fake"`;
2. `NEXT_PUBLIC_APP_URL`'s host is `127.0.0.1`, `localhost` or `[::1]`;
3. `NODE_ENV !== "production"`, or `GBP_FAKE_ALLOW_PROD_BUILD === "1"`;
4. `GBP_FAKE_AGENCY_ID` is set **and** the sub-account's `agencyId` equals it.

Any clause failing with `GBP_PROVIDER=fake` throws `GbpFakeRefusedError` — it
never falls back to Google. Clause 3's opt-in exists because CI's Playwright job
boots the production bundle on 127.0.0.1; production bakes
`https://crm.crestahq.com` into `NEXT_PUBLIC_APP_URL` at build time and carries
no opt-in, so it fails two clauses. Clause 4 exists because local dev and CI run
against the **production** Firestore: an unfenced fake callback for a real
tenant would overwrite its real `private/googleConnection`. Each clause is unit
tested and mutation-proven (`provider/select.test.ts`), and the callback,
connect, disconnect and token paths each have a "other agency → refused,
nothing written" test.

The fake (`provider/fake.ts`) reads its scenario from
`subAccounts/{id}/private/gbpFakeScenario` (locked; default-deny rules) or, when
absent, a built-in scenario: one account "E2E Fixture Group" with two similarly
named locations ("Velo Test Fibre — Gqeberha" / "… Gqeberha North") and seven
reviews on the first (a 1-star, unreplied ones, a translated one), paged in
threes. Scenario knobs: `revoked`, `rotateRefreshToken`, `failNext: {op, kind}`.
Tokens encode the sub-account (`fake-refresh:{sa}:{n}`); "Connect" returns
straight to the callback with `code=fake-code:{sa}`. Each fake instance is
**bound** to the one sub-account the fence admitted: a code or token naming any
other sub-account is refused (`revoked` / `auth_expired`) and the scenario
store is read and written only for the bound id — so a valid fixture state
plus `code=fake-code:<real tenant>` cannot point anything at a real tenant
(`provider/fake.test.ts`, `callback/provider.test.ts`). A requested-but-refused
fake makes `googleAppConfigured()` false, so routes answer `not_configured`
rather than 500.

### Deviation from v2 §5, and how the fake is kept out of production

v2 §5 says the fake must refuse `NODE_ENV=production`. It does — unless
`GBP_FAKE_ALLOW_PROD_BUILD=1`, because the blocking CI Playwright job boots the
production bundle and the fake is the only way that gate can exercise the
Google flow. This is a documented deviation that needs Hein's sign-off. It is
held by three things, none of which parses env files:

1. **App fence** (`provider/select.ts`, `provider/mode.ts`): loopback app URL +
   prod-build opt-in + fixture-agency fence, each clause mutation-proven. The
   loopback clause is the NARROW allow-list `isAppLoopbackUrl`
   (`provider/loopback.mjs`): the hostname, after WHATWG normalisation, must be
   exactly `127.0.0.1`, `localhost` or `[::1]`. Next **inlines**
   `NEXT_PUBLIC_APP_URL` into that check at build time — in the server bundle it
   is a string literal (`…isAppLoopbackUrl)("https://crm.example.test"))throw…`),
   so the comparison is against the build-time value. What is proven, on one
   throwaway build with that URL and dummy Google credentials: with
   `GBP_PROVIDER=fake`, the opt-in, the fixture agency AND a loopback
   `NEXT_PUBLIC_APP_URL` in the running server's env, the signed-in app
   answered `/google/status` → `{"configured":false}`; the same build with
   `GBP_PROVIDER=google` answered `{"configured":true}` (positive control). Note
   `next build` copies `.env.local` into `.next/standalone/`, which the
   standalone server loads at runtime — another source the inlined literal
   also overrode.
2. **Pre-build deploy check** (`scripts/gbp-deploy-check.mjs pre`, run by
   `deploy-velo.sh` before install): refuses if the raw text of any `.env*` file
   in the deploy dir mentions `GBP_PROVIDER` or `GBP_FAKE_` anywhere — any line,
   commented or not; production never needs these names (the default is
   Google) — or if any deploy-shell variable is named `GBP_PROVIDER*` /
   `GBP_FAKE_*`. No parsing, no expansion, so no dotenv spelling can slip past
   it. It also refuses when `NEXT_PUBLIC_APP_URL` is DEFINED more than once in
   `.env.production` or defined in any other env file (`.env.example`, which
   Next never loads, is exempt; comment lines never count, and a lone CR, U+2028
   or U+2029 breaks a line as in dotenv), so the deploy script's `sed` and Next cannot read
   different values.
   Unreadable files fail closed. `GBP_SYNC_SCHEDULE_ENABLED` is allowed.
3. **Post-build deploy check** (`scripts/gbp-deploy-check.mjs post`, in
   `deploy-velo.sh`'s "Verifying NEXT_PUBLIC_APP_URL was inlined" step): the
   app URL must parse and must not be on the WIDE loopback block-list
   (`isLoopbackHostname`: `localhost`/`*.localhost`, `127.0.0.0/8` in any IPv4
   spelling, `[::1]` in any spelling, `::ffff:127.x`, `0.0.0.0`, `[::]`); then,
   in every server chunk carrying the fake-provider check, the string literal
   passed to that check is extracted, decoded, and must EQUAL the app URL
   exactly. A substring match was not enough: a second `.env.production` line
   `https://crm.crestahq.com@127.0.0.1:4300` (userinfo, loopback host) is what
   Next inlines, and it contains the first line `sed` reads — reproduced on a
   real build (old check exit 0, new check exit 1). A check whose literal cannot
   be read, or no check at all, refuses. This is the authoritative check — it
   asserts the value the running app compares.

Both deploy checks are covered by `scripts/gbp-deploy-check.test.ts` (every
bypass from five review rounds as fixtures), each branch mutation-proven;
`loopback.test.ts` asserts every host the app allows is on the wide block-list.

**Not covered:** systemd `Environment=` / `EnvironmentFile=` lines on the
`crestahq` unit are read by neither deploy check. They cannot change the
inlined URL, so the app fence plus the post-build check still hold.

### Owner-approval checklist (PR 1)

- [ ] **Before the first deploy after this merges**, run this on velo-server
  (as `velo`, so every `.env*` the pre-check scans is listed and read with the
  deploy's own permissions). Each step branches on grep's exit code, so an
  unreadable file prints `CHECK FAILED` instead of passing as clean (block below).
  Expected: `1: clean …`, `2: ok — one definition`, `3: done` with nothing
  between. A comment naming `NEXT_PUBLIC_APP_URL` (the production file has one
  copied from `.env.example`) is fine; a comment naming `GBP_PROVIDER` is not.
  This block is a convenience for the owner; the deploy's pre-check is the
  authority (grep splits lines only on LF, so a definition hidden behind a lone
  CR can read `ok` here and still be refused by the deploy — the safe direction).

```bash
sudo -u velo bash -s <<'CHECK'
D=/home/velo/crestahq   # the deploy dir the pre-check scans (every .env* in it)
DEF='^[[:space:]]*(export[[:space:]]+)?NEXT_PUBLIC_APP_URL[[:space:]]*[=:]'

# 1. No GBP_PROVIDER / GBP_FAKE_ text in ANY .env* file — comments count, the pre-check refuses them too.
grep -nE 'GBP_PROVIDER|GBP_FAKE_' "$D"/.env*
case $? in 0) echo "1: REMOVE these lines before deploying";; 1) echo "1: clean — no GBP_PROVIDER / GBP_FAKE_ text";; *) echo "1: CHECK FAILED — could not read";; esac

# 2. Exactly one NEXT_PUBLIC_APP_URL DEFINITION in .env.production (comment lines don't count).
n=$(grep -cE "$DEF" "$D/.env.production"); rc=$?
case $rc in 0|1) if [ "$n" = 1 ]; then echo "2: ok — one definition"; else echo "2: FIX — $n definitions, exactly one required"; fi;; *) echo "2: CHECK FAILED — could not read $D/.env.production";; esac

# 3. No NEXT_PUBLIC_APP_URL definition in any other .env* file (.env.example is exempt).
for f in "$D"/.env*; do
  [ -d "$f" ] && continue   # the pre-check skips directories too
  case "${f##*/}" in .env.production|.env.example) continue;; esac
  grep -qE "$DEF" "$f"
  case $? in 0) echo "3: REMOVE the NEXT_PUBLIC_APP_URL definition from $f";; 1) ;; *) echo "3: CHECK FAILED — could not read $f";; esac
done
echo "3: done"
CHECK
```

- [ ] Sign off the v2 §5 deviation above (fake allowed in the production BUILD
  for CI only, held by the app fence and both deploy checks).

## OAuth state and token lifecycle

**State** = `base64url(JSON {s, u, t, n, r?}) + "." + hex HMAC-SHA256("googlestate:" + payload)`
keyed by `AUTOMATIONS_TOKEN_SECRET` (`s` sub-account, `u` initiating uid, `t`
issued-at ms, `n` nonce, `r:"gbp"` return page). The callback refuses a bad
HMAC, a state older than 10 minutes or more than 60 s in the future, and a
caller whose uid is not `u` (`?google=bad_state`, nothing stored). With the
secret unset or empty, signing throws (connect reports `not_configured`) and
verification returns null. `?return=gbp` is the only return value honoured.

**Tokens** (`lib/gbp/tokens.ts`): `getValidAccessToken(subAccountId)` returns
the cached token while it has more than 60 s left, otherwise refreshes —
single-flight per sub-account in-process — and writes back in a transaction
that adopts another writer's still-valid token and never overwrites a refresh
token rotated underneath it. A rotated refresh token is persisted. It also lands a rotated refresh token when another writer won the race
but the secret still holds the token we used. `revoked` (`invalid_grant`) or a
missing `business.manage` scope sets `googleConnectionMeta.reconnectRequired` +
`reconnectReason` — **only if the secret still holds the failed grant**
(otherwise a newer grant exists and is used instead, refreshed at most once;
if that fails too, the error is `transient`, not `revoked`, since nothing was
flagged) —
and keeps the secret so disconnect can still revoke.

**Data calls** go through `withGbpAccess(subAccountId, fn)` (`lib/gbp/access.ts`).
A 401 on a token we believed valid — what a grant revoked at Google looks like
while our cached token still has most of its hour — expires the cached token
(only if still stored), forces one refresh and retries once; the refresh then
works or hits `invalid_grant` → reconnect-required. A data-call
`insufficient_scope` is flagged the same conditional way. A successful reconnect clears the flag
(written explicitly — the doc write is a deep merge). The callback refuses a
grant without `business.manage` (`?google=insufficient_scope`).

## Routes

| Route | Who | Notes |
|---|---|---|
| `GET /api/sub-accounts/[id]/google/connect[?return=gbp]` | admin, gated | redirects to Google (or the fake callback) |
| `GET /api/google/callback` | admin, gated | state + uid check, exchange, token split; on reconnect re-verifies an existing listing with the new token — cleared (audited `not_accessible_after_reconnect`, and only if the stored listing is still the one checked) when provably not visible; kept if the check fails or the 20-page walk was truncated before finding it |
| `GET /api/sub-accounts/[id]/google/status` | any member | `{configured}` — deployment-level boolean only |
| `DELETE /api/sub-accounts/[id]/google` | admin, **ungated** | best-effort revoke, skipped when a requested fake is refused (nothing to revoke with) — on a dev machine (loopback app URL) the fixture-agency fence still applies first; clears meta **and** `googleListing` (audited `disconnected`) |
| `GET /api/sub-accounts/[id]/google/locations` | admin, gated | `{accounts:[{name, accountName, locations:[{name,title,address,websiteUri,placeId,mapsUri}]}], truncated}` — every page, bounded at 20 |
| `PUT /api/sub-accounts/[id]/google/listing` | admin, gated | `{accountName, locationName}`; server re-fetch, else 400 `unknown_location` (provably not visible) or `unverifiable_truncated` (past the 20-page bound — unproven, still refused) |
| `DELETE /api/sub-accounts/[id]/google/listing` | admin, **ungated** | clears `googleListing` (audited `admin_cleared`) |
| `POST /api/sub-accounts/[id]/gbp/sync` | admin, gated, 1/min (409 `too_soon`) | "Sync now": runs `syncListing` inline (`trigger:"manual"`); `{run:{trigger,status,startedAt,finishedAt,pagesFetched,reviewsSeen,created,updated,unchanged,removed,purged,reconciliation,resumedFromCursor,errorKind,skipReason}}` — a skip or failure is a 200 result |
| `GET /api/sub-accounts/[id]/gbp/reviews` | any member, gated | `{summary, reviews, runs, scheduled, truncated}` — active reviews of the current listing seen within 30 days, newest first (cap 500 records), summary with health derived now from the live connection, last 10 runs; never `passId`, `contentHash`, `reviewName` or anything under `private/` |
| `POST /api/cron/gbp-retention` | QStash signature bound to this URL | the always-on daily retention housekeeping: a retention-only pass (no provider calls) for every sub-account holding a cache; `{retained}`; 500 only when the sweep cannot start |
| `POST /api/cron/gbp-sync` | QStash signature bound to this URL | the 6-hourly sweep; `{processed, byStatus, retained, stoppedOnRateLimit}`; 401 unsigned/invalid; 500 only when the sweep cannot start |

Refusals are `{error, code}`: 403 `gate_off`, 503 `not_configured`, 409
`not_connected` / `reconnect_required`, 400 `invalid_body` / `unknown_location` /
`unverifiable_truncated`,
502 `<provider kind>`. No response carries a token (every route test scans the
body for token markers).

## Data written

- `subAccounts/{id}.googleListing` — `{accountName, accountDisplayName,
  locationName, title, address, websiteUri, placeId, mapsUri, newReviewUri,
  selectedAt, selectedByUid}`, member-readable display data, written only by
  the server from its own re-fetch.
- `subAccounts/{id}.googleConnectionMeta.reconnectRequired` / `reconnectReason`.
- `subAccounts/{id}/gbpEvents/{auto}` — `{type:"listing_selected", agencyId,
  subAccountId, createdByUid, at, locationName, previousLocationName}` or
  `{type:"listing_cleared", reason, …, locationName:null, previousLocationName}`,
  each written in the same transaction as the change it records. No client
  rule (default deny).

Selecting a **different** listing, clearing it, disconnecting, and a reconnect
re-verification that drops it all also delete the synced review cache, the
summary and the sync state (`clearGbpCache`, `lib/gbp/sync/store.ts`, reached
through `clearListing` and the listing PUT). A re-verification that declines
because a newer listing was picked meanwhile leaves that listing's cache alone.

No Firestore rules or indexes change in PR 1 or PR 2.

## Review sync (PR 2)

### Firestore model

No client rules and no composite indexes: every read is an API route on the
Admin SDK, and the new subcollections fall under default deny.

| Path | Written by | Content |
|---|---|---|
| `subAccounts/{id}/gbpReviews/{docId}` | sync only | `docId = sha256(review.name).hex[:40]` (deterministic → idempotent). `agencyId, subAccountId, createdByUid` (= `googleListing.selectedByUid`), `locationName, reviewName, reviewId, reviewer, starRating, comment` (byte-exact or null), `createTime, updateTime, reply, state` (`active`/`removed`), `firstSeenAt, lastSeenAt, removedAt, passId, contentHash` (sha256 of rating, comment, updateTime, reply), `missedPasses` (consecutive complete single-run passes it was missing from) |
| `subAccounts/{id}/gbpSyncRuns/{runId}` | sync only, `create()` once at the end of a run — never updated | `agencyId, subAccountId, createdByUid, trigger, actorUid, startedAt, finishedAt, locationName, status, pagesFetched, reviewsSeen, created, updated, unchanged, removed, purged, reconciliation, resumedFromCursor, errorKind, skipReason`. No provider body, token or review text |
| `subAccounts/{id}/private/gbpSyncState` | sync only (locked) | `lease {runId, until}`, `pass {passId, pageToken, pagesDone, startedAt, averageRating, totalReviewCount}`, `retentionPurgedAt`, `anomalyStreak {removals, count, lastAt}`, `lastManualAt` (Sync-now cooldown) |
| `subAccounts/{id}.gbpSummary` | sync only (member-readable) | `locationName, averageRating, totalReviewCount, lastSuccessfulSyncAt, lastRunAt, lastRunStatus, lastErrorKind, lastReconciliation, health` — kinds only |

The review collection only ever holds the **current** listing (see "Data
written"), which is why a query on `createTime` alone serves the page.

### Algorithm — `syncListing(subAccountId, {trigger, actorUid?, now?, maxPages?})`

One core, `lib/gbp/sync/run.ts`; Sync now and the cron differ only in `trigger`
(`…/cron/gbp-sync/route.test.ts` proves both write identical review docs).

1. **Fence first.** `getGbpProviderFor` — in fake mode a sub-account outside
   the fixture agency throws before anything is read or written.
2. **Classify.** Gate off, not connected, no listing → `skipped` with that
   `skipReason`, provider never called (a retention-only pass still runs if
   the sub-account holds a cache — see Retention). A connection already
   flagged reconnect-required → `skipped reconnect_required` (retention runs).
3. **Lease** in a transaction on `private/gbpSyncState`, TTL 5 min, that ALSO
   re-reads the sub-account: if the listing, the connection, the reconnect
   flag or the gate no longer match what step 2 read → `skipped
   listing_changed`, nothing written; a live lease → `skipped
   already_running` (a cache clear holds a `clearing` lease while it deletes;
   its first write also drops the pass cursor and anomaly streak).
   The run continues from the summary read INSIDE that transaction. Every later write of the run — each page, tombstones,
   the summary — is a transaction that re-checks the lease is still this
   run's (`commitGuarded`), so a run whose cache was cleared under it stops
   with `failed lease_lost`; each page commit renews the lease. Released in
   `finally`, only if still ours.
4. **Retention** (below), on every run that holds the lease.
5. **Pass.** Resume the stored pass from its cursor if it is < 7 days old,
   else a new pass from page 1. Up to `maxPages` (20 × 50 = 1000 reviews) per
   run. Every page call goes through `withGbpAccess` (401 → one refresh → one
   retry; `invalid_grant` flags reconnect) inside a retry for `transient` /
   `rate_limited`: 3 attempts, 1s then 2s, or Google's `Retry-After` when
   longer — but a `Retry-After` over 10s is not retried: the run stops with
   its cursor kept and the sweep starts no further tenant (the quota is
   project-wide). Each page is upserted with its cursor in the same
   transaction: new → full doc (`created`); hash changed → content fields
   (`updated`); same → only `lastSeenAt`/`passId` (`unchanged`). The pass
   keeps the first non-null `averageRating` / `totalReviewCount` Google
   reported in it (a later page's null never overwrites them). A resumed
   cursor Google rejects (`not_found` / `malformed` on the first resumed
   page) restarts the pass from page 1 once, same pass id.
6. **Outcome.** All pages → reconcile (below). `maxPages` hit → `partial`,
   cursor kept, `reconciliation:"deferred"`. A page failing after retries →
   `partial` if a page landed this run, else `failed`. `revoked` /
   `insufficient_scope` → `reconnect_required`. A non-provider failure →
   `failed internal`, and the summary still records it. Cached data is never
   deleted because a run failed.
7. **Summary** (rating/count/`lastSuccessfulSyncAt` only on success, from the
   pass) and finally the append-only run record.

### Reconciliation — the per-review two-miss rule

Removal is decided **per review**, never from a whole pass's say-so (three
pass-level heuristics were broken in review: a count rule twice, then a
deletion mid-run shifting Google's offset pages so a single-run pass skipped
a live review — `sync/two-miss.test.ts` › the deletion-shift race).

- Every cached review carries `missedPasses` (0 whenever it is seen).
- A **complete pass that started and finished in ONE run** adds one miss to
  every active review it did not see. A **resumed** pass counts nothing
  (`deferred`).
- A review is **tombstoned only at its second consecutive miss** (`state:
  "removed"`, `removedAt`; `comment`, `reviewer`, `reply`, `starRating`,
  `contentHash` set to null; ids kept). One bad pass can hide a live review
  for one pass; it cannot remove it. A review that comes back is restored as
  an `update`.
- **So a review removed at Google disappears after two complete passes —
  about 12 hours with the 6-hourly schedule** (or two Sync-now presses a
  minute apart).
- **Residual risk (documented, accepted):** a LIVE review can still be
  tombstoned if it goes unseen in two consecutive complete single-run passes
  for two independent reasons — e.g. a deletion shifts Google's pages past it
  in one pass and another shift does the same in the next. That needs two
  separate mid-pass events aligned on the same review; the review is restored
  (as an `update`) the next time a pass sees it.
- **Big listings:** a listing that cannot finish a pass in one run (more than
  `maxPages × 50` = 1000 reviews) never counts misses. A review removed at
  Google stays cached — and served — until it has not been re-seen for 30
  days, when the retention rule deletes it (and the read stops serving it).
- **Anomaly brake on top:** planned tombstones from a pass that saw nothing
  (whatever `totalReviewCount` says), or more than half of ≥10 active
  reviews, look like an outage → nothing removed, `reconciliation:
  "skipped_anomaly"`, status `partial` (misses still count). The same
  planned count on the **third** such pass is applied (`full_after_anomaly`)
  — but a confirmation counts only if it is at least **an hour** after the
  previous one, so pressing Sync now three times confirms nothing. A
  different count restarts the streak. Mass removal therefore needs two
  misses AND the streak.

### Retention — Google's 30-day rule

The GBP content policy (https://developers.google.com/my-business/content/policies)
says content "…stored temporarily for no more than 30 calendar days…". So:

- a review not re-seen for 30 days (or with no `lastSeenAt`) is **deleted**,
  not tombstoned;
- if nothing has succeeded for 30 days — counted from the later of
  `lastSuccessfulSyncAt` and the last full purge (`retentionPurgedAt`) — the
  run deletes **all** cached review content and the summary's rating/count
  **once**, records `retentionPurgedAt`, and the summary reads
  `health:"error"`, `lastErrorKind:"retention_expired"`. The purge restarts
  the clock, so later runs resume the new pass and a listing too big for one
  run can finish it.
- **Always-on housekeeping:** a daily `leadstack-gbp-retention` schedule
  (registered unconditionally, like api-cleanup) runs a retention-only pass
  — Firestore only, never the provider — for EVERY sub-account holding a
  cache, sync-eligible or not. `GBP_SYNC_SCHEDULE_ENABLED` controls only the
  Google sync; with it off, the sync cron (if a schedule is left) does the
  same retention pass and syncs nobody. So no configuration can leave review
  content stored past 30 days. A cache is found by `gbpSummary.lastRunAt`,
  which the lease transaction stamps (`lastRunStatus: "running"`, health
  `never_synced`, no rating) before a first run's first page can land — a
  run that dies mid-way cannot orphan reviews. Housekeeping leaves a run
  record only when it removed something or failed (shown as "Retention" in
  Recent syncs).
- **Switching the agency gate off** deletes the cache at once, on every
  path that can do it — the Manage dialog (`PATCH …/feature-gates`) and the
  Workspace Assistant's `set_feature_gate` both go through
  `applyFeatureGates`, which calls `clearGbpCache` — as do clearing/changing
  the listing and disconnecting. If that clear fails, the gate change still
  succeeds (logged by kind); the daily retention pass is the backstop and
  re-saving the gate retries the clear safely. Any other cache that can no longer sync gets a
  retention-only pass from the sweep — no provider call, under the lease;
  its reviews go under the 30-day rules, and once it holds none (after an
  expiry purge, or never successful) its summary is deleted too and it
  leaves the sweep.
- **Every summary writer** (a run, an internal-failure record, the sweep's
  failure record) drops rating/count once the last success is older than 30
  days — nothing re-stores them.
- **At read time** the reviews route never serves a review not re-seen for 30
  days, and serves no rating/count once the last success is older than 30
  days — whether or not a run has purged them (`withinRetention`, the same
  predicate PR 3's feed must use).

Rules: `lib/gbp/sync/reconcile.ts` (`planRetention`, `retentionBasis`,
`withinRetention`); `sync/retention.test.ts`, `sync/sweep.test.ts`,
`…/gbp/reviews/route.retention.test.ts`.

### Cadence and freshness

With the schedule on, the cron runs **every 6 hours**; nothing is real-time.
The page states only what is true: "Syncs automatically every 6 hours" when
the deployment has `GBP_SYNC_SCHEDULE_ENABLED=1`, otherwise "Automatic sync is
not scheduled on this deployment — use Sync now" (`scheduled` in the reviews
response). With the flag off the cron route answers `{skipped:
"not_scheduled", …}` and syncs nobody, so a schedule left in QStash cannot
make that sentence false — but it still runs the sweep's retention-only half
(no provider calls). Health is derived **at read time** by `deriveHealth(summary, now,
liveConnection)` (`lib/gbp/sync/health.ts`): `reconnect_required` whenever the
connection is flagged; `sync_pending` when the last run needed a reconnect and
the connection has since been reconnected; `ok` after a recent success;
`stale` once the last success is older than 12h (two missed runs) or the last
run failed within 30 days of it; `partial`; `error` (no success in 30 days,
retention expired, or failing with no success at all); `never_synced`.

Sync now is limited to one per minute per sub-account (409 `too_soon`).

### Sweep, capacity and schedule

`POST /api/cron/gbp-sync` (QStash-signed, like `recurring-invoices`; in
`PUBLIC_PATHS`; the signature must have been minted for
`${NEXT_PUBLIC_APP_URL}/api/cron/gbp-sync`, so another route's signed call
cannot be replayed here) → `lib/gbp/sync/sweep.ts`:

- **Sync:** `where googleEnabledByAgency == true`, filtered to connected +
  listing, never-run first then oldest `gbpSummary.lastRunAt`, **at most 25
  per call, 3 at a time**; the first `rate_limited` result stops new tenants.
- **Retention only:** `where gbpSummary.lastRunAt != null` (single-field
  inequality — no composite index) filtered to sub-accounts that cannot sync.
- Fake mode: ONE query `where agencyId == GBP_FAKE_AGENCY_ID` feeds both.
- Each sub-account is isolated: a throw becomes that tenant's `failed` run and
  advances its `lastRunAt`. 500 only when the sweep cannot start, so QStash
  retries.

**Capacity:** 25 tenants per invocation × 4 invocations a day = 100 tenant
syncs a day. Beyond ~25 connected listings each is synced less often than every
6 hours (and reads `stale` after 12h), until the cap is raised or the sweep
continues itself.

**Owner checklist** (not run): the next production deploy registers
`leadstack-gbp-retention` — daily at 04:30 UTC, Firestore-only, no Google
calls, unconditionally (Google's 30-day storage limit) — verify it in the
QStash schedules list after the deploy. Then, for the Google sync: set
`GBP_SYNC_SCHEDULE_ENABLED=1` in the
production env, then an approved after-hours deploy (`bash
scripts/deploy-velo.sh`) — the next cold start registers `leadstack-gbp-sync`
(`0 */6 * * *`) with the other schedules. **This is a policy prerequisite**
before any gate-on tenant keeps synced reviews: without the schedule, content
older than 30 days is hidden at read time but only *deleted* on that
tenant's next Sync now. Turning the flag off later does not delete the QStash
schedule (the cron no-ops instead); delete it in the QStash console to stop
the calls. The destination is
`${NEXT_PUBLIC_APP_URL}/api/cron/gbp-sync`, which is also the URL the
signature is checked against. Alternative, by hand:

```bash
# Upstash REST: POST /v2/schedules/{destination}, headers Upstash-Cron +
# Upstash-Schedule-Id (same as @upstash/qstash's schedules.create). Use the
# token's region base URL (QSTASH_URL) if it is not the global one.
curl -XPOST "${QSTASH_URL:-https://qstash.upstash.io}/v2/schedules/https://crm.crestahq.com/api/cron/gbp-sync" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: 0 */6 * * *" \
  -H "Upstash-Schedule-Id: leadstack-gbp-sync"
```

## UI

`/sa/[id]/ai-agents/google-business` (`components/gbp/`), one state per
`data-testid`: `gbp-state-gate-locked` (admins can still disconnect a live
connection), `gbp-state-not-admin`, `gbp-state-not-configured` (likewise keeps
Disconnect for an existing connection),
`gbp-state-disconnected`, `gbp-state-reconnect`, `gbp-state-pick` (options
`gbp-location-option-<n>`, button `gbp-select-listing`; Cancel in every picker
state when changing), `gbp-state-selected` (Change listing / Stop managing this
listing). Destructive actions use an inline confirm — never `confirm()`/`alert()`.
Under the selected listing (and, read-only, for non-admins and on the
reconnect screen) the synced reviews (`reviews-section.tsx`): `gbp-summary`
(rating, count, last synced, cadence, `gbp-health-<health>`), `gbp-sync-now`
(admins; result inline in `gbp-sync-result`), `gbp-banner-stale` /
`-partial` / `-reconnect` ("Google access was revoked — reconnect to resume
syncing. Showing cached reviews from <date>.") / `-error`, and
`gbp-review-<reviewId>` newest first (comment verbatim in `whitespace-pre-wrap`,
owner reply below) or `gbp-reviews-empty`, `gbp-banner-pending` (reconnected,
sync pending), `gbp-reviews-truncated` (the 500-record cap was hit),
`gbp-reviews-load-error`, and `gbp-runs` (recent syncs). Each is rendered by
`components/gbp/reviews-section.test.ts`.
Every state above has a jsdom test in `components/gbp/google-business-panel.test.ts`
(the disconnected → Connect → callback round trip itself is E2E-only, in
`e2e/specs/gbp-connect-select.spec.ts`).

Not done, deliberately: a single-use nonce store for the OAuth state. v2 asked
for expiry + uid binding (done); Google's authorisation codes are single-use.

## Local test procedure

`pnpm ci:check`, then with a gitignored `.env.local` carrying the E2E Firebase
keys plus `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100`, `GBP_PROVIDER=fake`,
`GBP_FAKE_ALLOW_PROD_BUILD=1`, `GBP_FAKE_AGENCY_ID=<E2E_AGENCY_ID>`, a random
`AUTOMATIONS_TOKEN_SECRET` and dummy QStash strings: `set -a; . ./.env.local;
set +a; pnpm build && pnpm exec playwright test`. The GBP specs
(`gbp-connect-select`, `gbp-sync` — E2E 2, `gbp-reconcile` — E2E 3,
`gbp-revoked` — E2E 6 sync half) skip themselves only when
`PLAYWRIGHT_BASE_URL` points at a deployed target (the production smoke job),
where the fake is refused by design. The sync specs seed the connection and
scenario on the fixture primary through `e2e/lib/gbp.ts` and drive the cron
with a QStash-signed POST (`e2e/lib/qstash.ts`).
