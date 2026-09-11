# Google Business Profile reviews & reputation

Owned replacement for GHL's Google Business Profile (GBP) dependency: a
sub-account admin connects the Google account that manages the business's
Business Profile, picks the listing, and (in later PRs) syncs, reads and replies
to genuine Google reviews and publishes a feed for an external website.

Delivered as four stacked PRs. **This document reflects PR 1**
(`feat/gbp-1-provider`): provider boundary, token lifecycle, hardened OAuth
state, listing discovery + selection, the picker UI and the fenced fake
provider. Rows marked for PRs 2–4 are not built yet.

**Four states, kept apart:** fixtures-tested ✅ · real-Google-tested ❌ ·
deployed ❌ · Velocity-connected ❌. Live Google access waits on the v4 API
approval (case `4-6894000042302`); until then the GCP project has quota 0 and
everything is proven against the deterministic fake provider.

## Capability matrix (as of PR 1)

`proven` = implemented and proven by the named test. Evidence paths are
relative to `src/` unless they start with `e2e/`.

| # | Capability | State | Evidence / where it lands |
|---|---|---|---|
| 1 | Google OAuth configuration | proven | `lib/google/oauth.ts`; `lib/google/oauth.test.ts` (scope, offline+consent, exact redirect URI, configured/unconfigured); fake counts as configured — `app/api/google/callback/provider.test.ts` |
| 2 | Agency gate (`googleEnabledByAgency`) | proven | `lib/google/gate.ts`, `lib/gbp/route-support.ts`; gate_off in `…/google/route.test.ts`, `callback/route.test.ts`, `…/google/locations/route.test.ts`, `…/google/listing/route.test.ts`; disconnect + listing DELETE stay ungated (same files) |
| 3 | Sub-account admin authorization | proven | `requireSubAccountAdmin` on connect, callback, disconnect, locations, listing; non-member / collaborator / other-sub admin refused in the route tests above |
| 4 | Secret storage | proven | tokens only at `subAccounts/{id}/private/googleConnection`; substring checks in `callback/route.test.ts`, `callback/provider.test.ts`; admin-SDK scan in `e2e/specs/gbp-connect-select.spec.ts` |
| 5 | Access-token refresh | proven | `lib/gbp/tokens.ts`; `lib/gbp/tokens.test.ts` (60s margin, single-flight, rotation — also when another writer won — other-writer adoption, revoked → reconnect-required only if the failed grant is still stored, scope check). `lib/gbp/access.ts` `withGbpAccess`: a 401 on a data call expires the cached token, refreshes once, retries once — `…/locations/route.test.ts` › detects a grant revoked while the cached access token is still FRESH. Sync uses it in PR 2 |
| 6 | Account discovery | proven (fixtures) | `lib/gbp/provider/google.ts` `listAccounts`; `provider/google.test.ts` (URL, paging); `…/locations/route.test.ts`; E2E 1. Real Google: blocked on approval |
| 7 | GBP location discovery | proven (fixtures) | `listLocations` (readMask required); `provider/google.test.ts`; `lib/gbp/discovery.ts`; `…/locations/route.test.ts` (all pages, 20-page bound); E2E 1 |
| 8 | Listing selection / mapping | proven (fixtures) | `…/google/listing/route.ts` (server re-fetch, unknown_location); `…/listing/route.test.ts`; E2E 1 selects the second of two similar listings |
| 9 | Manual sync | absent | PR 2 |
| 10 | Scheduled sync | absent | PR 2 (signed QStash cron) |
| 11 | Pagination | partial | provider + discovery paging proven (`provider/google.test.ts`, `provider/fake.test.ts` 3/3/1, `…/locations/route.test.ts`); review-sync paging/resume PR 2 |
| 12 | Review storage | absent | PR 2. Provider already maps reviews byte-exact (`provider/google.test.ts`) |
| 13 | Summary rating / count | partial | parsed by the provider (`provider/google.test.ts`, null when absent — never invented); stored in PR 2 |
| 14 | Owner reply read | partial | `reviewReply` parsed (`provider/google.test.ts`); shown in PR 4 |
| 15 | Owner reply create/update | partial | `putReply` / `deleteReply` in the provider (`provider/google.test.ts`, `provider/fake.test.ts`); route + UI PR 4 |
| 16 | Edit / deletion reconciliation | absent | PR 2 |
| 17 | Idempotency | absent | PR 2 (sync upsert), PR 4 (reply) |
| 18 | Sync run / audit history | partial | `subAccounts/{id}/gbpEvents`: `listing_selected` and `listing_cleared` (reasons `admin_cleared`, `disconnected`, `not_accessible_after_reconnect`) — `…/listing/route.test.ts`, `…/google/route.test.ts`, `callback/provider.test.ts`, E2E 1; sync runs PR 2 |
| 19 | Reviews inbox UI | absent | PR 4 |
| 20 | Sync health UI | partial | connection health only: reconnect guidance with its reason on the page (`components/gbp/google-business-panel.test.ts`; E2E 1 flags reconnect, sees `gbp-state-reconnect`, reconnects) and on the Settings card (`components/settings/sub-account-google-section.test.ts`); not-configured state (`google-business-panel.test.ts`). Freshness / stale / partial-sync states PR 4 |
| 21 | Public feed API | absent | PR 3 |
| 22 | Widget configuration | absent | PR 3 |
| 23 | CORS / domain controls | absent | PR 3 |
| 24 | No-JS / degraded website fallback | absent | PR 3 |
| 25 | Review-request compatibility | partial | untouched by PR 1 — `lib/reviews/*.test.ts`, `app/api/sub-accounts/[id]/google-review/route.test.ts` stay green; the listing stores `newReviewUri` for the URL-reconciliation seam in PR 4 |
| 26 | Documentation / environment / runbook | partial | this file, `docs/environment.md`, `docs/architecture/firestore-collections.md`; deploy checks `scripts/gbp-deploy-check.mjs` (`scripts/gbp-deploy-check.test.ts`); runbook + rollout in PR 4 |

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
   it. It also requires `NEXT_PUBLIC_APP_URL` to be mentioned on exactly one
   line, in `.env.production` only (`.env.example`, which Next never loads, is
   exempt), so the deploy script's `sed` and Next cannot read different values.
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

No Firestore rules or indexes change in PR 1.

## UI

`/sa/[id]/ai-agents/google-business` (`components/gbp/`), one state per
`data-testid`: `gbp-state-gate-locked` (admins can still disconnect a live
connection), `gbp-state-not-admin`, `gbp-state-not-configured` (likewise keeps
Disconnect for an existing connection),
`gbp-state-disconnected`, `gbp-state-reconnect`, `gbp-state-pick` (options
`gbp-location-option-<n>`, button `gbp-select-listing`; Cancel in every picker
state when changing), `gbp-state-selected` (Change listing / Stop managing this
listing). Destructive actions use an inline confirm — never `confirm()`/`alert()`.
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
set +a; pnpm build && pnpm exec playwright test`. `e2e/specs/gbp-connect-select.spec.ts`
skips itself only when `PLAYWRIGHT_BASE_URL` points at a deployed target
(the production smoke job), where the fake is refused by design.
