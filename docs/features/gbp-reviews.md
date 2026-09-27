# Google Business Profile reviews & reputation

Owned replacement for GHL's Google Business Profile (GBP) dependency: a
sub-account admin connects the Google account that manages the business's
Business Profile, picks the listing, syncs, reads and filters, and explicitly
replies to genuine Google reviews, reconciles the review-request link against
the listing, and publishes a feed for an external website.

Delivered as four stacked PRs. **This document reflects the whole stack at
PR 4** (`feat/gbp-4-inbox-reply`, on PR 3 `feat/gbp-3-public-feed`, on PR 2
`feat/gbp-2-sync`, on PR 1 `feat/gbp-1-provider`): PR 1's provider boundary,
token lifecycle, hardened OAuth state, listing discovery + selection, picker
UI and fenced fake provider; PR 2's review sync — Firestore model, sync core,
Sync now, the signed 6-hourly cron, reconciliation, retention and the
synced-reviews view; PR 3's public reviews widget — opaque widget id, allowed
origins, the public JSON feed and the embeddable script; PR 4's reviews inbox
filters, explicit human reply with an idempotency ledger, and the
review-request URL reconciliation (with the `/r/[token]` link fix).

**Four states, kept apart:** fixtures-tested ✅ · real-Google-tested ❌ ·
deployed ❌ · Velocity-connected ❌. Live Google access waits on the v4 API
approval (case `4-6894000042302`); until then the GCP project has quota 0 and
everything is proven against the deterministic fake provider.

## Capability matrix (as of PR 4)

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
| 15 | Owner reply create/update | proven (fixtures) | `POST …/gbp/reviews/[reviewDocId]/reply` → `lib/gbp/reply.ts`, the only caller of `putReply` / `deleteReply`. `…/reply/route.test.ts` (admin only — collaborator / non-member / other-sub admin 403; another tenant's guessed id 404 with zero calls; gate_off before the lookup; tombstone / other listing / smuggled path 404; body limits; reconnect / not connected / fake fence), `…/reply/route.idempotency.test.ts` + `route.inflight.test.ts` (one call, byte-exact text, failure leaves the review untouched, zero reply calls from sync / sweep), `components/gbp/reply-composer.test.ts` (POST only — the composer has no delete button); E2E 5 `e2e/specs/gbp-reply.spec.ts`. **`DELETE …/gbp/reviews/[reviewDocId]/reply` is API-only in v1** (v1 makes deletion optional) — proven at the route in `…/reply/route.test.ts` / `route.idempotency.test.ts` / `route.inflight.test.ts`, but there is no delete button or UI test; the manual removal path is the raw `curl` in the owner checklist below. Real Google: blocked on approval |
| 16 | Edit / deletion reconciliation | proven (fixtures) | content hash → update in place; a review is tombstoned only after it is missing from two consecutive complete single-run passes, with the anomaly brake on mass removals (`lib/gbp/sync/reconcile.ts`; `sync/two-miss.test.ts` › tombstoned only after missing from TWO consecutive complete passes, a deletion after page 1 hides a live review for one pass, one empty response never wipes a small listing; `sync/run.test.ts` › tombstoned after its second missed FULL pass); E2E 3 |
| 17 | Idempotency | proven (fixtures) | sync: deterministic doc id + content hash + one lease per sub-account (`sync/run.test.ts` › repeated sync creates and updates nothing; `sync/run-failures.test.ts` › overlapping runs; E2E 2 rerun `created:0`). Reply: the `gbpReplyAttempts/{sha256(key)[:40]}` ledger — same key → the stored result, no call; other text or review → 409 `idempotency_key_reused`; pending under 2 min → 409 `in_progress`; reply already byte-equal → no call (`…/reply/route.idempotency.test.ts`; E2E 5 replays the same request — still one call) |
| 18 | Sync run / audit history | proven (fixtures) | `subAccounts/{id}/gbpEvents`: `listing_selected` and `listing_cleared` (reasons `admin_cleared`, `disconnected`, `not_accessible_after_reconnect`) — `…/listing/route.test.ts`, `…/google/route.test.ts`, `callback/provider.test.ts`, E2E 1; `reply_posted` / `reply_deleted` (`actorUid`, `reviewDocId`, never the text — `…/reply/route.idempotency.test.ts`) and `review_url_adopted` (`previousUrl`, `url` — `…/google-review/adopt-listing-url/route.test.ts`); append-only `subAccounts/{id}/gbpSyncRuns` — one per run, created at its end, kinds and counts only (`sync/run.test.ts`, `…/gbp/reviews/route.test.ts` last 10; E2E 2 / 3 / 6) |
| 19 | Reviews inbox UI | proven (fixtures) | newest first, byte-exact with replies (`components/gbp/reviews-section.test.ts`, E2E 2); filters — stars, replied, from / to, sort — applied over the capped set with an N-of-M count, a filtered-empty state and a refused filter shown inline (`…/gbp/reviews/route.filters.test.ts`, `components/gbp/review-filters.test.ts`); Reply / Edit reply composer (`components/gbp/reply-composer.test.ts`, E2E 5) |
| 20 | Sync health UI | proven (fixtures) | connection health only: reconnect guidance with its reason on the page (`components/gbp/google-business-panel.test.ts`; E2E 1 flags reconnect, sees `gbp-state-reconnect`, reconnects) and on the Settings card (`components/settings/sub-account-google-section.test.ts`); not-configured state (`google-business-panel.test.ts`). Sync health (PR 2): `gbp-health-<health>` badge, stale / partial (outage-guard wording for `skipped_anomaly`) / reconnect / sync-pending / error banners, "Last synced …" plus the truthful schedule line, recent syncs, health re-derived per request from the live connection (`lib/gbp/sync/health.test.ts`, `components/gbp/reviews-section.test.ts`, `…/gbp/reviews/route.test.ts`; E2E 6 shows the reconnect banner over cached reviews) |
| 21 | Public feed API | proven (fixtures) | `GET /api/public/gbp/feed/[publicId]` → `lib/gbp/feed/build.ts` + allow-list serializer `feed/serialize.ts`; `…/feed/[publicId]/route.test.ts` (exact data byte-exact incl. the translated block, newest-first + id tie-break, every rating incl. 1-star, maxReviews, no-review state, one byte-identical 404, disconnect / listing clear → unavailable), `route.freshness.test.ts` (stale at 12h / reconnect / partial / outage, unavailable after 7 days / never synced, 30-day predicate, leakage), `route.http.test.ts` (ETag + 304, cache headers, 429); E2E 4 `e2e/specs/gbp-public-feed.spec.ts`, E2E 6 feed half `e2e/specs/gbp-feed-stale.spec.ts` |
| 22 | Widget configuration | proven (fixtures) | `gbpWidgets/{publicId}` + `gbpWidgetMeta`; `…/gbp/widget/route.ts`, `…/widget/rotate/route.ts`, `lib/gbp/feed/widget-store.ts`; `…/gbp/widget/route.test.ts` (opaque id, one per sub-account, rotate / revoke, collaborator / other-sub admin / non-member 403, gate off 403 with DELETE allowed, `minRating` refused); dashboard card `components/gbp/widget-section.test.ts`; E2E 4 creates it on the page |
| 23 | CORS / domain controls | proven (fixtures) | `lib/gbp/feed/origins.ts` (normalised `scheme://host[:port]`, https only except loopback http, no path / wildcard / credentials, ≤10); ACAO echoes an allowed Origin only, 403 otherwise — `route.http.test.ts`, E2E 4 (`https://evil.example` → 403, no ACAO); browser proof below |
| 24 | No-JS / degraded website fallback | proven (fixtures) | `public/embed/gbp-reviews.js` keeps the site's static content on any failure (`lib/gbp/feed/embed-script.test.ts`); example page `gbp-reviews/example/index.html`; browser proof `proof/pr3-01…07` (feed down, JavaScript off, origin removed) |
| 25 | Review-request compatibility | proven (fixtures) | one seam, `lib/reviews/canonical-url.ts` (`canonical-url.test.ts`, 4 states); senders read `configured` only (`lib/reviews/request-canonical-url.test.ts`); the listing's link is adopted only by the explicit compare-and-set `POST …/google-review/adopt-listing-url` (`…/adopt-listing-url/route.test.ts` — CAS success, `changed` writes nothing, a sync never changes the URL); proposal card `components/gbp/review-url-card.test.ts`; `/r/[token]` link fix `app/r/[token]/page.test.ts`; quote-paid seam `lib/server/quotes-service.review-request.test.ts`; existing suites green (`lib/reviews/*.test.ts`, `…/google-review/route.test.ts`); E2E 7 `e2e/specs/gbp-review-request.spec.ts` |
| 26 | Documentation / environment / runbook | implemented | this file (capability matrix, provider / OAuth / identifier and Firestore models, cadence, feed contract, degraded states, policy, review-request compatibility, security, setup, env, schedule, local tests, rollout / rollback, owner checklist); `docs/environment.md`; `docs/architecture/firestore-collections.md` + `feature-gates.md`; RUNBOOK GBP section; deploy guard `scripts/gbp-deploy-check.mjs` (`scripts/gbp-deploy-check.test.ts`) |

## Provider boundary

`src/lib/gbp/provider/` is server-only. `types.ts` defines `GbpProvider`:

- OAuth: `authorizeUrl`, `exchangeCode`, `refresh`, `revoke` (returns `GoogleTokens`).
- Data: `listAccounts`, `listLocations`, `listReviews` (`{reviews, averageRating,
  totalReviewCount, nextPageToken}`), `putReply`, `deleteReply`,
  `fetchDailyMetrics(accessToken, locationName, {metrics, startDate, endDate})`
  → one `{date, value}` series per requested metric (SP5 insights — see
  [reputation.md](reputation.md#insights-sp5-f)). The fake serves a
  deterministic series per location (`fakeDailyValue`; scenario `insights`
  patterns override it) and honours `failNext: {op: "fetchDailyMetrics"}`.

`google.ts` is the real implementation (`google-http.ts` maps responses,
`google-parse.ts` maps payloads, `google-token.ts` is the OAuth token endpoint).
Endpoints, verified 2026-09-11:

| Call | Endpoint |
|---|---|
| accounts | `GET mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20` |
| locations | `GET mybusinessbusinessinformation.googleapis.com/v1/{accounts/a}/locations?readMask=name,title,storefrontAddress,websiteUri,metadata&pageSize=100` |
| reviews | `GET mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews?pageSize=50&orderBy=updateTime%20desc` |
| reply | `PUT` / `DELETE mybusiness.googleapis.com/v4/{review.name}/reply` |
| insights (verified 2026-09-14) | `GET businessprofileperformance.googleapis.com/v1/{locations/l}:fetchMultiDailyMetricsTimeSeries?dailyMetrics=…&dailyMetrics=…&dailyRange.startDate.year=…&.month=…&.day=…&dailyRange.endDate.…` — response `multiDailyMetricTimeSeries[].dailyMetricTimeSeries[{dailyMetric, timeSeries.datedValues[{date:{year,month,day}, value}]}]`; `value` is an int64 string Google leaves out when it is 0 (read as 0). **Live: 429 quota 0 until case 4-6894000042302 is approved.** |

Every failure is a `GbpProviderError` whose `kind` is one of `auth_expired`
(401), `revoked` (OAuth `invalid_grant`), `insufficient_scope` (403
`ACCESS_TOKEN_SCOPE_INSUFFICIENT` / "insufficient authentication scopes", or
OAuth `invalid_scope`), `permission_denied` (other 403), `not_found` (404),
`rate_limited` (429, `retryAfterMs` from `Retry-After`), `access_not_approved`
(a 429 `RESOURCE_EXHAUSTED` whose ErrorInfo `metadata.quota_limit_value` is
`"0"` — the project's Business Profile API access is not approved yet; never
retried by the sync, and shown everywhere as "Google hasn't approved Business
Profile API access for this project yet." — `lib/gbp/error-text.ts`), `transient` (5xx,
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
| `GET /api/google/callback` | admin, gated | state + uid check, exchange, token split; on reconnect re-verifies an existing listing with the new token — cleared (audited `not_accessible_after_reconnect`, and only if the stored listing is still the one checked) when provably not visible, with every extra listing (each audited `extra_listing_removed`, same reason); kept if the check fails or the 20-page walk was truncated before finding it. When the main is kept, each extra is re-verified the same way (one walk) and one provably not visible is removed on its own (`extra_listing_removed`, reason `not_accessible_after_reconnect`; only while the stored entry is still the same `accountName` + `locationName` that was checked; only its synced data cleared) |
| `GET /api/sub-accounts/[id]/google/status` | any member | `{configured}` — deployment-level boolean only |
| `DELETE /api/sub-accounts/[id]/google` | admin, **ungated** | best-effort revoke, skipped when a requested fake is refused (nothing to revoke with) — on a dev machine (loopback app URL) the fixture-agency fence still applies first; clears meta, `googleListing` (audited `listing_cleared`, reason `disconnected`) **and** every extra listing (one `extra_listing_removed` each, reason `disconnected`), then the synced data of all of them (`clearAllGbpCaches`) |
| `GET /api/sub-accounts/[id]/google/locations` | admin, gated | `{accounts:[{name, accountName, locations:[{name,title,address,websiteUri,placeId,mapsUri}]}], truncated}` — every page, bounded at 20 |
| `PUT /api/sub-accounts/[id]/google/listing` | admin, gated | `{accountName, locationName}`; server re-fetch, else 400 `unknown_location` (provably not visible) or `unverifiable_truncated` (past the 20-page bound — unproven, still refused); 409 `already_extra` (it is one of this sub-account's extra listings — remove it there first), 409 `listing_clearing` (that location was just removed as an extra and its cache clear still holds the `clearing` lease on `private/gbpSyncState_{locId}` — retry in a minute; read inside the transaction). **Sharing:** a main listing another sub-account also manages may still be selected, as before extras existed — `listing_shared` is refused only when adding an EXTRA; any sharing blocks auto-reply |
| `DELETE /api/sub-accounts/[id]/google/listing` | admin, **ungated** | clears `googleListing` (audited `admin_cleared`); 409 `has_extra_listings` while extra listings are connected — remove them first (disconnect still clears everything) |
| `PUT /api/sub-accounts/[id]/google/extra-listings` | admin, gated | `{listings:[{accountName, locationName}], expected:[{accountName, locationName}]}` — the whole new set of EXTRA listings, in order, and (required, validated the same way) the extras the client believes are stored ([MULTI_LISTING_V1_PLAN.md](../../MULTI_LISTING_V1_PLAN.md) PR 3). Body ≤ 8 KB (413 `body_too_large`); 400 `invalid_body` (a malformed pair or a location twice, in either list; `expected` missing), `too_many` (above 9, either list), `is_main`; each NEW pair is re-fetched in one provider walk (400 `unknown_location` / `unverifiable_truncated`, as the listing PUT) and only that re-fetch is stored, a pair already connected keeps its stored listing (so removing needs no Google call); 409 `no_listing` (no main listing), `listing_shared` (another sub-account holds a new pair as main or extra — `heldByAnotherSubAccount`, inside the transaction; refused for EXTRAS only — see the listing PUT), `account_changed` (a location's Google account switched in one save — untick, save, then re-add, so the old account's cache is cleared first), `listings_changed` (the stored extras' `accountName`+`locationName` set is not `expected` — a stale or concurrent save; nothing written; the picker re-seeds from the live doc). One transaction writes `googleExtraListings` + `googleLocationNames` and a `gbpEvents` entry per change; then each removed listing's synced data is cleared (`clearGbpCache(id, loc)`), skipped for a location connected again by then (re-read just before each clear) — the main listing's cache, drafts, summary and `reviewsAutoReply` are untouched. `{ok, added, removed}`; a clear that fails after the commit is logged (`[gbp/extra-listings]`) and answers 200 `{…, cachePending: true}` — retention and the orphan sweep purge it later |
| `POST /api/sub-accounts/[id]/gbp/sync` | admin, gated, 1/min (409 `too_soon`) | "Sync now": runs `syncListing` inline (`trigger:"manual"`); `{run:{trigger,status,startedAt,finishedAt,pagesFetched,reviewsSeen,created,updated,unchanged,removed,purged,reconciliation,resumedFromCursor,errorKind,skipReason}}` — a skip or failure is a 200 result |
| `GET /api/sub-accounts/[id]/gbp/reviews[?rating=&replied=&from=&to=&sort=&approval=]` | any member, gated | `{summary, reviews, available, needsApproval, runs, scheduled, truncated, aiDrafts}` — active reviews of the current listing seen within 30 days, newest first (cap 500 records), each with its cache `docId`; `available` = active reviews before the filters; summary with health derived now from the live connection, last 10 runs; never `passId`, `contentHash`, `reviewName` or anything under `private/`. Filters (in memory over the capped set, no composite index): `rating` comma list of 1–5, `replied` `all\|replied\|unreplied`, `from` / `to` on `createTime` — an ISO date-time WITH an offset (the page sends the viewer's local midnights: `from` = local 00:00 of the first day, `to` = local 00:00 after the last, exclusive — so filtered days match the local dates the list shows) or a bare ISO date, read as that UTC day (a date-only `to` covers the whole UTC day), `sort` `newest\|oldest`, `approval` `needed` (review auto-reply's "Needs approval": a fresh, undismissed auto-reply draft on an unreplied review); an empty value is ignored, anything else malformed is 400 `invalid_filter` with `field`. `needsApproval` = how many served reviews that filter holds (before the other filters). Each review also carries `autoReplied` (its reply was posted by auto-reply) and `approval` — `{state: held\|queued\|paused\|draft_failed\|over_limit\|post_failed, draft}` or null; only the reason and draft text, never `textHash` / `basisHash` / `model` ([reputation.md](reputation.md#review-auto-reply-auto_reply_v1_planmd)) |
| `GET /api/sub-accounts/[id]/reputation/overview[?range=]` | any member | aggregates over the SAME reviews this route serves (shared `loadServedReviews`, `lib/gbp/sync/served.ts`) plus the review-request log — see [reputation.md](reputation.md) |
| `GET /api/sub-accounts/[id]/reputation/insights[?location=&range=]` | any member for the listing; another location admin only; gated | Performance insights, in memory only — see [reputation.md](reputation.md#insights-sp5-f) |
| `POST /api/cron/gbp-retention` | QStash signature bound to this URL | the always-on daily retention housekeeping: a retention-only pass (no provider calls) for every sub-account holding a cache; `{retained}`; 500 only when the sweep cannot start |
| `POST` / `DELETE /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/reply` | admin, gated | the explicit human reply — see "Explicit owner reply (PR 4)" |
| `POST /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/auto-reply/dismiss` | admin, gated | review auto-reply's Discard: `{ok: true}`; the reply route's 403 / 404 rules; 409 `nothing_to_dismiss` for a review with a reply, no auto-reply draft, or a stale one drafted for since-edited content (nothing written); a repeat Discard is accepted. Never calls Google |
| `POST /api/sub-accounts/[id]/google-review/adopt-listing-url` | admin, gated | `{expectedCurrentUrl}` — see "Review-request compatibility (PR 4)" |
| `GET/PUT/DELETE /api/sub-accounts/[id]/gbp/widget`, `POST …/gbp/widget/rotate` | admin, gated — **DELETE ungated** | the public reviews widget (below) |
| `GET/OPTIONS /api/public/gbp/feed/[publicId]` | **public** (no session) | the public feed (below) |
| `POST /api/cron/gbp-sync` | QStash signature bound to this URL | the 6-hourly sweep; `{processed, byStatus, retained, stoppedOnRateLimit}`; 401 unsigned/invalid; 500 only when the sweep cannot start |

Refusals are `{error, code}`: 403 `gate_off`, 503 `not_configured`, 404
`not_found` (reply: not an active cached review of this sub-account's listing),
409 `not_connected` / `reconnect_required` / `idempotency_key_reused` / `has_extra_listings` / `already_extra` / `listing_clearing` / `no_listing` / `listing_shared` / `listings_changed` / `account_changed` /
`in_progress` / `changed` (+ `currentUrl`) / `no_proposal` / `nothing_to_dismiss`, 400 `invalid_body` /
`unknown_location` / `unverifiable_truncated` / `too_many` / `is_main` / `invalid_filter` (+ `field`), 413 `body_too_large`, **424** `<provider kind>`
(`access_not_approved` carries the fixed "not approved" sentence as `error`; every other kind "Google request failed").
A provider failure is **424, never 502** (`gbpErrorResponse`): crm.crestahq.com
is served through Cloudflare, which "returns a Cloudflare-branded HTTP 502 or
504 error when your origin web server responds with a standard HTTP 502 … or
504" — the HTML page replaced the `{error, code}` body, so #1000's picker read
"Couldn't load listings from Google (error)" while the server had logged
`kind=rate_limited status=429` (SP5 f). `components/gbp/gbp-refusal-through-proxy.test.ts`
runs the real route response through that edge behaviour into the real
picker and Insights tab. No response carries a token (every route test scans the
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
  or `{type:"extra_listing_added", …, locationName}` / `{type:"extra_listing_removed",
  reason: "admin_removed" | "not_accessible_after_reconnect" | "disconnected" | "admin_cleared", …, locationName}`
  (the last two when `clearListing` clears the extras with the main),
  each written in the same transaction as the change it records. No client
  rule (default deny).
- `subAccounts/{id}.googleExtraListings` — the extra listings, same shape as
  `googleListing` (`selectedAt` a timestamp, not a server sentinel: Firestore
  refuses one inside an array), written with `googleLocationNames` in the same
  transaction.

Selecting a **different** listing (or the same location through another
Google account — its reviews come back under new names), clearing it,
disconnecting, and a reconnect
re-verification that drops it all also delete the synced review cache, the
summary and the sync state (`clearGbpCache`, `lib/gbp/sync/store.ts`, reached
through `clearListing` and the listing PUT). A re-verification that declines
because a newer listing was picked meanwhile leaves that listing's cache alone.

PR 4 adds:

- `subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}` — the
  reply idempotency ledger: `{agencyId, subAccountId, createdByUid,
  reviewDocId, commentHash, status: pending|succeeded|failed, errorKind,
  replyUpdateTime, at}`. A hash of the reply, never its text. No client rule
  (default deny).
- `gbpEvents` types `reply_posted` / `reply_deleted` (`actorUid`,
  `reviewDocId`) and `review_url_adopted` (`previousUrl`, `url`, `actorUid`),
  each in the same transaction as its change; never reply text.
- On a posted / deleted reply, the cached review's `reply` and `contentHash`
  only — `passId`, `lastSeenAt` and the sync's per-review bookkeeping are left
  alone. `contentHash` hashes the review's `updateTime` as an instant, so the
  hash recomputed from the stored doc equals the next sync's.
- `subAccounts/{id}.googleReviewConfig.reviewUrl` (+ `updatedAt`) — only via
  the adopt compare-and-set; a missing config is created with the config
  route's defaults (auto-send off).

**No Firestore rules or indexes change anywhere in this stack** (PR 1–4): every
new collection (`gbpReviews`, `gbpSyncRuns`, `gbpReplyAttempts`, top-level
`gbpWidgets`) has no client rule, so default deny, and every query is a
single-field one (the inbox filters run in memory). Re-check after the PR 2
rebase. (Multi-listing PR 2 later added one composite index for the
per-listing served query — see "Firestore model" below.)

## Review sync (PR 2)

### Firestore model

No client rules: every read is an API route on the Admin SDK, and the new
subcollections fall under default deny. One composite index —
`gbpReviews` (COLLECTION): `locationName ASC, createTime DESC`, for the
per-listing served query (multi-listing PR 2; deploy it and wait for READY
**before** that code ships, or the served query fails `FAILED_PRECONDITION`).

| Path | Written by | Content |
|---|---|---|
| `subAccounts/{id}/gbpReviews/{docId}` | sync (content); sentiment classifier (`sentiment` only) | `docId = sha256(review.name).hex[:40]` (deterministic → idempotent). `agencyId, subAccountId, createdByUid` (= `googleListing.selectedByUid`), `locationName, reviewName, reviewId, reviewer, starRating, comment` (byte-exact or null), `createTime, updateTime, reply, state` (`active`/`removed`), `firstSeenAt, lastSeenAt, removedAt, passId, contentHash` (sha256 of rating, comment, updateTime, reply), `missedPasses` (consecutive complete single-run passes it was missing from), `sentiment` `{label, method, basisHash, model, at}` and `sentimentAttempt` `{basisHash, failures, lastAt}` (SP5 b — see [reputation.md](reputation.md#sentiment-sp5-b); kept by a tombstone — a label and hashes, no content; never written by the sync) |
| `subAccounts/{id}/gbpSyncRuns/{runId}` | sync only, `create()` once at the end of a run — never updated | `agencyId, subAccountId, createdByUid, trigger, actorUid, startedAt, finishedAt, locationName, status, pagesFetched, reviewsSeen, created, updated, unchanged, removed, purged, reconciliation, resumedFromCursor, errorKind, skipReason`. No provider body, token or review text |
| `subAccounts/{id}/private/gbpSyncState` | sync only (locked) | MAIN listing: `lease {runId, until}`, `pass {passId, pageToken, pagesDone, startedAt, averageRating, totalReviewCount}`, `retentionPurgedAt`, `anomalyStreak {removals, count, lastAt}`; plus the sub-account-wide `lastManualAt` (Sync-now cooldown) |
| `subAccounts/{id}/private/gbpSyncState_{locId}` | sync only (locked) | The same per EXTRA listing (`locId` = `locationName` after `locations/`): its own lease, pass, `retentionPurgedAt`, `anomalyStreak` |
| `subAccounts/{id}.gbpSummary` | sync only (member-readable) | MAIN listing: `locationName, averageRating, totalReviewCount, lastSuccessfulSyncAt, lastRunAt, lastRunStatus, lastErrorKind, lastReconciliation, health` — kinds only |
| `subAccounts/{id}.gbpSummaries.{locId}` | sync only (member-readable) | The same per EXTRA listing |

The review collection holds the sub-account's **current** listings — the
main one (`googleListing`) and any extras (`googleExtraListings`,
[MULTI_LISTING_V1_PLAN.md](../../MULTI_LISTING_V1_PLAN.md)); each doc's
`locationName` scopes it. Per listing (`src/lib/gbp/sync/scope.ts`): an
extra's cache is its own docs; the main listing's is every doc not belonging
to a current extra — so a sub-account without extras has exactly one
listing, the legacy paths and the whole collection, as before. A pass of one
listing never counts a miss for, tombstones or purges another's reviews.

- **Sync:** `syncSubAccount` (`sync/sub-account.ts`) runs `syncListing` for
  the main listing (exactly the single-listing run), then each extra, one
  after another, each under its own lease; an extra's throw becomes that
  extra's failed run. One aggregate (`created + updated`, earliest start)
  goes to auto-reply + sentiment, once per sub-account. Sync now answers
  `{run: <main's>, runs: [<each listing's>]}`; one `gbpSyncRuns` record per
  listing.
- **Served reads:** `loadServedReviews(sa, locationNames, now)` runs one
  `locationName ==` + `createTime desc` + `limit 501` query per listing and
  merges newest first; `truncated` when any listing hit the cap. The
  main-only readers (inbox, Overview, sentiment, agent capability) pass the
  main listing only.
- **Clearing:** `clearGbpCache(sa, extra?)` (`sync/clear.ts`) clears ONE
  listing under its lease — the main scope (listing change) or one extra.
  `clearAllGbpCaches(sa)` clears every listing plus a failed clear's
  leftovers (Google gate off, disconnect, listing cleared). Markers
  (`autoReplyNever`, `autoReplyDismissed`, alerts) are never touched.

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
  per call, 3 at a time**; the first `rate_limited` or `access_not_approved` (quota 0 — project-wide and permanent until approval) result stops new tenants.
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

## Public reviews widget and feed (PR 3)

The Velocity website (and any buyer's site) shows the listing's Google reviews
without GHL and without a rebuild: a sync changes the feed, the page reads the
feed.

### Why a JSON feed + script, not an iframe

The Velocity site is static HTML. A small script lets the site keep its own
markup and styling and gives a real no-JS fallback — the static HTML already
inside the container stays when JavaScript is off or the feed fails — and the
per-widget CORS allow-list is meaningful for `fetch`. An iframe would need a
per-origin `frame-ancestors` policy and has no no-JS fallback. The script is
served like `/widget.js` (`next.config.ts`).

### Widget config

| Where | Who writes | Content |
|---|---|---|
| `gbpWidgets/{publicId}` (top level) | server only; no client rule → default deny | `agencyId, subAccountId, createdByUid, enabled, allowedOrigins, maxReviews, layout, theme, createdAt, updatedAt` |
| `subAccounts/{id}.gbpWidgetMeta` | server only (member-readable) | `{publicId, enabled, allowedOrigins, maxReviews, layout, theme, updatedAt}` — the id is public by nature (it is in the snippet) |

- **One widget per sub-account.** `publicId` = 24 random bytes, base64url
  (32 chars) — opaque, never derived from a tenant id. Doc and meta change in
  one transaction.
- **Allowed origins:** each normalised to `scheme://host[:port]` (lower-case
  host, default port dropped, duplicates removed); https only, except
  `http://localhost[:port]` / `http://127.0.0.1[:port]` for development; a
  path, query, fragment, wildcard or credentials is refused with a reason per
  entry (400 `invalid_origins`); at most 10 (400 `too_many_origins`).
  An empty list means no browser may read the feed (a server can).
- **maxReviews** 1–50, default 12.
- **layout** `carousel | grid | list | badge`, default `carousel`; **theme**
  `light | dark`, default `light` (SP5 W1/W2). Both optional in the PUT body; any
  other value is a 400 `invalid_body`. A PUT replaces the config, so leaving
  one out saves the default. A widget saved before they existed has neither
  field and reads (GET, feed, rotate) as `carousel` + `light` — exactly what it
  rendered before; so does a stored value this build does not know
  (`widgetDisplay` in `lib/gbp/feed/origins.ts`).
- **No rating filter exists.** The PUT body accepts exactly `enabled`,
  `allowedOrigins`, `maxReviews`, `layout`, `theme`; anything else —
  `minRating` included — is a 400 `invalid_body`, never silently ignored.
- **Rotate** (`POST …/gbp/widget/rotate`) issues a new id with the same
  config (layout and theme included) and deletes the old doc — the old id 404s on the server at once
  (a cached copy may live up to a minute, see below). **Revoke**
  (`DELETE …/gbp/widget`) deletes the doc and clears the meta; it stays
  **ungated**, like disconnect, so a widget can always be taken down.
- **Disconnect and listing clears** leave the widget config alone and the feed
  honest: with no listing (and PR 2's cache cleared) the feed reports
  `unavailable` with `listing: null`, and resumes by itself once a listing is
  selected and synced again. (The widget belongs to the sub-account, so a
  newly selected listing is what it then shows.)
- **Agency gate off**, or an **archived** sub-account, makes the feed answer
  the same 404 as a disabled widget.
- **How fast changes land:** the widget doc and the sub-account are read on
  every feed request, so revoke, rotate, disable, gate off and an origin
  removal act on the server at once; only the review scan is memoised (60 s
  per widget + listing, in memory). With `Cache-Control: public, max-age=60`
  a browser or proxy may keep a copy for up to a minute — so config changes
  reach visitors within about a minute, and newly synced reviews within about
  two minutes (60 s memo + 60 s max-age). The dashboard card says both.

### Feed contract v1 — `GET /api/public/gbp/feed/{publicId}`

A public path (a `PUBLIC_PATH_PATTERNS` regex for exactly one segment). The
route never reads `x-user-uid` or any identity header — on a public path a
caller can send its own. Order: id shape → rate limit → resolve → origin → body.

| Status | When | Body | Headers |
|---|---|---|---|
| 404 | malformed id — checked FIRST, so it never becomes a limiter key or a Firestore path | `{"error":"not_found"}` | `Cache-Control: no-store` |
| 429 | more than 300 requests a minute from one client, or 120 for one client + publicId (in-memory, per instance; least-recently-used, expired windows swept first, never a wholesale reset; a per-client refusal does not spend the per-widget budget). The client is `cf-connecting-ip` **only when `TRUST_CF_CONNECTING_IP=1`**, else the right-most `X-Forwarded-For` hop, else `x-real-ip` | `{"error":"rate_limited"}` | `Retry-After`, `Cache-Control: no-store` |
| 404 | unknown, disabled, rotated away, revoked, archived sub-account, agency gate off | `{"error":"not_found"}` — byte-identical to the malformed-id 404 | `Cache-Control: no-store` |
| 403 | an `Origin` header not in `allowedOrigins` (incl. `null`) | `{"error":"origin_not_allowed"}` | no `Access-Control-Allow-Origin`, `no-store` |
| 200 | otherwise | the body below | `Access-Control-Allow-Origin: <that origin>` only when an allowed Origin was sent (never `*`), `Vary: Origin`, `Cache-Control: public, max-age=60` (no stale-while-revalidate), strong `ETag` |
| 304 | `If-None-Match` lists the current ETag (compared weakly — a `W/` prefix is ignored) or is `*` | empty | same as 200 |

`OPTIONS` answers a preflight the same way (204 with ACAO +
`Access-Control-Allow-Methods: GET, OPTIONS` for an allowed origin). Other
methods are 405. The ETag is the sha256 of the body **without**
`generatedAt`, so it is stable between syncs and changes with any review,
reply, rating, freshness or `display` change (a saved layout or theme
revalidates every cached copy).

**The origin allow-list is browser-level protection, not access control.** A
request with no `Origin` header (a server, `curl`) gets the full body — the
feed holds only public Google review content, and the publicId is the only
thing standing between it and anyone who has the snippet.

```json
{ "version": 1,
  "status": "ok" | "stale" | "unavailable",
  "listing": { "title": "…", "mapsUri": "…|null", "writeReviewUri": "…|null" } | null,
  "rating": { "average": 4.6, "count": 123 } | null,
  "source": { "name": "Google", "attribution": "Reviews from Google" },
  "display": { "layout": "carousel" | "grid" | "list" | "badge", "theme": "light" | "dark" },
  "freshness": { "lastSuccessfulSyncAt": "ISO|null", "stale": true|false, "generatedAt": "ISO" },
  "reviews": [ { "id": "<gbpReviews doc id>",
                 "author": { "name": "…", "photoUrl": "…|null", "anonymous": false },
                 "rating": 1-5, "text": "<byte-exact comment or null>",
                 "createdAt": "ISO", "updatedAt": "ISO",
                 "reply": { "text": "…", "updatedAt": "ISO" } | null } ] }
```

- `listing` is null only when the sub-account no longer has a listing (then
  `unavailable`). `writeReviewUri` is Google's `newReviewUri`, served as
  Google gives it — Google's write-review link
  (`https://search.google.com/local/writereview?placeid=…`) carries the
  listing's Place ID in its query. That is Google's own public link; the Place
  ID is never served anywhere else.
- `reviews`: `state == "active"` of the current listing, not past the sync's
  own read-time 30-day predicate (`withinRetention`), newest first by
  `createTime`, ties by `id`, first `maxReviews`. **Every rating** — there is no
  sentiment or rating selection anywhere (mutation-proven: adding a
  `starRating >= 4` filter turns the feed tests red). `text` is Google's
  comment byte-exact, including the "(Translated by Google) … (Original) …"
  block. Anonymous reviewers keep Google's (empty) name with
  `anonymous: true` and never get a photo (`photoUrl: null`). The newest 200 cache records are scanned per request (one
  single-field query, no composite index); in a cache full of tombstones the
  feed may hold fewer than `maxReviews` — never an invented one.
- `display` (added in SP5 PR (e); additive, so `version` stays 1 — an embed
  that predates it ignores it and shows the carousel) is the widget's layout
  and theme, exactly those two keys via `feedDisplay`, on every body
  including `unavailable`.
- `rating` comes only from the last successful sync's summary, and only when
  Google reported both numbers (a listing with no reviews: `ok`, `rating:
  null`, `reviews: []`).
- **Never included** — an explicit allow-list serializer
  (`lib/gbp/feed/serialize.ts`), never a spread: review / account / location
  resource names, the Place ID as a field (it appears only inside Google's
  `writeReviewUri`, above), agency / sub-account ids, uids, emails, passId,
  contentHash, tokens, run diagnostics, error kinds.

**Freshness** (constants in `lib/gbp/feed/build.ts` and PR 2's `sync/types.ts`):

| status | when | served |
|---|---|---|
| `ok` | PR 2's `deriveHealth(summary, now, liveConnection)` is `ok` | everything, `freshness.stale: false` |
| `stale` | health is anything else: last success older than 12 h, grant needs a reconnect (flagged now, or the last run said so), last run partial or failed (a Google outage), reconnected but not yet re-synced | the cached reviews and rating, `freshness.stale: true` — the embed shows "Last updated <date>" |
| `unavailable` | no listing, never synced, the summary belongs to another listing, or the last success is more than **7 days** old (this also covers Google's 30-day retention) | `rating: null`, `reviews: []`, `freshness.stale: true` |

Nothing is ever presented as live.

**Owner checklist** (not run): set `TRUST_CF_CONNECTING_IP=1` in
`/home/velo/crestahq-config/.env.production` **before the next deploy** —
`scripts/deploy-velo.sh` now refuses without it (`gbp-deploy-check.mjs pre`).
velo is only reachable through the cloudflared tunnel, so Cloudflare's
`cf-connecting-ip` is the real client; buyer copies on Vercel must not set it.
Without it the limiter keys on `x-real-ip` / `X-Forwarded-For`, which a
visitor behind Cloudflare controls.

### Embed contract — `/embed/gbp-reviews.js`

Vanilla ES2017, no dependencies, not minified, safe to include twice. Copy-paste
for the Velocity site (the dashboard card prints this with the real id):

```html
<div data-crestahq-reviews="PUBLIC_ID" data-api="https://crm.crestahq.com">
  <!-- static fallback: rendered as-is with JS off or when the feed fails -->
  <p><a href="https://maps.google.com/?cid=…">Read our reviews on Google</a></p>
</div>
<script src="https://crm.crestahq.com/embed/gbp-reviews.js" defer></script>
```

- `data-state="loading"` while fetching — the fallback stays visible; the
  request carries no cookies (`credentials: "omit"`).
- `ok` / `stale` → the fallback is replaced by: listing title, average
  (rounded to one decimal) + count, "Reviews from Google" linking to
  `mapsUri`, "Last updated <date>" when stale, and the reviews in the feed's
  `display.layout`. `data-state` is then `ok` or `stale`. With a count but no
  reviews in the served window (e.g. all older than 30 days) only the header
  and attribution show — never "no reviews" under a count that says otherwise.
- Layouts (root class `chq-reviews--<layout>`):
  - `carousel` — the carousel below, unchanged; also used for a missing,
    `null` or unknown `display.layout`.
  - `grid` — every served review as a card (`ul.chq-reviews__cards` >
    `figure.chq-reviews__card`), CSS grid `repeat(auto-fill, minmax(16rem, 1fr))`,
    no motion, no controls.
  - `list` — the same cards stacked vertically.
  - `badge` — the header only, plus the average as stars and "Write a review"
    linking to `writeReviewUri` when it is http(s). **No review text**, no
    author, no reply.
- The Google attribution (`.chq-reviews__source`) renders in **every** layout;
  there is no setting to remove it (see Google policy below).
- `display.theme: "dark"` adds `chq-reviews--dark` (dark background, light
  text, adjusted borders, links and buttons); `light`, missing or unknown is
  today's look, which inherits the site's colours.
- `unavailable`, any non-2xx, a network error, a body that is not JSON or an
  unknown `version` → the fallback is left untouched, `data-state="fallback"`.
- Feed data reaches the page through `textContent` only (never `innerHTML`);
  only `http(s)` links from the feed are made clickable.
- Carousel: labelled `‹` / `›` `<button>`s ("Previous review" / "Next
  review"), arrow keys on the focusable region, `aria-roledescription`
  carousel / slide.
- Motion (WCAG 2.2.2): auto-advance only while `prefers-reduced-motion` is
  not `reduce` — watched live, so turning it on stops rotation, and turning it
  off restarts it only if the visitor never interacted; every 8 s; paused
  while hovered or focused; a labelled pause/play button ("Pause automatic
  rotation" / "Start automatic rotation"); any use of prev/next or the arrow
  keys stops rotation for good. The timer clears itself once the widget has
  left the page. Per the WAI carousel pattern `aria-live` is `off` while it
  rotates on its own and `polite` otherwise.
- **Limitation:** containers are found once, when the script runs. A
  container added to the page later (e.g. by a client-side router) keeps its
  static fallback — unless the page calls
  `window.crestahqReviews.mount(container)`, which mounts it with
  `cache: "no-cache"` (a revalidation, so a just-saved layout shows) and does
  nothing for a container that already has a `data-state`. The dashboard
  preview is its one caller; existing sites are unaffected.
- The file is ~360 lines, past the 300-line guideline, deliberately: a site
  includes ONE `<script>`, and `public/` has no build step, so a second file
  would be a second request the first must chain-load (a new failure mode on
  every customer site). It stays one readable, unminified file.
- CSS is injected once, namespaced `.chq-reviews…`; the site can override it.

Integration example (loading, live, stale label, feed-down fallback, no-JS
fallback, reduced motion, manual controls):
[`gbp-reviews/example/index.html`](gbp-reviews/example/index.html) — serve it
from a second origin (`cd docs/features/gbp-reviews/example && python3 -m
http.server 4401`), allow `http://127.0.0.1:4401` on the widget, open
`http://127.0.0.1:4401/?id=<publicId>` (`&api=` overrides the default
`http://127.0.0.1:3100`).

### Browser proof (PR 3)

`proof/pr3-*`, fixture data only: the production build on 127.0.0.1:3100 and
the example page served from a second origin, 127.0.0.1:4401, driven in
Chromium by a Playwright proof script (one recorded video per flow, converted
to GIF with ffmpeg). Re-run after review fix round 1, so every image shows the
current embed (pause/play button, neutral fallback copy).

| Flow | GIF | Screenshot |
|---|---|---|
| Dashboard card (origins, snippet with the real id, feed URL, Rotate / Revoke) → live data on the allowed 4401 origin; the unreachable-API box keeps its fallback | `pr3-flow1-widget-card-to-live.gif` | `pr3-00-dashboard-widget-card.png`, `pr3-01-live-and-feed-down.png` |
| Auto-advance after 8 s → Pause (label flips, nothing moves for 9 s) → Play → manual Next, after which rotation stays stopped | `pr3-flow2-autoadvance-pause-play-next.gif` | `pr3-02-autoadvance-pause-play-next.png` |
| `prefers-reduced-motion: reduce`: no toggle, still 1/7 after 9 s, arrow keys move it | `pr3-flow3-reduced-motion-keyboard.gif` | `pr3-03-reduced-motion-keyboard.png` |
| JavaScript disabled: the `<noscript>` note and the static fallbacks | `pr3-flow4-javascript-off.gif` | `pr3-04-javascript-off.png` |
| The origin removed from the widget: the browser is refused (console: no `Access-Control-Allow-Origin`), the fallback stays | `pr3-flow5-origin-removed-fallback.gif` | `pr3-05-origin-removed-fallback.png` |
| After a revoked-grant sync: the cached reviews with "Last updated <date>" | `pr3-flow6-stale-after-revoke.gif` | `pr3-06-stale-after-revoke.png` |

### Google policy and attribution

- **Storage** — Business Profile APIs policies,
  https://developers.google.com/my-business/content/policies: content "must be
  stored temporarily for no more than 30 calendar days." The feed never serves
  a review past PR 2's 30-day read-time predicate, and stops serving anything
  after 7 days without a successful sync.
- **Attribution** — same page: "you must display such attribution as
  provided, or as described in the Business Profile APIs documentation, and
  you must not delete or alter the attribution." The feed carries
  `source.attribution: "Reviews from Google"` and the listing's Maps link; the
  embed always renders both. **A specific display/attribution requirement for
  showing GBP API review content on a third-party website: unconfirmed** — the
  policies page has no section on it, and no other official source was found.
  Treat it as an owner-approval question before the Velocity cutover.
- **No review structured data** — https://developers.google.com/search/docs/appearance/structured-data/review-snippet:
  "If the entity that's being reviewed controls the reviews about itself,
  their pages that use `LocalBusiness` or any other type of `Organization`
  structured data are ineligible for star review feature." and "Don't
  aggregate reviews or ratings from other websites." Neither the feed, the
  script nor the example emits `AggregateRating` / `Review` markup; the site
  should not add any around the widget.
- **No review gating** — every rating is served, in date order.

## UI

`/sa/[id]/ai-agents/google-business` (`components/gbp/`), one state per
`data-testid`: `gbp-state-gate-locked` (admins can still disconnect a live
connection), `gbp-state-not-admin`, `gbp-state-not-configured` (likewise keeps
Disconnect for an existing connection),
`gbp-state-disconnected`, `gbp-state-reconnect`, `gbp-state-pick` (options
`gbp-location-option-<n>`, button `gbp-select-listing`; Cancel in every picker
state when changing), `gbp-state-selected` (Change listing / Stop managing this
listing). Destructive actions use an inline confirm — never `confirm()`/`alert()`.
Under the selected listing, `gbp-extra-listings` ("Additional listings",
`extra-listings.tsx`): each extra as `gbp-extra-listing`; for admins
`gbp-manage-extra-listings` opens the picker in multi mode (checkboxes, the
main listing left out, connected extras ticked; the location walk runs only
then) with `gbp-save-extra-listings` ("Save additional listings", sends the
whole set and, as `expected`, the extras it opened with). A connected extra
missing from the walk is still a ticked row, `gbp-location-missing-<n>`
(stored title + "not visible in this Google connection"), so it can be
removed. On 409 `listings_changed` a toast says "Listings changed — reopened
with the latest" and the picker re-seeds from the live extras. Non-admins see the list read-only, only when extras exist —
`google-business-panel.test.ts`, `listing-picker.multi.test.ts`, E2E
`gbp-extra-listings.spec.ts`.
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
**Across listings (MULTI_LISTING_V1_PLAN.md PR 4):** the reviews are every
connected listing's combined, newest first (GET `…/gbp/reviews` answers
`listings: [{locationName, title, main}]`, and each review carries
`listing: {locationName, title}`). With more than one listing the filter bar
gains `gbp-filter-listing` — "All listings" (the default) then each listing by
title — which sends `?listing=locations/…` (a current listing of this
sub-account, else 400 `invalid_filter` field `listing`); the summary card then
shows that listing's summary ("All" shows the main listing's) and
`needsApproval` counts only the served set. Only then does each row carry
`gbp-review-listing-<reviewId>` and each recent sync `gbp-run-listing` (its
listing's title); with one listing the page looks exactly as before. Reply,
Draft with AI and Discard work on a review of any connected listing and go to
that review's own listing. Auto-reply stays main-only until PR 6, so an extra
listing's queued draft reads "Auto-post paused" —
`components/gbp/reviews-section.listing.test.ts`,
`…/gbp/reviews/route.listing.test.ts`, E2E `gbp-reply-listings.spec.ts`.
PR 4 adds, over the reviews: the filter bar `gbp-filters` —
`gbp-filter-rating-<1…5>` (toggles, `aria-pressed`), `gbp-filter-replied`,
`gbp-filter-from`, `gbp-filter-to`, `gbp-filter-sort`, `gbp-filter-clear`,
the count `gbp-filter-count` ("Showing N of M reviews"), `gbp-filter-error`
(a filter the server refused, list kept) and `gbp-reviews-empty-filtered` —
rendered by `components/gbp/review-filters.test.ts`; the reply composer on
each review (see "Explicit owner reply") — `components/gbp/reply-composer.test.ts`;
and, next to the selected listing and on Settings → Google reviews, the
review-link card (see "Review-request compatibility") —
`components/gbp/review-url-card.test.ts`, mounted on the page per
`google-business-panel.test.ts`.
Below the panel, for admins, the public widget card (`widget-section.tsx`):
`gbp-widget-card`, `gbp-widget-state-none` / `gbp-widget-state-disabled`,
`gbp-widget-enable`, `gbp-widget-origins`, `gbp-widget-save`,
`gbp-widget-errors` (the server's reason per rejected origin),
`gbp-widget-snippet`, `gbp-widget-feed-url`, `gbp-widget-rotate`,
`gbp-widget-revoke`; with the gate off only Revoke — each rendered by
`components/gbp/widget-section.test.ts`. SP5 PR (e) adds `gbp-widget-layout`
(Carousel / Grid / List / Badge) and `gbp-widget-theme` (Light / Dark), saved
with Save, and `gbp-widget-preview` — "Preview (saved settings)"
(`widget-preview.tsx`): the real embed script against this widget's feed,
with `gbp-widget-preview-loading`, `gbp-widget-preview-fallback` (the feed
refused or had nothing — e.g. switched off) and `gbp-widget-preview-error`
(the script did not load) — each rendered by
`components/gbp/widget-section.display.test.ts`. The preview's feed request
is same-origin, and browsers send no `Origin` on a same-origin GET, so the
feed serves it without the dashboard on the allow-list (asserted in
`gbp-widget-layouts.spec.ts`); the allow-list is unchanged.
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
`gbp-revoked` — E2E 6 sync half, `gbp-public-feed` — E2E 4, `gbp-feed-stale` —
E2E 6 feed half, `gbp-reply` — E2E 5, `gbp-review-request` — E2E 7,
`gbp-widget-layouts` — SP5 W1/W2) skip themselves only when
`PLAYWRIGHT_BASE_URL` points at a deployed target (the production smoke job),
where the fake is refused by design. The sync specs seed the connection and
scenario on the fixture primary through `e2e/lib/gbp.ts` and drive the cron
with a QStash-signed POST (`e2e/lib/qstash.ts`).

## Explicit owner reply (PR 4)

`POST /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/reply`
`{comment, idempotencyKey}` posts (or edits) the owner reply to one Google
review; `DELETE` on the same path deletes it. `lib/gbp/reply.ts` is the
**only** caller of the provider's `putReply` / `deleteReply`. No sync,
workflow or other AI path posts a reply; the sync itself never does
(`…/reply/route.idempotency.test.ts` › no sync, sweep or cron path ever calls
putReply or deleteReply; E2E 5 counts the fake's call log after a cron
sweep). **AI drafts exist since SP5 (c)** —
`POST …/gbp/reviews/[reviewDocId]/draft` returns text for the composer's box
and posts nothing (it never reaches `putReply` / `deleteReply`; every draft
route test ends by asserting zero reply calls, and
`e2e/specs/reputation-ai-draft.spec.ts` counts zero until the click). **Since
auto-reply ([reputation.md › Review auto-reply](reputation.md#review-auto-reply-auto_reply_v1_planmd)),
`lib/gbp/reply.ts` has a second caller**: after a sync responds, the engine
may post rating-only replies without a click for a sub-account that switched
it on — only while `REVIEWS_AUTO_REPLY_ENABLED=1` is set on the deployment,
never over an existing reply (`requireNoReply`), and never a delete.

Order of checks, each refusal writing nothing and calling Google zero times:

1. `requireSubAccountAdmin` — collaborator, non-member and other-sub admin 403.
2. Agency gate — 403 `gate_off`, answered before the review is looked up.
3. The review — 404 `not_found` unless `reviewDocId` is 40 lower-case hex
   characters naming an **active** cached review of one of the **current**
   listings (main or extra — `locationNamesOf(sub)`) under **this**
   sub-account. A guessed id from another tenant, a tombstone, a review of a
   removed or never-connected listing and a smuggled path (`a/b/c`) all 404
   (`…/reply/route.multi.test.ts`). The Google call uses the review's own
   `reviewName`, so a reply goes to that review's own listing; Draft with AI
   names that listing's title as the business.
4. Body — `comment` a string of 1–4000 characters, trimmed only to test for
   emptiness and sent exactly as typed; `idempotencyKey` 8–128 characters,
   made by the browser when the composer opens. Else 400 `invalid_body`.
5. Deployment / connection / fake fence — 503 `not_configured`, 409
   `not_connected` / `reconnect_required`.

**Idempotency** — one transaction on
`subAccounts/{id}/gbpReplyAttempts/{sha256(idempotencyKey)[:40]}`:

| Ledger state for the key | Result |
|---|---|
| none, or `failed`, or `pending` for over 2 minutes | claim as `pending`, then call `putReply` **once** |
| `succeeded` | the stored result, no call — also for a late retry after a newer edit |
| `pending` under 2 minutes | 409 `in_progress`, no call |
| recorded for other text or another review | 409 `idempotency_key_reused`, no call |
| the review's reply is already byte-equal | `succeeded` without a call |
| a DIFFERENT key's attempt already holds this review's lock (see below), under 2 minutes | 409 `in_progress`, no call |

**Per-review in-flight lock** — the claim transaction also takes
`replyInFlight {key, at}` on the cached review, released by whichever attempt
holds it (success, failure, or "gone"). This stops a second, different key
from posting over the first while its call is still in flight — the network
drops, the admin edits and resubmits under a new key, and Google's PUT keeps
only the last write, so an abandoned text could otherwise go public. A lock
older than 2 minutes is treated as a dead request and does not block. The
`putReply` / `deleteReply` fetches carry `AbortSignal.timeout(30_000)`
(`lib/gbp/provider/google.ts`), well inside that window, so a "pending past 2
minutes" lock really is dead, not just slow.

The call goes through `withGbpAccess` (a 401 refreshes and retries once — the
only retry; the human retries with the same key). The composer reuses its key
for a retry of the same text and makes a new one when the text changes.

- **Success** — in one transaction: the cached review's `reply {comment,
  updateTime}` (Google's) and a recomputed `contentHash`, so the next sync
  reads it `unchanged`; the attempt `succeeded`; a `reply_posted` event
  (`actorUid`, `reviewDocId`, no text); the lock released. A review whose
  cache was cleared meanwhile is not recreated, and a tombstone stays one.
  **If this local write itself throws** (Firestore hiccup) after Google has
  already accepted the reply, the route does not report a failure — it marks
  the attempt `succeeded` best-effort and answers 200
  `{reply, localRecordPending: true}`; the next sync's cache read brings the
  reply in normally. Reporting a 500 here would be dishonest: the reply is
  already public.
- **Failure** — the attempt `failed` with its `errorKind`, the cached review
  untouched, the lock released; 424 `{code: <kind>}`, or 409
  `reconnect_required` (a revoked grant is flagged as everywhere else). The
  reply text is never logged. If *recording* the failure itself throws, the
  route still returns Google's real error (logs the failure-to-record by kind
  only) rather than masking it.
- **Limit** — Google's API reference gives the reply `comment` a maximum of
  4096 **bytes**; the route counts 4000 **characters** (the decided rule), so
  a long reply in multi-byte characters can still be refused by Google — an
  honest 424, nothing cached. (Byte limit: from the v4 reference, not
  re-verified against the live API.)

UI: each review shows **Reply** (or **Edit reply**) to admins while the
connection is healthy → a textarea, the note "Your reply will be public on
Google, shown under this review as the business's response", and **Post reply
to Google**, disabled while pending or blank. Success reloads the list (the
reply shows under the review); if Google accepted the reply but the local
record write failed, the composer instead shows "Posted to Google — the inbox
will catch up on the next sync." (`gbp-reply-notice`) rather than a failure —
the reply is live either way; failure shows inline. Test ids
`gbp-reply-open-<reviewId>`, `gbp-reply-composer`, `gbp-reply-text`,
`gbp-reply-submit`, `gbp-reply-error`, `gbp-reply-notice`,
`gbp-review-reply-<reviewId>`. No `confirm()` / `alert()`. **There is no
delete button** — `DELETE` is API-only in v1 (see the matrix, row 15).

## Review-request compatibility (PR 4)

"Ask for a review" (SMS / WhatsApp requests) and "manage received reviews"
stay separate capabilities joined by one seam,
`lib/reviews/canonical-url.ts` — `resolveReviewUrl(sub)`:

| | Meaning |
|---|---|
| `configured` | `googleReviewConfig.reviewUrl` — the **only** URL a sender uses |
| `proposed` | the selected listing's `newReviewUri` — never used on its own |
| `state` | `none` (no listing link) · `proposal_available` (nothing configured) · `matches` · `differs` |

Readers: `lib/reviews/request.ts` (every SMS / WhatsApp request),
`app/r/[token]/page.tsx` (the public feedback page) and the review-link card.
The velocity-review-pipeline is untouched and can read the same seam later.

**Adopting the listing's link** — `POST
/api/sub-accounts/[id]/google-review/adopt-listing-url {expectedCurrentUrl:
string|null}`, admin, gated. In one transaction it sets
`googleReviewConfig.reviewUrl` to the listing's `newReviewUri` **only if** the
configured URL is still `expectedCurrentUrl`; otherwise 409 `{code:"changed",
currentUrl}` and nothing is written. No https listing link → 409
`no_proposal`. No config yet → created with the config route's defaults (SMS,
default template and cooldown, **auto-send off**). Audited
`review_url_adopted`. Nothing else ever writes the URL from the listing — a
sync does not (`…/adopt-listing-url/route.test.ts`).

The card (`components/gbp/review-url-card.tsx`, admins, on the selected
listing and on Settings → Google reviews): `proposal_available` → "Your
selected Google listing's review link is <url>" + **Use it**; `differs` → both
links + **Replace with listing link**; `matches` → a quiet confirmation;
`none` → nothing. The click is the compare-and-set on the link shown; a
changed link is reported inline. Test ids `gbp-reviewurl-proposal` (with
`data-state`), `gbp-reviewurl-adopt`, `gbp-reviewurl-matches`,
`gbp-reviewurl-done`, `gbp-reviewurl-error`.

**Pre-existing bug fixed here, because it is this seam:** `/r/[token]` read
`sub.googleReview`, a field that does not exist (the config is
`googleReviewConfig`), so the page's primary call to action — the Google
review link — never rendered. `app/r/[token]/page.test.ts` was red on the old
read and is green through the seam.

What stays as it was, and what proves it: manual request, SMS opt-out and the
real dispatcher (E2E 7 — an opted-out fixture contact answers `opted_out`,
asserted opted out before acting); merge tags, cooldown, trigger flags
(`lib/reviews/request.test.ts`); WhatsApp compliance and rails
(`request-whatsapp.test.ts`, `request-rails.test.ts`); quote-paid
(`lib/server/quotes-service.review-request.test.ts` — marking a quote paid
asks with `trigger: "quote_paid"`, a refused mark-paid asks for nothing); the
config save route (`…/google-review/route.test.ts`, `isHttpsUrl` now shared).
The conversation composer's "Ask for review" and the contact header read
`googleReviewConfig` directly for display and are unchanged.

## Degraded states

| Situation | UI | API | Proven by |
|---|---|---|---|
| Google OAuth env absent (or the fake refused) | `gbp-state-not-configured` (Disconnect kept for a live connection) | 503 `not_configured` | `components/gbp/google-business-panel.test.ts`; `app/api/google/callback/provider.test.ts`; reply `…/reply/route.test.ts` (fake fence) |
| Agency gate off | `gbp-state-gate-locked` | 403 `gate_off` (disconnect, listing clear, widget revoke stay ungated); feed 404 | panel test; every GBP route test; `…/feed/[publicId]/route.test.ts` |
| Disconnected | `gbp-state-disconnected` + Connect | 409 `not_connected`; sync `skipped not_connected` | panel test; `…/reply/route.test.ts`; `sync/run.test.ts` |
| No listing selected | `gbp-state-pick` | sync `skipped no_listing`; feed `unavailable`, `listing: null` | panel test; `sync/run.test.ts`; feed `route.test.ts` |
| Refresh token revoked | `gbp-state-reconnect` + `gbp-banner-reconnect` over cached reviews; no Reply | 409 `reconnect_required`; run `reconnect_required`, cache kept | `lib/gbp/tokens.test.ts`; `sync/run-failures.test.ts`; `…/reply/route.idempotency.test.ts`; E2E 6 |
| Insufficient scope | reconnect with the scope wording | callback `?google=insufficient_scope`; flagged reconnect | `tokens.test.ts`; `callback/route.test.ts`; panel test |
| Google 401 / 403 / 404 / 429 / 5xx | run result inline; reply error inline | typed `GbpProviderError`; 401 → refresh + one retry; 429 (except quota 0 → `access_not_approved`, never retried) / 5xx retried (3 attempts) in sync, never in reply; 424 `<kind>` | `provider/google.test.ts`; `sync/run-failures.test.ts`; `…/reply/route.idempotency.test.ts` |
| Pagination fails halfway | `gbp-banner-partial` | run `partial`, cursor kept, next run resumes | `sync/run-failures.test.ts` |
| Location gone / access removed | listing cleared on reconnect re-verify | `listing_cleared not_accessible_after_reconnect`; `not_found` run | `callback/provider.test.ts`; `listing-events.test.ts` |
| Cached data stale | `gbp-banner-stale`, `gbp-health-stale` | health `stale`; feed `stale` / later `unavailable` | `sync/health.test.ts`; `reviews-section.test.ts`; `route.freshness.test.ts`; E2E 6 feed half |
| No reviews | `gbp-reviews-empty`; filtered: `gbp-reviews-empty-filtered` | `reviews: []`; feed `ok`, `rating: null` | `reviews-section.test.ts`; `review-filters.test.ts`; feed `route.test.ts` |
| Never synced / sync pending | `gbp-health-never_synced`; `gbp-banner-pending` | health `never_synced` / `sync_pending` | `reviews-section.test.ts`; `…/gbp/reviews/route.test.ts` |
| Reviews could not load | `gbp-reviews-load-error` | — | `reviews-section.test.ts` |
| Widget disabled / revoked | card `gbp-widget-state-disabled` / `-none` | feed 404, byte-identical | `…/gbp/widget/route.test.ts`; feed `route.test.ts` |
| Disallowed origin | the site keeps its static fallback | 403, no ACAO | `route.http.test.ts`; E2E 4 |
| QStash not configured (local) | "Automatic sync is not scheduled on this deployment — use Sync now" | no schedule; the cron 401s unsigned calls | `reviews-section.test.ts`; `app/api/cron/gbp-sync/route.test.ts` |
| A reply Google refuses | `gbp-reply-error`, text kept | 424 `<kind>`, attempt `failed`, review untouched | `…/reply/route.idempotency.test.ts`; `reply-composer.test.ts`; E2E 5 |
| Review link changed under the admin | `gbp-reviewurl-error` with the current link | 409 `changed`, nothing written | `…/adopt-listing-url/route.test.ts`; `review-url-card.test.ts`; E2E 7 |

## Security and tenancy

- Every internal route authorises server-side through `lib/auth/require-tenancy`
  (members read; admins write, connect, sync, reply, adopt), then the agency
  gate. The public feed reads no identity header at all.
- Tokens live only at `subAccounts/{id}/private/googleConnection` (locked);
  no response carries one (route tests scan every body). Refusal messages are
  fixed per code; provider error bodies are never returned or logged — only
  the kind and HTTP status.
- Every tenant doc carries `agencyId`, `subAccountId`, `createdByUid`. A review
  id guessed from another tenant names nothing under the caller's sub-account
  (404, zero provider calls). The fake provider is fenced to the fixture
  agency and bound to one sub-account.
- Replies are an explicit authenticated human action; the ledger and events
  hold a hash and ids, never reply text. Review text is stored byte-exact and
  never logged.
- No review gating: every rating is shown, served and replyable; the feed has
  no rating filter. The configured review link is the same for every customer.

## Google setup prerequisites

1. GCP project `crestahq-app` with the OAuth consent screen and a web OAuth
   client; redirect URI `${NEXT_PUBLIC_APP_URL}/api/google/callback`; scope
   `https://www.googleapis.com/auth/business.manage`. Client id / secret and
   the state secret: [docs/environment.md](../environment.md) → "Optional —
   Google Business Profile".
2. APIs: My Business Account Management, My Business Business Information and
   the legacy v4 reviews API (`mybusiness.googleapis.com`). The v4 API needs
   Google's GBP API access approval — case `4-6894000042302`; until approved
   the project's quota is 0.
3. The connecting Google account must own or manage the listing.

PR 4 adds no environment variables. The GBP ones (`GBP_PROVIDER`,
`GBP_FAKE_ALLOW_PROD_BUILD`, `GBP_FAKE_AGENCY_ID`, `GBP_SYNC_SCHEDULE_ENABLED`)
and the QStash keys are in [docs/environment.md](../environment.md); the
schedule is described under "Sweep, capacity and schedule" above.

## Rollout and rollback

**Rollout** (after the four PRs are reviewed and merged in order):

1. After-hours production deploy (checklist item 3). Nothing changes for any
   tenant: `googleEnabledByAgency` defaults to off.
2. Turn the schedule on (item 2).
3. Live proof on a TEST sub-account (item 5), once Google approves v4 (item 4).
4. Enable the gate for a real sub-account, one at a time, and verify the gate
   in Firestore after each save.
5. Velocity website cutover, separately approved (item 6).

**Rollout note:** the first sync after this deploy rewrites every cached
review's `contentHash` once (PR 4 changed what the hash is computed from —
`updateTime` is now hashed as an instant, not its raw string). Reviews with no
real content change will briefly show as `updated` in that one run's audit
history. Harmless; it does not repeat on later runs.

**Rollback**, cheapest first:

- Turn the agency gate off for the sub-account: the page locks, the feed 404s,
  reply / adopt / sync-now refuse with `gate_off`, and scheduled syncs skip.
  Stored connection and config are preserved; cached reviews still leave under
  the 30-day rule.
- Stop scheduled syncs: unset `GBP_SYNC_SCHEDULE_ENABLED` and delete the
  schedule — `curl -XDELETE "${QSTASH_URL:-https://qstash.upstash.io}/v2/schedules/leadstack-gbp-sync" -H "Authorization: Bearer $QSTASH_TOKEN"`.
- Redeploy the previous release with `bash scripts/deploy-velo.sh` (after
  hours). The new collections are additive and need no migration either way.
- A reply already posted lives at Google: remove it with `DELETE
  …/gbp/reviews/[reviewDocId]/reply` (or in Google's own UI) before rolling
  back if it must go. Disconnect revokes the grant at Google.

## Browser proof (PR 4)

`proof/pr4-*.png` — the production build on 127.0.0.1:3100 with the fake
provider, fixture primary only, driven by a Playwright proof script in
Chromium (not committed). Each is one section of the page, never the full
window.

| File | Shows |
|---|---|
| `pr4-01-review-link-differs.png` | the configured link and the selected listing's link side by side, with **Replace with listing link** — nothing applied |
| `pr4-02-filters-1-2-stars-unreplied.png` | 1★ + 2★ and "Not replied": "Showing 2 of 7 reviews", each with **Reply** |
| `pr4-03-reply-composer.png` | the composer: typed text, "Your reply will be public on Google…", **Post reply to Google** |
| `pr4-04-reply-posted.png` | after the click: the owner reply under the review, **Edit reply** |
| `pr4-05-reply-failed-inline.png` | the fake refuses the next reply: "Google request failed" inline, the text kept |
| `pr4-06-review-link-adopted.png` | after **Replace with listing link**: "Review requests use this listing's review link." |

No GIF this time: a screen recording captures the whole window, including the
signed-in account's chrome, which is not fixture data.

## Owner-approval checklist (none of these were run)

The deploy dir's `/home/velo/crestahq/.env.production` is a symlink to
`/home/velo/crestahq-config/.env.production` — the real file every step below
edits; both paths name the same file.

1. **Firestore rules / indexes** — `firebase deploy --only firestore:rules,firestore:indexes`.
   **Not required for this stack:** PR 1–4 change no rules and no indexes
   (default-deny collections, single-field queries) — verified on the final
   stack: `git diff origin/main...feat/gbp-4-inbox-reply -- firestore.rules
   firestore.indexes.json` is empty.
2. **Env vars** — in `/home/velo/crestahq-config/.env.production`:
   - `GBP_SYNC_SCHEDULE_ENABLED=1` — enables the sync schedule below.
   - `TRUST_CF_CONNECTING_IP=1` — required before this deploy; `gbp-deploy-check.mjs pre`
     refuses the deploy without it (see "Embed contract" above for why).
   Then do the approved deploy (item 3).
3. **Production deploy** — `bash scripts/deploy-velo.sh` on velo-server from
   the deploy checkout, after hours only (never 08:00–17:00 SAST Mon–Fri),
   after the PR 1 velo check block above (the deploy's `scripts/gbp-deploy-check.mjs`
   refuses a fake-provider setting or a missing `TRUST_CF_CONNECTING_IP`).
4. **Verify the schedules registered** — the next cold start after this
   deploy registers `leadstack-gbp-sync` (`0 */6 * * *`, only when
   `GBP_SYNC_SCHEDULE_ENABLED=1`) and, unconditionally, `leadstack-gbp-retention`
   (`30 4 * * *` daily, registered regardless of that flag). Confirm both exist:
   `curl -s "${QSTASH_URL:-https://qstash.upstash.io}/v2/schedules" -H "Authorization: Bearer $QSTASH_TOKEN" | jq '.[].scheduleId'`
   should list `leadstack-gbp-sync` and `leadstack-gbp-retention`. Without a
   deploy, register the sync schedule by running the exact curl under "Sweep,
   capacity and schedule" above instead.
5. **v4 approval** — `gcloud services list --available --project crestahq-app | grep mybusiness.googleapis.com`.
6. **Live proof, Hein present** — on a named TEST sub-account (not Blitz or
   Velocity's live sub-account), exact sequence:
   1. Agency → Manage dialog for the TEST sub-account → enable the Google
      Business gate → Save.
   2. `https://crm.crestahq.com/sa/<TEST_SUB_ACCOUNT_ID>/ai-agents/google-business`
      → **Connect** → sign in with the account that manages the real Blitz or
      Velocity listing → **grant access**.
   3. On the same page, pick that listing from the list Google returns.
   4. Click **Sync now**; wait for the run to finish (`gbp-sync-result`).
   5. Compare the shown count and average rating against the same listing on
      Google Maps, and one review's text byte for byte.
   6. Check the review-link card shows the listing's real review URL.
   7. Open one unreplied review's **Reply**, type a short reply, click **Post
      reply to Google** — **exactly one**, only with Hein present.
   8. If it must come down: `curl -X DELETE
      https://crm.crestahq.com/api/sub-accounts/<TEST_SUB_ACCOUNT_ID>/gbp/reviews/<reviewDocId>/reply
      -H "Cookie: <session cookie>"` (or delete it in Google's own UI).
7. **Rollout note — `/r/[token]` fix is a live, customer-facing change.** PR 4
   fixed a pre-existing bug (`src/app/r/[token]/page.tsx` reading the wrong
   field) that meant the Google review button never showed on the public
   feedback page. Once deployed, that button will start appearing on feedback
   links customers **already received** before this fix — needs Hein's
   explicit OK before this deploy, separately from the rest of PR 4.
8. **Velocity website cutover** (separately approved) — on Velocity's
   sub-account's dashboard widget card, add the live site's real origin,
   `https://www.velocityfibre.co.za` (from the v1 spec, E2E 4 — no path), via
   **its** Save (the PUT body accepts only `enabled`, `allowedOrigins`,
   `maxReviews`:
   `curl -X PUT https://crm.crestahq.com/api/sub-accounts/<VELOCITY_SUB_ACCOUNT_ID>/gbp/widget -H "Content-Type: application/json" -H "Cookie: <session cookie>" -d '{"enabled":true,"allowedOrigins":["https://www.velocityfibre.co.za"],"maxReviews":12}'`),
   then paste the printed snippet (real `PUBLIC_ID`, `https://crm.crestahq.com`
   feed host — see "Embed contract" above) onto the Velocity site.

**Four states:** fixtures-tested ✅ · real-Google-tested ❌ · deployed ❌ ·
Velocity-connected ❌.
