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
/** How long an `in_progress` reservation holds a key without a heartbeat
 *  before a new request may take it over (a process that died mid-request
 *  must not block it). */
export const IN_PROGRESS_TTL_MS = 60 * 1000;
/** A running request extends its reservation this often, so only a dead
 *  process's reservation ever reaches IN_PROGRESS_TTL_MS. */
export const HEARTBEAT_MS = 20 * 1000;
/** The heartbeat stops after this long, so a request that hangs forever
 *  ages into a takeover instead of holding the key forever. */
export const MAX_HOLD_MS = 10 * 60 * 1000;
/** Pauses before the 2nd and 3rd attempt to store an outcome. */
const STORE_RETRY_DELAYS_MS = [100, 300];
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
      /** The handler ran but its outcome can't be stored: mark done_unknown. */
      markUnknown: () => Promise<void>;
    }
  /** A finished request with this key and body: return its stored response. */
  | { kind: "replay"; cached: CachedResponse }
  /** A request with this key and body is still running: retry shortly. */
  | { kind: "in_progress" }
  /** A request with this key and body finished, but its outcome could not be
   *  stored: it may have taken effect, so it must never run again. */
  | { kind: "outcome_unknown" }
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
 * While the handler runs a heartbeat extends the reservation (for at most
 * MAX_HOLD_MS), so a takeover only hits a dead or hung process. `store` retries, and if the outcome still
 * can't be stored it marks the key `done_unknown`: a later request with it
 * gets outcome_unknown and never re-runs an action that may have happened.
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
    const pending = data?.state === "in_progress" || data?.state === "done_unknown";
    // A done doc without a numeric status can't be replayed: treat it as absent.
    const live =
      !!data && !!expiresAt && expiresAt.getTime() > Date.now() &&
      (pending || typeof data.status === "number");
    if (live) {
      if (data!.requestFingerprint !== requestFingerprint) return { kind: "collision" as const };
      if (data!.state === "in_progress") return { kind: "in_progress" as const };
      if (data!.state === "done_unknown") return { kind: "outcome_unknown" as const };
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
  const whileOurs = (write: (tx: FirebaseFirestore.Transaction) => void, onlyInProgress = false) =>
    db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      if (data?.reservationId !== reservationId) return;
      if (onlyInProgress && data.state !== "in_progress") return;
      write(tx);
    });
  // Heartbeat: while the handler runs, keep the reservation from ageing into
  // a takeover. A failed beat is logged, never fatal to the request.
  const heldSince = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - heldSince >= MAX_HOLD_MS) return clearInterval(heartbeat);
    whileOurs(
      (tx) => tx.update(ref, { expiresAt: new Date(Date.now() + IN_PROGRESS_TTL_MS) }),
      true,
    ).catch((err) => console.warn("[api/v1] idempotency heartbeat failed", err));
  }, HEARTBEAT_MS);

  const storeOnce = (entry: { status: number; bodyJson: unknown }) =>
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
    );
  const writeUnknown = () =>
    whileOurs((tx) =>
      tx.update(ref, { state: "done_unknown", expiresAt: new Date(Date.now() + CACHE_TTL_MS) }),
    );
  // store / release / markUnknown are idempotent: only the first call of any acts.
  let settled = false;
  return {
    kind: "reserved",
    // Never throws: the handler already ran, so the response must go out.
    store: async (entry) => {
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= STORE_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, STORE_RETRY_DELAYS_MS[attempt - 1]));
        try {
          return await storeOnce(entry);
        } catch (err) {
          lastErr = err;
        }
      }
      // The action may have happened: mark the key so a retry is told the
      // outcome is unknown instead of running it again.
      try {
        await writeUnknown();
        console.error("[api/v1] idempotency outcome not stored; key marked done_unknown (unless taken over)", lastErr);
      } catch (err) {
        console.error(
          "[api/v1] idempotency outcome and done_unknown marker both failed; the reservation expires and a retry may re-run",
          lastErr,
          err,
        );
      }
    },
    // Never throws, like store.
    markUnknown: async () => {
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      try {
        await writeUnknown();
        console.error("[api/v1] request failed after its handler ran; key marked done_unknown (unless taken over)");
      } catch (err) {
        console.error(
          "[api/v1] request failed after its handler ran and the done_unknown marker failed; the reservation expires and a retry may re-run",
          err,
        );
      }
    },
    release: async () => {
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      await whileOurs((tx) => tx.delete(ref));
    },
  };
}
