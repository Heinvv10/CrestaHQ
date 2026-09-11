import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { GOOGLE_SCOPE, type GoogleTokens } from "@/lib/google/oauth";
import {
  googleConnectionSecretPath,
  type GoogleConnectionSecret,
  type GoogleReconnectReason,
} from "@/types/google";
import { getGbpProviderFor } from "./provider/select";
import { GbpProviderError } from "./provider/types";

/**
 * Access-token lifecycle for a sub-account's Google connection.
 *
 * The locked secret doc (`private/googleConnection`) is the only store.
 * Refreshes are single-flight per sub-account within this process, and the
 * write-back is a transaction that yields to any other writer (another
 * process's refresh, or a reconnect) rather than clobbering it.
 */

/** A token with less than this left is treated as expired. */
export const REFRESH_MARGIN_MS = 60_000;

export class GbpNotConnectedError extends Error {
  constructor() {
    super("Google Business Profile is not connected for this sub-account");
    this.name = "GbpNotConnectedError";
  }
}

/**
 * Flag the connection as needing a fresh OAuth pass. Deep-merges into the
 * existing meta (keeping `connected`, `scopes`…) and leaves the secret doc in
 * place so a disconnect can still best-effort revoke it.
 */
export async function markReconnectRequired(
  subAccountId: string,
  reason: GoogleReconnectReason,
): Promise<void> {
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        googleConnectionMeta: { reconnectRequired: true, reconnectReason: reason },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function readSecret(subAccountId: string): Promise<GoogleConnectionSecret> {
  const snap = await getAdminDb().doc(googleConnectionSecretPath(subAccountId)).get();
  const secret = snap.exists ? (snap.data() as GoogleConnectionSecret) : null;
  if (!secret?.refreshToken) throw new GbpNotConnectedError();
  return secret;
}

const fresh = (s: GoogleConnectionSecret) =>
  s.accessTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS;

async function refreshAndStore(
  subAccountId: string,
  read: GoogleConnectionSecret,
): Promise<string> {
  const provider = await getGbpProviderFor(subAccountId);

  let tokens: GoogleTokens;
  try {
    tokens = await provider.refresh(read.refreshToken);
  } catch (err) {
    if (
      err instanceof GbpProviderError &&
      (err.kind === "revoked" || err.kind === "insufficient_scope")
    ) {
      await markReconnectRequired(subAccountId, err.kind);
    }
    throw err;
  }

  // Google normally echoes the granted scopes; if it omits them, the stored
  // grant is still the best evidence of what was consented to.
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : read.scopes;
  if (!scopes.includes(GOOGLE_SCOPE)) {
    await markReconnectRequired(subAccountId, "insufficient_scope");
    throw new GbpProviderError("insufficient_scope");
  }

  const db = getAdminDb();
  const ref = db.doc(googleConnectionSecretPath(subAccountId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as GoogleConnectionSecret) : null;
    // Disconnected while we were at Google: never resurrect the secret.
    if (!current) throw new GbpNotConnectedError();
    // Someone else already stored a usable token (another process, or a
    // reconnect). Theirs is as good as ours and is already persisted.
    if (fresh(current)) return current.accessToken;
    // If the refresh token changed underneath us, another process rotated it:
    // ours may be the stale one, so keep theirs.
    const refreshToken =
      current.refreshToken !== read.refreshToken
        ? current.refreshToken
        : (tokens.refreshToken ?? current.refreshToken);
    const next: GoogleConnectionSecret = {
      refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes,
    };
    tx.set(ref, next);
    return tokens.accessToken;
  });
}

const inflight = new Map<string, Promise<string>>();

/**
 * A Google access token for this sub-account with more than a minute to
 * live. Throws {@link GbpNotConnectedError} when there is no connection, and
 * a {@link GbpProviderError} (after flagging reconnect-required for revoked /
 * insufficient_scope) when Google refuses the refresh.
 */
export async function getValidAccessToken(subAccountId: string): Promise<string> {
  const pending = inflight.get(subAccountId);
  if (pending) return pending;

  const secret = await readSecret(subAccountId);
  if (fresh(secret)) return secret.accessToken;

  let p = inflight.get(subAccountId);
  if (!p) {
    p = refreshAndStore(subAccountId, secret).finally(() => {
      inflight.delete(subAccountId);
    });
    inflight.set(subAccountId, p);
  }
  return p;
}
