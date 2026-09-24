# Prospecting PR 1 — local browser walk (2026-09-24)

Local dev build of `feat/get-leads-places` (stacked on `feat/prospecting-foundation`), E2E Fixture Agency, sub-account #1000 "E2E Fixture Primary". No customer data in these images; the search results table (real public business listings) was deliberately not captured.

1. `01-manage-dialog-gates.png` — Manage dialog: Get Leads + Prospecting ticked, monthly report quota showing the default 50. Saved → Firestore `getLeadsEnabledByAgency: true`, `prospectingEnabledByAgency: true`, quota not written (not edited).
2. Get Leads: Plumbers, typed "Gqeberha" (server-side geocode, no Mapbox token), 10 km, max 10 → 10 results. "Save as list" → `prospectLists` doc with agencyId / subAccountId / createdByUid and `query {businessType: plumber, placeName: "Gqeberha, South Africa", lat, lng, radiusKm: 10}`, count 10. Imported 2 rows → 2 contacts with `source: "prospecting"`, tags `["prospecting", "plumber-gqeberha-south-africa"]`, and `prospecting {listId: <the list>, placeId, website, rating, reviewsCount, category: "Plumber", approachedAt: null, lastReportId: null}`.
3. `02-prospecting-saved-list.jpg` — Sidebar → Prospecting shows the saved list.
4. Cleanup: both contacts deleted through `DELETE /api/contacts/[id]`, the list doc deleted, both gates switched off via the feature-gates PATCH route. `03-prospecting-locked.jpg` — the locked state with the gate off.
