import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import type { GcalProvider } from "./provider/types";

/**
 * A member's Google Calendar connection — SERVER ONLY, at
 * `subAccounts/{saId}/private/googleCalendar_{uid}` (the `private/*` rules are
 * `allow read, write: if false`, so only the Admin SDK reaches it). One doc per
 * member: round robin needs each host's own busy time (ruling 6). The browser
 * sees only what GET /api/sub-accounts/[id]/google-calendar returns for the
 * caller — never a token.
 */
export interface GoogleCalendarConnection {
  uid: string;
  agencyId: string;
  subAccountId: string;
  googleEmail: string | null;
  refreshToken: string;
  accessToken: string;
  /** Epoch ms at which `accessToken` stops working. */
  accessTokenExpiresAt: number;
  scopes: string[];
  /** "revoked" once Google answered invalid_grant — the card says Reconnect. */
  status: "connected" | "revoked";
  connectedAt: Date;
  /** Fixed text per failure kind; never a Google response body or a token. */
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** Refresh when less than this is left on the cached access token. */
export const REFRESH_MARGIN_MS = 60_000;

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function gcalConnectionPath(subAccountId: string, uid: string): string {
  // The uid becomes part of a document id; one with a "/" would name a
  // different document entirely.
  if (!UID_RE.test(uid)) throw new Error("google-calendar: unsupported uid shape");
  return `subAccounts/${subAccountId}/private/googleCalendar_${uid}`;
}

export async function readConnection(
  subAccountId: string,
  uid: string,
): Promise<GoogleCalendarConnection | null> {
  const snap = await getAdminDb().doc(gcalConnectionPath(subAccountId, uid)).get();
  return snap.exists ? (snap.data() as GoogleCalendarConnection) : null;
}

/** Thrown when a host's Google call ran past its budget. */
export class GoogleCalendarTimeoutError extends Error {
  constructor(ms: number) {
    super(`Google Calendar did not answer within ${ms}ms`);
    this.name = "GoogleCalendarTimeoutError";
  }
}

/** What the card shows for a failure. Fixed per kind — safe to store and render. */
export function describeFailure(err: unknown): string {
  if (err instanceof GoogleCalendarTimeoutError) {
    return "Google Calendar didn't answer in time; your Google busy time was skipped.";
  }
  if (err instanceof GbpProviderError) {
    switch (err.kind) {
      case "revoked":
      case "auth_expired":
        return "Google no longer accepts this connection. Reconnect to restore it.";
      case "insufficient_scope":
      case "permission_denied":
        return "Google refused calendar access. Reconnect and allow calendar access.";
      case "rate_limited":
        return "Google Calendar is rate-limiting requests; it will be retried on the next booking.";
      case "not_found":
        return "Google Calendar could not find the event.";
      default:
        return "Couldn't reach Google Calendar; it will be retried on the next booking.";
    }
  }
  return "Couldn't reach Google Calendar; it will be retried on the next booking.";
}

/** Best-effort: record a failure on the connection. Never throws. */
export async function recordConnectionError(
  subAccountId: string,
  uid: string,
  err: unknown,
): Promise<void> {
  try {
    await getAdminDb()
      .doc(gcalConnectionPath(subAccountId, uid))
      // update, not set: a member who disconnected meanwhile must not get a
      // stub connection doc back.
      .update({ lastError: describeFailure(err), lastErrorAt: new Date() });
  } catch (writeErr) {
    const kind = writeErr instanceof Error ? writeErr.name : typeof writeErr;
    console.error(`[google-calendar] could not record error sa=${subAccountId} uid=${uid} kind=${kind}`);
  }
}

/**
 * A usable access token: the cached one while more than a minute is left,
 * otherwise a refresh (stored, with a rotated refresh token when Google sends
 * one). invalid_grant marks the connection `revoked` before rethrowing.
 */
async function accessToken(
  conn: GoogleCalendarConnection,
  provider: GcalProvider,
  force: boolean,
): Promise<string> {
  if (!force && conn.accessTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return conn.accessToken;
  }
  const ref = getAdminDb().doc(gcalConnectionPath(conn.subAccountId, conn.uid));
  let tokens;
  try {
    tokens = await provider.refresh(conn.refreshToken);
  } catch (err) {
    if (err instanceof GbpProviderError && err.kind === "revoked") {
      await ref.update({ status: "revoked", lastError: describeFailure(err), lastErrorAt: new Date() });
    }
    throw err;
  }
  const update: Partial<GoogleCalendarConnection> = {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
  };
  if (tokens.refreshToken) update.refreshToken = tokens.refreshToken;
  await ref.update(update);
  Object.assign(conn, update);
  return tokens.accessToken;
}

/**
 * Run `fn` with a valid access token. A 401 from the call itself (the token
 * was revoked at Google before it expired) earns exactly one forced refresh —
 * which is where a revoked grant is discovered and recorded.
 */
export async function withGoogleToken<T>(
  conn: GoogleCalendarConnection,
  provider: GcalProvider,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await accessToken(conn, provider, false));
  } catch (err) {
    if (!(err instanceof GbpProviderError) || err.kind !== "auth_expired") throw err;
    return fn(await accessToken(conn, provider, true));
  }
}
