/**
 * Get Leads v1 — the curated business-type picklist. Client-safe (no
 * server-only import): the page renders these as the category select and the
 * search route validates the submitted value against the same list, so a
 * forged request can't run arbitrary Outscraper queries on the agency's key.
 *
 * `query` is the term sent to Google Maps search — kept plural/colloquial
 * because that's what ranks best in Maps results.
 */

/**
 * PARKED master switch. While `true`, every user-facing surface hides the
 * feature: the sidebar entry, the Manage-dialog gate toggle, the Agency
 * Assistant's gate capability, and the assistant knowledge card. The page,
 * API routes, and `getLeadsEnabledByAgency` gate stay intact but unreachable
 * (the gate defaults off and nothing surfaces a way to flip it). To un-park:
 * flip this to `false` AND restore the Outscraper group in
 * `src/lib/setup/env-schema.mjs` + the OUTSCRAPER_API_KEY block in
 * `.env.example` (those can't read this flag). Typed `boolean` on purpose so
 * TS doesn't narrow the dead branches into unused-import lint errors.
 */
export const GET_LEADS_PARKED: boolean = true;
export interface BusinessType {
  value: string;
  label: string;
  query: string;
}

export const BUSINESS_TYPES: BusinessType[] = [
  { value: "restaurant", label: "Restaurants", query: "restaurants" },
  { value: "cafe", label: "Cafes & coffee shops", query: "cafes" },
  { value: "dentist", label: "Dentists", query: "dentists" },
  { value: "law-firm", label: "Law firms", query: "law firms" },
  { value: "accounting", label: "Accounting firms", query: "accounting firms" },
  { value: "real-estate", label: "Real estate agencies", query: "real estate agencies" },
  { value: "plumber", label: "Plumbers", query: "plumbers" },
  { value: "electrician", label: "Electricians", query: "electricians" },
  { value: "roofing", label: "Roofing contractors", query: "roofing contractors" },
  { value: "hvac", label: "HVAC services", query: "HVAC services" },
  { value: "landscaping", label: "Landscaping & lawn care", query: "landscaping services" },
  { value: "cleaning", label: "Cleaning services", query: "cleaning services" },
  { value: "auto-repair", label: "Auto repair shops", query: "auto repair shops" },
  { value: "gym", label: "Gyms & fitness studios", query: "gyms" },
  { value: "salon", label: "Hair & beauty salons", query: "hair salons" },
  { value: "chiropractor", label: "Chiropractors", query: "chiropractors" },
  { value: "vet", label: "Veterinary clinics", query: "veterinary clinics" },
  { value: "physio", label: "Physiotherapy clinics", query: "physiotherapy clinics" },
  { value: "photographer", label: "Photographers", query: "photographers" },
  { value: "builder", label: "Builders & renovations", query: "building contractors" },
];

export function businessTypeByValue(value: string): BusinessType | undefined {
  return BUSINESS_TYPES.find((t) => t.value === value);
}

/**
 * Custom service types — operator-defined additions to the curated list,
 * stored as plain labels on `subAccountDoc.getLeadsCustomTypes` (managed by
 * PUT /api/sub-accounts/[id]/get-leads/types, sub-account admin only). The
 * label doubles as the Google Maps query; the value gets a "custom:" prefix
 * so it can never collide with (or spoof) a curated entry.
 */
export const GET_LEADS_MAX_CUSTOM_TYPES = 30;
export const GET_LEADS_CUSTOM_TYPE_MAX_LEN = 60;

export function slugifyBusinessType(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, GET_LEADS_CUSTOM_TYPE_MAX_LEN);
}

export function customBusinessTypes(labels: string[]): BusinessType[] {
  return labels
    .filter((l) => typeof l === "string" && l.trim())
    .map((l) => ({
      value: `custom:${slugifyBusinessType(l)}`,
      label: l.trim(),
      query: l.trim(),
    }));
}

/**
 * Resolve a submitted businessType value against the curated list PLUS the
 * sub-account's stored custom labels — together they form the server-side
 * query allowlist (a forged request still can't run arbitrary text on the
 * agency's Outscraper key; custom entries had to be saved by an admin first).
 */
export function resolveBusinessType(
  value: string,
  customLabels: string[],
): BusinessType | undefined {
  return (
    businessTypeByValue(value) ??
    customBusinessTypes(customLabels).find((t) => t.value === value)
  );
}

/** Radius options in km. Also validated server-side. */
export const RADIUS_OPTIONS_KM = [1, 5, 10, 25, 50] as const;
export type RadiusKm = (typeof RADIUS_OPTIONS_KM)[number];

/**
 * Operator-selectable per-search result caps. Outscraper's `limit` param
 * bounds both the returned businesses AND the enrichment spend, so this is
 * the per-run credit budget — a search can never return (or bill for) more
 * than the picked value. Also validated server-side.
 */
export const RESULT_LIMIT_OPTIONS = [10, 20, 40] as const;

/** Hard ceiling per search (largest picker option; also the import batch cap). */
export const GET_LEADS_RESULT_LIMIT = 40;
