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

export function cacheLogo(scope: string, id: string, logo: CachedLogo): void {
  const key = keyOf(scope, id);
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
  drop(keyOf(scope, id));
}

/** Whether `requested` (a `?v`) names a version after `cached`, i.e. an upload not yet read. */
export function isNewerVersion(requested: string | null, cached: number): boolean {
  return requested !== null && /^\d{1,16}$/.test(requested) && Number(requested) > cached;
}

/** For the bound test. */
export const logoCacheStats = () => ({ entries: entries.size, bytes: totalBytes });
