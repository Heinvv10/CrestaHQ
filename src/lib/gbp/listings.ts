import type { GoogleListing } from "@/types/google";

/**
 * The listings a sub-account manages (MULTI_LISTING_V1_PLAN.md): the MAIN
 * listing (`googleListing`) plus the extras (`googleExtraListings`). Pure, so
 * scripts can use it too. Always derived from the two listing fields, never
 * from the flat `googleLocationNames` array — docs written before it existed
 * have no array.
 */

export const MAX_EXTRA_LISTINGS = 9;

export interface ListingFields {
  googleListing?: GoogleListing | null;
  googleExtraListings?: GoogleListing[];
}

/** `locations/{id}` → `{id}` — `[A-Za-z0-9_-]` per LOCATION_NAME_RE, a safe map key. */
export function locId(locationName: string): string {
  return locationName.slice("locations/".length);
}

/** `[main, ...extras]` in stored order; none without a listing. */
export function allListings(sub: ListingFields): GoogleListing[] {
  return [...(sub.googleListing ? [sub.googleListing] : []), ...(sub.googleExtraListings ?? [])];
}

export function locationNamesOf(sub: ListingFields): string[] {
  return allListings(sub).map((l) => l.locationName);
}

export function listingFor(sub: ListingFields, locationName: string): GoogleListing | null {
  return allListings(sub).find((l) => l.locationName === locationName) ?? null;
}

export function isMain(sub: ListingFields, locationName: string): boolean {
  return sub.googleListing?.locationName === locationName;
}
