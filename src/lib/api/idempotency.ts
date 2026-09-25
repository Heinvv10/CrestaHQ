import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiKeyMode } from "@/types/api";

/**
 * Idempotency cache for the public API.
 *
 * On every POST / PATCH / DELETE that carries an `Idempotency-Key` header,
 * we cache `{status, body}` for 24 hours keyed by
 *   `<subAccountId>_<mode>_<idempotencyKey>`
 *
 * Behaviour (see reserveIdempotencyKey — the key is claimed BEFORE the
 * handler, so concurrent retries run it once):
 *   - Cache MISS  → reserve, run the handler, store the result (or release
 *     the reservation when the outcome isn't stored), return it.
 *   - Reserved by a request still running, same body → 409
 *     idempotency_in_progress (Retry-After: 1).
 *   - Cache HIT, request fingerprint matches → return the stored response.
 *   - Cache HIT, request fingerprint differs → 409 idempotency_error
 *     (same key reused with a different body — almost always a bug, never
 *     silently re-execute since the new body might do something different).
 *
 * Mode-namespaced so a test-mode replay can't ever return a cached live
 * response.
 *
 * Storage: `subAccounts/{id}/apiIdempotency/{docId}` where docId is
 * `<mode>_<keyId>_<sha-of-idempotencyKey>` — keeps the operator-supplied
 * idempotency key out of Firestore doc ids (which would show up in any
 * admin export). Server-only; Firestore rules deny client read/write.
 *
 * Expiry is lazy: we don't run a sweeper, every read checks `expiresAt`
 * against the wall clock. Firestore TTL policies could be configured to
 * auto-delete expired docs (recommended once the API is in production —
 * declare in `firestore.indexes.json` / TTL config).
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an `in_progress` reservation holds a key before a new request
 *  may take it over (a process that died mid-request must not block it). */
export const IN_PROGRESS_TTL_MS = 60 * 1000;
const MAX_KEY_LEN = 255;
const VALID_KEY_RE = /^[A-Za-z0-9_\-:.]+$/;

export interface CachedResponse {
  status: number;
  bodyJson: unknown;
  /**
   * SHA-256 of the original request payload — used to detect "same
   * idempotency key, different body" collisions.
   */
  requestFingerprint: string;
  createdAt: Date;
  expiresAt: Date;
}

export function fingerprintRequest(method: string, path: string, rawBody: string): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${rawBody}`, "utf8")
    .digest("hex");
}

function docIdFor(mode: ApiKeyMode, keyId: string, idempotencyKey: string): string {
  const keyHash = createHash("sha256")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  return `${mode}_${keyId}_${keyHash}`;
}

export function isValidIdempotencyKey(key: string): boolean {
  if (key.length < 1 || key.length > MAX_KEY_LEN) return false;
  return VALID_KEY_RE.test(key);
}

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

function refFor(subAccountId: string, mode: ApiKeyMode, keyId: string, idempotencyKey: string) {
  return getAdminDb()
    .collection("subAccounts")
    .doc(subAccountId)
    .collection("apiIdempotency")
    .doc(docIdFor(mode, keyId, idempotencyKey));
}

/** What reserving an Idempotency-Key found. */
export type IdempotencyReservation =
  /** The key is ours: run the handler, then `store` its outcome or `release`. */
  | {
      kind: "reserved";
      store: (entry: { status: number; bodyJson: unknown }) => Promise<void>;
      release: () => Promise<void>;
    }
  /** A finished request with this key and body: return its stored response. */
  | { kind: "replay"; cached: CachedResponse }
  /** A request with this key and body is still running: retry shortly. */
  | { kind: "in_progress" }
  /** This key was used with a different request body. */
  | { kind: "collision" };

/**
 * Claim an Idempotency-Key BEFORE the handler runs, atomically: a
 * transaction reads the doc and writes an `in_progress` reservation only if
 * there is none (or only an expired one). So of N concurrent requests with
 * the same key exactly one runs the handler; the rest see `in_progress`
 * (same body) or `collision` (different body), and later ones the stored
 * outcome. A reservation expires after IN_PROGRESS_TTL_MS, so a process that
 * died mid-request can't block the key forever — the transaction's re-read
 * makes that takeover conditional on it still being the same stale doc.
 * `store` / `release` act only while the reservation is still this one.
 */
export async function reserveIdempotencyKey(
  subAccountId: string,
  mode: ApiKeyMode,
  keyId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<IdempotencyReservation> {
  const db = getAdminDb();
  const ref = refFor(subAccountId, mode, keyId, idempotencyKey);
  const reservationId = randomBytes(12).toString("hex");
  const found = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const expiresAt = tsToDate(data?.expiresAt);
    const live = !!data && !!expiresAt && expiresAt.getTime() > Date.now();
    if (live) {
      if (data!.requestFingerprint !== requestFingerprint) return { kind: "collision" as const };
      if (data!.state === "in_progress") return { kind: "in_progress" as const };
      return {
        kind: "replay" as const,
        cached: {
          status: data!.status as number,
          bodyJson: data!.bodyJson,
          requestFingerprint,
          createdAt: tsToDate(data!.createdAt) ?? new Date(0),
          expiresAt: expiresAt!,
        },
      };
    }
    tx.set(ref, {
      state: "in_progress",
      reservationId,
      requestFingerprint,
      mode,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + IN_PROGRESS_TTL_MS),
    });
    return { kind: "reserved" as const };
  });
  if (found.kind !== "reserved") return found;

  /** Run `write` only while the doc still holds THIS reservation. */
  const whileOurs = (write: (tx: FirebaseFirestore.Transaction) => void) =>
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.reservationId === reservationId) write(tx);
    });
  return {
    kind: "reserved",
    store: (entry) =>
      whileOurs((tx) =>
        tx.set(ref, {
          state: "done",
          status: entry.status,
          bodyJson: entry.bodyJson,
          requestFingerprint,
          mode,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + CACHE_TTL_MS),
        }),
      ),
    release: () => whileOurs((tx) => tx.delete(ref)),
  };
}
