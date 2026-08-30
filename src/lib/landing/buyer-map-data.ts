import "server-only";

import { unstable_cache } from "next/cache";
import { getAdminDb } from "@/lib/firebase/admin";
import { COUNTRY_META } from "@/lib/geo/country-meta";
import {
  BUYER_MAP_DATA_TAG,
  BUYER_MAP_REVALIDATE_SECONDS,
} from "@/lib/landing/buyer-map-cache";

/**
 * Server-side aggregate powering the landing "Buyer World Map". Groups the
 * `purchases` collection by country + city and returns a PRIVACY-SAFE payload:
 * an intensity `tier` (1–5) per country/city, NEVER raw buyer counts. The
 * choropleth gradient + dot sizes read the tier; the leaderboard reads the
 * server-sorted rank order. Because exact counts never leave the server, the
 * "don't reveal how many buyers per country" requirement holds at the data
 * layer (devtools can't dig them out of the response either).
 *
 * Cost model (see project memory): the landing is high-traffic but purchases
 * are rare, so this is wrapped in unstable_cache with a long safety-net
 * revalidate and the `buyer-map` tag — the page reads it from the Data Cache
 * (0 Firestore reads) between purchases, and the webhook busts the tag on each
 * new buyer. One scan per new purchase, independent of landing traffic.
 *
 * Buyers with null geo (manual/offline, legacy, local-dev) are silently
 * excluded — they can't be placed. Seed entries from LANDING_SEED_PURCHASES
 * (the same env the sales popup uses) are folded in so the map isn't empty
 * before real production buyers accrue.
 */

export interface BuyerMapCity {
  city: string;
  lat: number;
  lng: number;
  /** 1–5 intensity bucket. No raw count. */
  tier: number;
}

export interface BuyerMapCountry {
  /** ISO-3166 alpha-2. */
  code: string;
  /** ISO-3166 alpha-3 — the key into public/geo/world-countries.geojson. */
  a3: string;
  name: string;
  continent: string;
  /** 1–5 intensity bucket. No raw count. */
  tier: number;
  /** Buyer cities, rank order (densest first), each already count-free. */
  cities: BuyerMapCity[];
}

export interface BuyerMapData {
  totals: { continents: number; countries: number; cities: number };
  /** Countries with ≥1 buyer, sorted densest → sparsest (leaderboard rank). */
  countries: BuyerMapCountry[];
}

const EMPTY: BuyerMapData = {
  totals: { continents: 0, countries: 0, cities: 0 },
  countries: [],
};

interface CityAgg {
  count: number;
  latSum: number;
  lngSum: number;
  coordN: number;
}
interface CountryAgg {
  count: number;
  cities: Map<string, CityAgg>;
}

/** Parse LANDING_SEED_PURCHASES into {city, country} pairs (timing ignored). */
function parseSeed(raw: string | undefined): { city: string; country: string }[] {
  if (!raw) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out: { city: string; country: string }[] = [];
  for (const e of entries as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const city = typeof e.city === "string" ? e.city.trim() : "";
    const country = typeof e.country === "string" ? e.country.trim() : "";
    if (!country) continue;
    out.push({ city, country });
  }
  return out;
}

/**
 * Build a count → tier(1–5) mapper from a distribution, using rank position so
 * the colour ramp spreads sensibly regardless of skew (one dominant country
 * doesn't wash everything else to the floor).
 */
function makeTierFn(counts: number[]): (n: number) => number {
  if (counts.length <= 1) return () => 3;
  const sorted = [...counts].sort((a, b) => a - b);
  const span = sorted.length - 1;
  return (n) => {
    let idx = sorted.findIndex((v) => v >= n);
    if (idx < 0) idx = span;
    const frac = idx / span; // 0..1
    return Math.min(5, Math.max(1, Math.round(frac * 4) + 1));
  };
}

/** Deterministic small jitter (deg) from a string, so coordinate-less seed
 *  cities don't all stack on the country centroid. */
function jitter(seed: string): [number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const a = ((h & 0xff) / 255 - 0.5) * 6; // ±3°
  const b = (((h >> 8) & 0xff) / 255 - 0.5) * 6;
  return [a, b];
}

async function aggregate(minCityBuyers: number): Promise<BuyerMapData> {
  const byCountry = new Map<string, CountryAgg>();

  const bump = (
    rawCountry: string,
    rawCity: string,
    lat: number | null,
    lng: number | null,
  ) => {
    const code = rawCountry.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !COUNTRY_META[code]) return; // unplaceable
    let c = byCountry.get(code);
    if (!c) {
      c = { count: 0, cities: new Map() };
      byCountry.set(code, c);
    }
    c.count++;
    const city = rawCity.trim();
    if (!city) return;
    let ca = c.cities.get(city);
    if (!ca) {
      ca = { count: 0, latSum: 0, lngSum: 0, coordN: 0 };
      c.cities.set(city, ca);
    }
    ca.count++;
    if (typeof lat === "number" && typeof lng === "number") {
      ca.latSum += lat;
      ca.lngSum += lng;
      ca.coordN++;
    }
  };

  try {
    const snap = await getAdminDb().collection("purchases").get();
    for (const doc of snap.docs) {
      const d = doc.data();
      const country = typeof d.country === "string" ? d.country : "";
      if (!country) continue;
      const city = typeof d.city === "string" ? d.city : "";
      const lat = typeof d.lat === "number" ? d.lat : null;
      const lng = typeof d.lng === "number" ? d.lng : null;
      bump(country, city, lat, lng);
    }
  } catch (err) {
    console.error("[buyer-map-data] purchases scan failed", err);
    // Fall through — seed entries (if any) can still populate the map.
  }

  for (const { city, country } of parseSeed(process.env.LANDING_SEED_PURCHASES)) {
    bump(country, city, null, null);
  }

  if (byCountry.size === 0) return EMPTY;

  // Country tiers from the country-count distribution.
  const countryTier = makeTierFn(
    [...byCountry.values()].map((c) => c.count),
  );
  // City tiers from the pooled city-count distribution across all countries.
  const allCityCounts: number[] = [];
  for (const c of byCountry.values()) {
    for (const ca of c.cities.values()) {
      if (ca.count >= minCityBuyers) allCityCounts.push(ca.count);
    }
  }
  const cityTier = makeTierFn(allCityCounts);

  const continents = new Set<string>();
  let cityCount = 0;

  const countries: BuyerMapCountry[] = [...byCountry.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([code, agg]) => {
      const meta = COUNTRY_META[code];
      continents.add(meta.continent);
      const cities: BuyerMapCity[] = [...agg.cities.entries()]
        .filter(([, ca]) => ca.count >= minCityBuyers)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, ca]) => {
          let lat: number;
          let lng: number;
          if (ca.coordN > 0) {
            lat = ca.latSum / ca.coordN;
            lng = ca.lngSum / ca.coordN;
          } else {
            const [dlat, dlng] = jitter(name);
            lat = meta.lat + dlat;
            lng = meta.lng + dlng;
          }
          return { city: name, lat, lng, tier: cityTier(ca.count) };
        });
      cityCount += cities.length;
      return {
        code,
        a3: meta.a3,
        name: meta.name,
        continent: meta.continent,
        tier: countryTier(agg.count),
        cities,
      };
    });

  return {
    totals: {
      continents: continents.size,
      countries: countries.length,
      cities: cityCount,
    },
    countries,
  };
}

/**
 * Cached entry point. minCityBuyers is part of the cache key (a threshold
 * change produces a distinct aggregate); the `buyer-map` tag busts every
 * variant on a new purchase or a config save.
 */
export async function getBuyerMapData(
  minCityBuyers: number,
): Promise<BuyerMapData> {
  const cached = unstable_cache(
    () => aggregate(minCityBuyers),
    ["buyer-map-data", String(minCityBuyers)],
    { tags: [BUYER_MAP_DATA_TAG], revalidate: BUYER_MAP_REVALIDATE_SECONDS },
  );
  return cached();
}

/**
 * Total collective savings vs GoHighLevel = (all purchases) × annualPerBuyer.
 *
 * PRIVACY: this returns ONLY the dollar figure — the buyer count is counted and
 * multiplied entirely server-side and never returned or sent to the client, and
 * the per-buyer assumption is not published on the page, so the total can't be
 * divided back into a headcount. Counts ALL purchases (incl. no-geo/manual) +
 * seed entries, consistent with the map's other sources.
 */
async function computeSavings(annualPerBuyer: number): Promise<number> {
  let count = 0;
  try {
    const agg = await getAdminDb().collection("purchases").count().get();
    count = agg.data().count;
  } catch (err) {
    console.error("[buyer-map-data] buyer count failed", err);
  }
  count += parseSeed(process.env.LANDING_SEED_PURCHASES).length;
  return count * Math.max(0, annualPerBuyer);
}

export async function getBuyerSavings(annualPerBuyer: number): Promise<number> {
  const cached = unstable_cache(
    () => computeSavings(annualPerBuyer),
    ["buyer-map-savings", String(annualPerBuyer)],
    { tags: [BUYER_MAP_DATA_TAG], revalidate: BUYER_MAP_REVALIDATE_SECONDS },
  );
  return cached();
}
