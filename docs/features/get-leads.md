# Get Leads v1 (EXPERIMENTAL)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

> Un-parked 2026-09-24 as the sourcing door for [Prospecting](prospecting.md). `GET_LEADS_PARKED` in [src/lib/get-leads/business-types.ts](../../src/lib/get-leads/business-types.ts) is now `false`; setting it back to `true` hides the sidebar entry, the Manage-dialog toggle, the assistant capability and KB card again (the env-schema group and `.env.example` block would then need removing by hand).

Local-business prospecting per sub-account (positioned generically — "find businesses that might need what you sell", not just web services): pick a **business type** (curated top-20 picklist **plus** the sub-account's own custom service types — the admin-only **Manage services** button in the page header opens a dialog listing EVERY service (customs badged "Custom" + built-ins together); add appends a custom, delete removes a custom or hides a built-in (with a restore link; at least one service must remain). One PUT to `/api/sub-accounts/[id]/get-leads/types` replaces both lists: customs on `subAccountDoc.getLeadsCustomTypes` (≤30 × ≤60 chars, label doubles as the Maps query, value prefixed `custom:` so it can't spoof a curated entry) and deleted built-in values on `getLeadsHiddenTypes` (presentation-only — the search allowlist still accepts curated values)), a **location** (type-ahead Mapbox autocomplete — pick a suggestion to lock exact coordinates + a formatted place name before any search is spent; unpicked free text falls back to a one-shot geocode at submit; "Use my location" geolocates then reverse-geocodes to a readable place name), and a **radius** (1/5/10/25/50 km) — results render on a clustered **Mapbox map** and an enriched **list** (name, category, phone, email, website, socials, rating, address), and checked rows import as contacts. Sidebar → **Get Leads** at `/sa/[id]/get-leads`; gated by `getLeadsEnabledByAgency` (off by default; supports the hide-override).

## Data flow — synchronous search, ephemeral results

- **Provider: Google Places API (New) Text Search** (`GOOGLE_PLACES_API_KEY`, agency-level, restricted to `places.googleapis.com`). `POST /api/sub-accounts/[id]/get-leads/search` calls `places:searchText` with `textQuery` "`<type query> in <place name>`", a `locationBias` circle (the picked radius, capped at 50 km) and `pageSize` 20, and returns the finished results in the same request — no polling. The field mask in `lib/get-leads/places.ts` is fixed and tested: it decides the billing SKU, and adding review, photo or atmosphere fields moves every call to a pricier one.
- **Emails + socials are ours** — Places has no email field, so `lib/get-leads/enrich.ts` fetches each result's homepage (5s, 500 KB, ≤3 redirects, http/https only, 6 at a time) through `publicFetch` — public addresses only in production, re-checked on every redirect hop — and takes the first plausible email (the site's own domain preferred) plus Facebook / Instagram profile links. A site that fails, times out or is refused just leaves that row without contacts; it never fails the search.
- **Radius enforcement is ours** — the location bias is only a preference (Google returns spill-over), so the search route haversine-filters results against the origin + radius (`lib/get-leads/geo.ts`) before enrichment. Businesses returned without coordinates are kept.
- **Results are never persisted.** Navigate away and they're gone. The only durable output is the import.
- **Query allowlist + call budget** — the search route only accepts `businessType` values from the curated picklist (`lib/get-leads/business-types.ts`, also the server-side validator), so a forged request can't run arbitrary queries on the agency's key. The operator picks a **Max results** value per search (10/20/40 — `RESULT_LIMIT_OPTIONS`, server-validated, default 20). Each page of 20 is one billable call, so 10/20 cost one call and 40 costs two; a search never makes more than `ceil(limit / 20)` calls. `GET_LEADS_RESULT_LIMIT` (40) remains the ceiling + the import batch cap.

## Cost

Text Search with this field mask bills at the Enterprise tier, which is **free up to 1,000 calls a month**. The Google Cloud project also carries a **hard quota of 30 SearchText calls a day** — so at most 15–30 searches a day across every sub-account on the deployment. When it is spent, Google answers `429 RESOURCE_EXHAUSTED` and the page shows "Daily search limit reached — try again tomorrow." Homepage reads cost nothing.

## Import → Contacts

`POST /api/sub-accounts/[id]/get-leads/import` loops the selected rows through the shared `createContactServerSide` chokepoint — so `contact.created` webhooks + workflow triggers fire like any other create. Each import: `source: "prospecting"` (cyan badge) + tags `["prospecting", <batch tag>]` (contacts imported before 2026-09-24 keep `source: "get-leads"` / tag `get-leads`) — the batch tag is the results bar's editable **"Tag as"** input (pre-filled `<type>-<location>`, slugified server-side, stored WITHOUT a prefix so it matches exactly what the operator picks in workflow-trigger `has_tag` filters / broadcast audiences / voice-campaign audiences), business name as contact name AND company, listing lat/lng onto the contact's location fields (pins land on the dashboard Leads map), a note carrying the enrichment extras that have no first-class contact field (website, socials, rating, category), and a `prospecting` map on the contact: `placeId` (the Google Places `id`, only when the row carried one — the page's synthesized row key is never stored), `website`, `rating`, `reviewsCount`, `category`, `approachedAt: null`, `lastReportId: null`, plus `listId` when the import named a saved list. Dedupe: rows whose normalized phone (libphonenumber-js E.164) or email already exist in the sub-account are skipped + reported back. Equality-only Firestore queries — no composite index.

## Save as list (Prospecting gate)

With `prospectingEnabledByAgency` on, the results bar shows **Save as list**: it `POST`s `/api/sub-accounts/[id]/prospecting/lists` with `{ name, query {businessType, placeName, lat, lng, radiusKm}, count }` (name derived as "<type> — <place>") and remembers the returned id. Every import from that result set then sends `listId`, which the import route accepts only while the Prospecting gate is on (else 403 `gate_off`) and only for a list whose `subAccountId` is this sub-account (else a non-enumerating 404). A new search clears the saved list id. Lists show under Sidebar → Prospecting. Imports without a `listId` need only the Get Leads gate.

**The follow-up loop (why the tag matters):** imports fire the `contact.created` workflow trigger with the tags already on the contact, so the intended pattern is: Workflows → new workflow → trigger `contact.created` + filter `has_tag <batch tag>` (or `source_is get-leads` for all imports) → email/SMS/wait/task steps. The same tag drives Broadcasts audiences and Outbound Voice campaign audiences (`BroadcastAudienceFilter` by tag).

## UI niceties

Amber map pins + a "No website" filter chip mark businesses **without a website** (a strong signal for web/SEO sellers, still useful context for everyone else — copy is deliberately service-neutral). "Has email" chip filters to directly-contactable rows. Clicking a pin toggles selection (indigo ring), same as the list checkboxes. Already-imported rows show a green check and drop out of selection.

## Key files

Types `src/types/get-leads.ts`; Places client `src/lib/get-leads/places.ts` (search + page cap + defensive normalization); homepage email/social lookup `src/lib/get-leads/enrich.ts`; picklist/limits `src/lib/get-leads/business-types.ts`; geo `src/lib/get-leads/geo.ts`; routes under `src/app/api/sub-accounts/[id]/get-leads/`; page `src/app/(dashboard)/sa/[subAccountId]/get-leads/page.tsx`; map `src/components/get-leads/get-leads-map.tsx`.

## What's intentionally NOT in v1

- **Persisted result sets** — the businesses themselves are still ephemeral; a saved list records the search and its size, not the rows. Re-running a search spends more of the daily call quota.
- **Free-text category search at search time** — the picklist doubles as the query allowlist. Custom service types cover the gap: an admin saves the label once (Manage dialog) and it becomes a picklist entry; ad-hoc unsaved queries stay impossible.
- **Auto-import or dedupe-merge** — import is explicit selection; duplicates are skipped, not merged.
- **Email verification** — homepage emails are as-found; no validity scoring.
- **Per-sub-account Places keys or usage quotas** — one agency key; the gate plus the project's daily cap are the cost control.

