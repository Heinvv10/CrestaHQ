import { FieldValue } from "firebase-admin/firestore";
import { locId, type ListingFields } from "../listings";
import type { GbpSummary } from "./types";

/**
 * Which listing a sync, retention pass or cache clear works on
 * (MULTI_LISTING_V1_PLAN.md H2/H3). `extra: null` is the MAIN listing: the
 * legacy paths (`private/gbpSyncState`, `gbpSummary`), and its cache is every
 * review doc that does not belong to a CURRENT extra listing — so a
 * sub-account without extras keeps exactly today's paths and whole-collection
 * cache (a failed clear's leftovers included, so retention still reaches
 * them). But only the main listing's OWN docs (or docs with no
 * `locationName`) are reconciled — see {@link reconcilesDoc}: an orphan from
 * a removed listing is never miss-counted or tombstoned, only purged. An
 * extra listing has its own state doc, `gbpSummaries.{locId}`, and only its
 * own docs: a pass of one listing can never miss-count, tombstone or purge
 * another's reviews.
 */
export interface ListingScope {
  /** The EXTRA listing's location name; null = the main listing. */
  extra: string | null;
  /** The sub-account's current extra listings (never the main). */
  extras: string[];
  /** The main listing's location name, if any. */
  main: string | null;
}

export type WithSummaries = ListingFields & {
  gbpSummary?: GbpSummary | null;
  gbpSummaries?: Record<string, GbpSummary>;
};

/** The current extras' location names, derived from the listing fields (never the flat array). */
export function extraLocationNames(sub: ListingFields): string[] {
  const main = sub.googleListing?.locationName;
  return (sub.googleExtraListings ?? []).map((l) => l.locationName).filter((n) => n !== main);
}

export function scopeOf(sub: ListingFields, extra: string | null): ListingScope {
  return { extra, extras: extraLocationNames(sub), main: sub.googleListing?.locationName ?? null };
}

/** Whether a cached review doc (by its `locationName`) belongs to this scope's cache. */
export function ownsDoc(scope: ListingScope, docLocationName: unknown): boolean {
  if (scope.extra !== null) return docLocationName === scope.extra;
  return !scope.extras.includes(docLocationName as string);
}

/**
 * Whether a doc this scope owns is also RECONCILED by its passes (miss
 * counts, tombstones, the anomaly brake): the listing's own docs, and for the
 * main listing also docs with no `locationName`. Retention covers every
 * owned doc.
 */
export function reconcilesDoc(scope: ListingScope, docLocationName: unknown): boolean {
  if (scope.extra !== null) return docLocationName === scope.extra;
  return docLocationName == null || docLocationName === scope.main;
}

/** The listing's stored summary: `gbpSummary` for main, `gbpSummaries.{locId}` for an extra. */
export function summaryIn(sub: WithSummaries, extra: string | null): GbpSummary | null {
  return extra === null ? (sub.gbpSummary ?? null) : (sub.gbpSummaries?.[locId(extra)] ?? null);
}

/** The merge-set patch that writes (or, with null, drops) the listing's summary. */
export function summaryPatch(extra: string | null, summary: GbpSummary | null): Record<string, unknown> {
  if (extra === null) return { gbpSummary: summary };
  return { gbpSummaries: { [locId(extra)]: summary ?? FieldValue.delete() } };
}
