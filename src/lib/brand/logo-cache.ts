import "server-only";

/**
 * In-memory cache of decoded logos for the public logo route: ONE entry per
 * tenant (scope + id), holding the latest bytes a read found and their
 * stored version. The route serves it as immutable only to a request whose
 * `?v` equals that version; no `?v`, or an older or non-numeric one, gets
 * the same bytes with the short cache-control. A `?v` NEWER than the entry
 * means a re-upload this instance hasn't read yet, so it is a miss and
 * reads, never older bytes under the new URL.
 *
 * Exists for shared-IP prefetchers (Apple Mail Privacy Protection fetches a
 * broadcast's images through a few proxy addresses): a hit costs no
 * Firestore read and is not rate-limited. Bounded by total bytes, oldest
 * entry evicted first; per instance, lost on restart.
 */

export const LOGO_CACHE_TTL_MS = 60 * 1000;
export const LOGO_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export interface CachedLogo {
  body: Buffer<ArrayBuffer>;
  mime: "image/png" | "image/webp";
  /** The stored version (upload ms) these bytes were read at. */
  version: number;
}

interface Entry extends CachedLogo {
  storedAt: number;
}

const entries = new Map<string, Entry>();
let totalBytes = 0;
/** Bumped by dropCachedLogo: a read that began before a bump must not re-cache. */
const generations = new Map<string, number>();

const keyOf = (scope: string, id: string) => `${scope}|${id}`;

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.body.length;
  entries.delete(key);
}

/** The tenant's cached logo, or null when absent or expired. */
export function getCachedLogo(scope: string, id: string): CachedLogo | null {
  const key = keyOf(scope, id);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= LOGO_CACHE_TTL_MS) {
    drop(key);
    return null;
  }
  return entry;
}

/** Capture before a read; pass to cacheLogo / cacheMissingLogo after it. */
export function logoCacheGeneration(scope: string, id: string): number {
  return generations.get(keyOf(scope, id)) ?? 0;
}

/**
 * Cache what a read found, unless the tenant's logo changed (an upload or a
 * remove on this instance) while that read was in flight: its bytes may be
 * the old logo, and caching them would undo the drop.
 */
export function cacheLogo(scope: string, id: string, logo: CachedLogo, generation: number): void {
  const key = keyOf(scope, id);
  if ((generations.get(key) ?? 0) !== generation) return;
  drop(key);
  entries.set(key, { ...logo, storedAt: Date.now() });
  totalBytes += logo.body.length;
  while (totalBytes > LOGO_CACHE_MAX_BYTES) drop(entries.keys().next().value!);
}

/**
 * Forget a tenant's entry after an upload or a remove, so THIS instance
 * serves the new state on the next request. Other instances may serve their
 * own entry until its TTL runs out.
 */
export function dropCachedLogo(scope: string, id: string): void {
  const key = keyOf(scope, id);
  drop(key);
  missing.delete(key);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

/**
 * Negative cache: tenants whose logo doc a read found absent, for
 * LOGO_MISSING_TTL_MS, so repeat requests for a removed or never-uploaded
 * logo 404 without a read. Bounded by count, oldest first; the same
 * generation rule as cacheLogo applies.
 */
export const LOGO_MISSING_TTL_MS = 10 * 1000;
export const LOGO_MISSING_MAX_KEYS = 10_000;
const missing = new Map<string, number>();

export function isKnownMissingLogo(scope: string, id: string): boolean {
  const key = keyOf(scope, id);
  const at = missing.get(key);
  if (at === undefined) return false;
  if (Date.now() - at >= LOGO_MISSING_TTL_MS) {
    missing.delete(key);
    return false;
  }
  return true;
}

export function cacheMissingLogo(scope: string, id: string, generation: number): void {
  const key = keyOf(scope, id);
  if ((generations.get(key) ?? 0) !== generation) return;
  missing.delete(key);
  missing.set(key, Date.now());
  while (missing.size > LOGO_MISSING_MAX_KEYS) missing.delete(missing.keys().next().value!);
}

/** Whether `requested` (a `?v`) names a version after `cached`, i.e. an upload not yet read. */
export function isNewerVersion(requested: string | null, cached: number): boolean {
  return requested !== null && /^\d{1,16}$/.test(requested) && Number(requested) > cached;
}

/** For the bound test. */
export const logoCacheStats = () => ({ entries: entries.size, bytes: totalBytes, missing: missing.size });
