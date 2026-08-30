import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { TrafficSource } from "@/lib/landing/traffic-source";

/**
 * Durable attribution rollup for the landing funnel. The live-visitor
 * globe (`liveVisitors/*`) is real-time only — its docs expire after
 * ~30s, so it keeps no history of WHERE clicks came from. These two
 * server-written aggregates fill that gap:
 *
 *   - `landingSources/{sourceKey}` — by channel (YouTube, Google, Direct…)
 *   - `landingGeo/{countryCode}`   — by country, with a nested `cities` map
 *
 * Each carries a `{ views, clicks, purchases }` funnel so the dashboard
 * can show not just where clicks originate but which sources/regions
 * actually convert. Incremented once per session per stage:
 *   - view     → first heartbeat of a new session
 *   - click    → the session's first Buy click
 *   - purchase → the Stripe webhook, matched back by session id
 *
 * Reused geo: we never spend an extra ipapi.co lookup here — the country
 * was already resolved by the heartbeat's first-ping geo call and is
 * passed in. Writes use the Admin SDK so they bypass Firestore rules
 * (the collections are server-only; the dashboard reads them server-side).
 *
 * Best-effort by contract: callers wrap these in try/catch and swallow —
 * a rollup miscount must never break a heartbeat or a purchase.
 */

export type LandingFunnelStage = "views" | "clicks" | "purchases";

export interface GeoBucket {
  countryCode: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
}

/** Sanitize a city name for use as a Firestore map KEY (not a field path,
 *  so dots are fine, but we still trim + cap length). Empty → null. */
function cityKey(city: string | null): string | null {
  if (!city) return null;
  const trimmed = city.trim().slice(0, 60);
  return trimmed || null;
}

/** Country docs are keyed by ISO code; fall back to a sentinel so
 *  unresolved-geo visits still aggregate somewhere instead of vanishing. */
function countryDocId(code: string | null): string {
  if (!code) return "ZZ";
  const upper = code.toUpperCase().replace(/[^A-Z]/g, "");
  return /^[A-Z]{2}$/.test(upper) ? upper : "ZZ";
}

/**
 * Increment one funnel stage against both the source and geo rollups.
 * A single call covers a view/click/purchase for one session.
 */
export async function bumpLandingAttribution(
  db: Firestore,
  stage: LandingFunnelStage,
  source: TrafficSource,
  geo: GeoBucket,
): Promise<void> {
  const inc = FieldValue.increment(1);
  const now = FieldValue.serverTimestamp();

  // --- Source rollup ---
  const sourceRef = db.doc(`landingSources/${source.key}`);
  const sourceWrite = sourceRef.set(
    {
      key: source.key,
      label: source.label,
      [stage]: inc,
      updatedAt: now,
    },
    { merge: true },
  );

  // --- Geo rollup (country doc + nested city map) ---
  const geoId = countryDocId(geo.countryCode);
  const geoRef = db.doc(`landingGeo/${geoId}`);
  const city = cityKey(geo.city);
  const geoPayload: Record<string, unknown> = {
    countryCode: geoId,
    country: geo.country ?? null,
    lat: typeof geo.lat === "number" ? geo.lat : null,
    lng: typeof geo.lng === "number" ? geo.lng : null,
    [stage]: inc,
    updatedAt: now,
  };
  if (city) {
    // Nested object literal (not a dotted field path) so a city name
    // containing a "." can't be misread as a sub-field. merge:true
    // deep-merges the map and the increment applies to the leaf.
    geoPayload.cities = { [city]: { [stage]: inc } };
  }
  const geoWrite = geoRef.set(geoPayload, { merge: true });

  await Promise.all([sourceWrite, geoWrite]);
}
