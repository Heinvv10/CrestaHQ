import "server-only";

/**
 * In-memory cache of decoded logos for the public logo route, keyed by
 * scope + id + the STORED version. An entry is written only from a read that
 * found that version, so a request for `?v=<new upload>` can never hit bytes
 * of an older one; a request for an older `?v` may get that older version's
 * bytes for up to the TTL (which is what its URL always meant).
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
}

interface Entry extends CachedLogo {
  storedAt: number;
}

const entries = new Map<string, Entry>();
let totalBytes = 0;

const keyOf = (scope: string, id: string, version: string) => `${scope}|${id}|${version}`;

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  totalBytes -= entry.body.length;
  entries.delete(key);
}

/** The cached logo for exactly this version, or null when absent or expired. */
export function getCachedLogo(scope: string, id: string, version: string | null): CachedLogo | null {
  if (version === null) return null;
  const key = keyOf(scope, id, version);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= LOGO_CACHE_TTL_MS) {
    drop(key);
    return null;
  }
  return entry;
}

export function cacheLogo(scope: string, id: string, version: string, logo: CachedLogo): void {
  const key = keyOf(scope, id, version);
  drop(key);
  entries.set(key, { ...logo, storedAt: Date.now() });
  totalBytes += logo.body.length;
  while (totalBytes > LOGO_CACHE_MAX_BYTES) drop(entries.keys().next().value!);
}

/** For the bound test. */
export const logoCacheStats = () => ({ entries: entries.size, bytes: totalBytes });
