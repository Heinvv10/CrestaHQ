import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendAutoReplyAlert } from "@/lib/reputation/auto-reply/alerts";
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
 * Flag the connection as needing a fresh OAuth pass — but ONLY if the secret
 * still holds the credential that failed (`expected`). If it changed, a newer
 * grant (a reconnect, or another process's rotation) exists and flagging
 * would mark a healthy connection broken; that newer secret is returned
 * instead, unflagged. Returns null when flagged, or when there is no
 * connection at all. Deep-merges into the meta (keeping `connected`,
 * `scopes`…) and keeps the secret so a disconnect can still revoke it.
 * The flag flipping false→true (seen inside the transaction, so exactly one
 * writer sees it) while review auto-reply is on sends one alert after the
 * commit — auto-reply cannot post until someone reconnects.
 */
export async function markReconnectRequiredIf(
  subAccountId: string,
  reason: GoogleReconnectReason,
  expected: { refreshToken: string } | { accessToken: string },
): Promise<GoogleConnectionSecret | null> {
  const db = getAdminDb();
  const secretRef = db.doc(googleConnectionSecretPath(subAccountId));
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  let flipped = false;
  const result = await db.runTransaction(async (tx) => {
    flipped = false;
    const snap = await tx.get(secretRef);
    const current = snap.exists ? (snap.data() as GoogleConnectionSecret) : null;
    if (!current) return null;
    const unchanged =
      "refreshToken" in expected
        ? current.refreshToken === expected.refreshToken
        : current.accessToken === expected.accessToken;
    if (!unchanged) return current;
    const sub = (await tx.get(subRef)).data();
    flipped = sub?.googleConnectionMeta?.reconnectRequired !== true && sub?.reviewsAutoReply?.enabled === true;
    tx.set(
      subRef,
      {
        googleConnectionMeta: { reconnectRequired: true, reconnectReason: reason },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return null;
  });
  if (flipped) await sendAutoReplyAlert(subAccountId, { kind: "reconnect_required" });
  return result;
}

/**
 * Google rejected `accessToken` (401) although we believed it valid — the
 * grant was probably revoked at Google. Expire it so the next
 * getValidAccessToken refreshes; only if the secret still holds THAT token,
 * so a newer token another writer stored is never thrown away.
 */
export async function invalidateAccessToken(
  subAccountId: string,
  accessToken: string,
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(googleConnectionSecretPath(subAccountId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as GoogleConnectionSecret) : null;
    if (current?.accessToken === accessToken) tx.update(ref, { accessTokenExpiresAt: 0 });
  });
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
  retried = false,
): Promise<string> {
  const provider = await getGbpProviderFor(subAccountId);

  /**
   * Google refused THIS grant. Flag reconnect unless a newer grant replaced
   * it meanwhile — then use that one instead (refreshing it at most once).
   */
  const grantFailed = async (err: GbpProviderError): Promise<string> => {
    const kind = err.kind === "revoked" ? "revoked" : "insufficient_scope";
    const newer = await markReconnectRequiredIf(subAccountId, kind, {
      refreshToken: read.refreshToken,
    });
    if (!newer) throw err;
    // A newer grant exists (so nothing was flagged) but it failed too, or kept
    // changing: a race, not a broken connection — report it as retryable.
    if (retried) throw new GbpProviderError("transient");
    return fresh(newer) ? newer.accessToken : refreshAndStore(subAccountId, newer, true);
  };

  let tokens: GoogleTokens;
  try {
    tokens = await provider.refresh(read.refreshToken);
  } catch (err) {
    if (
      err instanceof GbpProviderError &&
      (err.kind === "revoked" || err.kind === "insufficient_scope")
    ) {
      return grantFailed(err);
    }
    throw err;
  }

  // Google normally echoes the granted scopes; if it omits them, the stored
  // grant is still the best evidence of what was consented to.
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : read.scopes;
  if (!scopes.includes(GOOGLE_SCOPE)) {
    return grantFailed(new GbpProviderError("insufficient_scope"));
  }

  const db = getAdminDb();
  const ref = db.doc(googleConnectionSecretPath(subAccountId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as GoogleConnectionSecret) : null;
    // Disconnected while we were at Google: never resurrect the secret.
    if (!current) throw new GbpNotConnectedError();
    // Someone else already stored a usable token (another process, or a
    // reconnect). Theirs is as good as ours and is already persisted — but if
    // Google rotated the refresh token WE used, and the secret still holds
    // that one, the rotation must land or the next refresh is revoked.
    if (fresh(current)) {
      if (tokens.refreshToken && current.refreshToken === read.refreshToken) {
        tx.update(ref, { refreshToken: tokens.refreshToken });
      }
      return current.accessToken;
    }
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
