# Get Leads v1 (EXPERIMENTAL — PARKED)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

> **PARKED (2026-07-07).** The feature is fully built but deliberately hidden from users out of the box via the `GET_LEADS_PARKED` flag in [src/lib/get-leads/business-types.ts](../../src/lib/get-leads/business-types.ts). While parked: no sidebar entry, no Manage-dialog gate toggle, no Agency Assistant gate capability, no assistant KB card, no guided-setup/doctor env group, no `.env.example` entry. The page, API routes, and gate remain intact (the gate defaults off, so nothing is reachable).
>
> **Un-park checklist:** (1) flip `GET_LEADS_PARKED` to `false`; (2) restore the "Get Leads prospecting (Outscraper)" group in `src/lib/setup/env-schema.mjs` (commented inline at the removal site); (3) restore the `OUTSCRAPER_API_KEY` block in `.env.example`; (4) re-add "Get Leads" to the feature-gates KB card body in `src/lib/ai-suite/knowledge-base.ts`; (5) remove the PARKED notes here + in the Core Features bullet + gate table row.

Local-business prospecting per sub-account (positioned generically — "find businesses that might need what you sell", not just web services): pick a **business type** (curated top-20 picklist **plus** the sub-account's own custom service types — the admin-only **Manage services** button in the page header opens a dialog listing EVERY service (customs badged "Custom" + built-ins together); add appends a custom, delete removes a custom or hides a built-in (with a restore link; at least one service must remain). One PUT to `/api/sub-accounts/[id]/get-leads/types` replaces both lists: customs on `subAccountDoc.getLeadsCustomTypes` (≤30 × ≤60 chars, label doubles as the Maps query, value prefixed `custom:` so it can't spoof a curated entry) and deleted built-in values on `getLeadsHiddenTypes` (presentation-only — the search allowlist still accepts curated values)), a **location** (type-ahead Mapbox autocomplete — pick a suggestion to lock exact coordinates + a formatted place name before any credits are spent; unpicked free text falls back to a one-shot geocode at submit; "Use my location" geolocates then reverse-geocodes to a readable place name), and a **radius** (1/5/10/25/50 km) — results render on a clustered **Mapbox map** and an enriched **list** (name, category, phone, email, website, socials, rating, address), and checked rows import as contacts. Sidebar → **Get Leads** at `/sa/[id]/get-leads`; gated by `getLeadsEnabledByAgency` (off by default; supports the hide-override).

## Data flow — async search, ephemeral results

- **Provider: Outscraper** (`OUTSCRAPER_API_KEY`, agency-level). One `GET /google-maps-search` call does the Google Maps search **plus** the `leads_n_contacts` enrichment (emails + Facebook/Instagram pulled from each business's website on Outscraper's side). Enrichment takes **1–3 minutes**, so everything is async: `POST /api/sub-accounts/[id]/get-leads/search` submits the job and returns Outscraper's request id; the client polls `GET .../get-leads/search/[requestId]` every 5s (cap ~5 min) until `Pending → Success/Failure`. No QStash, no serverless-timeout risk — each poll is a quick proxy call.
- **Radius enforcement is ours** — Outscraper's `coordinates` param only anchors the Google Maps search (Google decides spill-over), so the poll route haversine-filters results against the origin + radius (`lib/get-leads/geo.ts`). Businesses returned without coordinates are kept.
- **Results are never persisted.** Navigate away and they're gone; Outscraper keeps them retrievable for ~4h server-side. The only durable output is the import.
- **Query allowlist + spend budget** — the search route only accepts `businessType` values from the curated picklist (`lib/get-leads/business-types.ts`, also the server-side validator), so a forged request can't run arbitrary queries on the agency's key. The operator picks a **Max results** value per search (10/20/40 — `RESULT_LIMIT_OPTIONS`, server-validated, default 20): Outscraper's `limit` bounds both the returned businesses AND the enrichment spend, so it's a hard per-run credit budget (~$0.03–0.20 depending on the pick). `GET_LEADS_RESULT_LIMIT` (40) remains the ceiling + the import batch cap.

## Import → Contacts

`POST /api/sub-accounts/[id]/get-leads/import` loops the selected rows through the shared `createContactServerSide` chokepoint — so `contact.created` webhooks + workflow triggers fire like any other create. Each import: `source: "get-leads"` (cyan badge) + tags `["get-leads", <batch tag>]` — the batch tag is the results bar's editable **"Tag as"** input (pre-filled `<type>-<location>`, slugified server-side, stored WITHOUT a prefix so it matches exactly what the operator picks in workflow-trigger `has_tag` filters / broadcast audiences / voice-campaign audiences), business name as contact name AND company, listing lat/lng onto the contact's location fields (pins land on the dashboard Leads map), and a note carrying the enrichment extras that have no first-class contact field (website, socials, rating, category). Dedupe: rows whose normalized phone (libphonenumber-js E.164) or email already exist in the sub-account are skipped + reported back. Equality-only Firestore queries — no new composite index, no new collections, **no rules deploy needed**.

**The follow-up loop (why the tag matters):** imports fire the `contact.created` workflow trigger with the tags already on the contact, so the intended pattern is: Workflows → new workflow → trigger `contact.created` + filter `has_tag <batch tag>` (or `source_is get-leads` for all imports) → email/SMS/wait/task steps. The same tag drives Broadcasts audiences and Outbound Voice campaign audiences (`BroadcastAudienceFilter` by tag).

## UI niceties

Amber map pins + a "No website" filter chip mark businesses **without a website** (a strong signal for web/SEO sellers, still useful context for everyone else — copy is deliberately service-neutral). "Has email" chip filters to directly-contactable rows. Clicking a pin toggles selection (indigo ring), same as the list checkboxes. Already-imported rows show a green check and drop out of selection.

## Key files

Types `src/types/get-leads.ts`; server client `src/lib/get-leads/outscraper.ts` (submit + poll + defensive normalization); picklist/limits `src/lib/get-leads/business-types.ts`; geo `src/lib/get-leads/geo.ts`; routes under `src/app/api/sub-accounts/[id]/get-leads/`; page `src/app/(dashboard)/sa/[subAccountId]/get-leads/page.tsx`; map `src/components/get-leads/get-leads-map.tsx`.

## What's intentionally NOT in v1

- **Saved lead lists / search history** — results are ephemeral; re-running a search re-spends credits. v2 could persist result sets.
- **Free-text category search at search time** — the picklist doubles as the query allowlist. Custom service types cover the gap: an admin saves the label once (Manage dialog) and it becomes a picklist entry; ad-hoc unsaved queries stay impossible.
- **Auto-import or dedupe-merge** — import is explicit selection; duplicates are skipped, not merged.
- **Email verification** — enrichment emails are as-scraped; no validity scoring.
- **Per-sub-account Outscraper keys or usage quotas** — one agency key, gate = the cost control.

