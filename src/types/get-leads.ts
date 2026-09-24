/**
 * Get Leads (EXPERIMENTAL) — the normalized business listing returned by the
 * search route and consumed by the page, map, and import route.
 * Ephemeral wire format only: search results are never persisted (imports
 * create ordinary contacts).
 */
export interface GetLeadsBusiness {
  /** Google Places id (or a synthesized fallback) — stable row key for selection. */
  placeId: string;
  /** Google Places `id` when the row carried one; null when `placeId` is synthesized. */
  googlePlaceId: string | null;
  name: string;
  category: string | null;
  fullAddress: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  facebook: string | null;
  instagram: string | null;
  rating: number | null;
  reviewsCount: number | null;
  latitude: number | null;
  longitude: number | null;
}
