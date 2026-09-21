import { createHash } from "node:crypto";

/**
 * Idempotency-Key with a body-fingerprint suffix. The public API caches any
 * response under 500 against key + a fingerprint of the body; reusing a key
 * with a changed body 409s (`idempotency_collision`) for 24h. Appending a
 * hash of the body means a case whose upstream fields (e.g. contact name)
 * changed between a failed attempt and the retry gets a fresh key instead
 * of being stuck on that collision forever.
 */
export function dedupedIdempotencyKey(prefix: string, body: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}
