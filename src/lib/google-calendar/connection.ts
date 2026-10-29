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
  /**
   * Reading busy time / the token failed. Fixed text per failure kind; never
   * a Google response body or a token. A later successful read clears it.
   */
  lastError: string | null;
  lastErrorAt: Date | null;
  /**
   * Writing a booking to Google failed. Kept apart from `lastError` so a busy
   * read that works never hides a booking that is missing from Google.
   */
  lastPushError?: string | null;
  lastPushErrorAt?: Date | null;
  /**
   * Calendar import (lib/google-calendar/import.ts). Set only by the member
   * themself: "busy" stores times only, "details" also titles and places.
   * Absent = off. A reconnect replaces the doc, so it resets to off (and
   * carries `importGeneration` forward, bumped).
   */
  importMode?: ImportMode;
  /** Bumped by every opt-in change; a running import that sees it move backs off. */
  importGeneration?: number;
  /** Google's incremental sync token; null forces a full walk. */
  importSyncToken?: string | null;
  importLastSyncAt?: Date | null;
  importLastFullSyncAt?: Date | null;
  /** Last pass started — orders the sweep so a pass that keeps dying can't hog it. */
  importLastAttemptAt?: Date | null;
  /** Last FULL pass started — the settings route's cooldown. */
  importLastFullAttemptAt?: Date | null;
  /** One pass at a time per member: who holds it, and until when. */
  importLeaseId?: string | null;
  importLeaseUntil?: Date | null;
  importStatus?: "ok" | "error" | null;
  /** Fixed text per failure kind, like `lastError`. */
  importError?: string | null;
  importedCount?: number;
}

/** What a member shares from their Google Calendar. */
export type ImportMode = "off" | "busy" | "details";

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

/**
 * Run `work` with a time budget. On expiry the signal ABORTS the in-flight
 * Google calls (not just the wait for them) and the promise rejects with
 * GoogleCalendarTimeoutError.
 */
export async function withBudget<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new GoogleCalendarTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The uids Google sync may act for: an ACTIVE member of the sub-account, or
 * the owner of its agency (who reaches every sub-account without a member
 * row). A removed member's connection is never used.
 */
export async function isActiveMember(subAccountId: string, uid: string): Promise<boolean> {
  const db = getAdminDb();
  const member = await db.doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`).get();
  if (member.exists && member.data()?.status === "active") return true;
  const agencyId = (await db.doc(`subAccounts/${subAccountId}`).get()).data()?.agencyId;
  if (typeof agencyId !== "string" || !agencyId) return false;
  return (await db.doc(`agencies/${agencyId}`).get()).data()?.ownerUid === uid;
}

/**
 * THE eligibility rule for Google sync, shared by busy loading and push: of
 * the candidate hosts (a page's hosts, a booking's assignedToUid ∪ hostUids —
 * all server-set), keep the active members. Unique, order kept.
 */
export async function activeGoogleHosts(subAccountId: string, uids: string[]): Promise<string[]> {
  const unique = [...new Set(uids.filter(Boolean))];
  // A uid that can't even name a document (a "/" in it) is simply not
  // eligible — it must not take the other hosts down with it.
  const active = await Promise.all(unique.map((uid) => isActiveMember(subAccountId, uid).catch(() => false)));
  return unique.filter((_, i) => active[i]);
}

/** Member removal: drop their calendar connection. Best-effort, never throws. */
export async function deleteConnectionForRemovedMember(subAccountId: string, uid: string): Promise<void> {
  try {
    await getAdminDb().doc(gcalConnectionPath(subAccountId, uid)).delete();
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    console.error(`[google-calendar] removed-member cleanup failed sa=${subAccountId} uid=${uid} kind=${kind}`);
  }
}

/**
 * What the card shows for a failure. Fixed per kind — safe to store and
 * render. `kind` only changes the timeout text: a push never mentions busy.
 */
export function describeFailure(err: unknown, kind: "busy" | "push" = "busy"): string {
  if (err instanceof GoogleCalendarTimeoutError) {
    return kind === "busy"
      ? "Google Calendar didn't answer in time; your Google busy time was skipped."
      : "Google Calendar didn't answer in time.";
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
        return "Google Calendar is rate-limiting requests.";
      case "not_found":
        return "Google Calendar could not find the event.";
      default:
        return "Couldn't reach Google Calendar.";
    }
  }
  return "Couldn't reach Google Calendar.";
}

/**
 * Best-effort: record a failure on the connection — a busy/token failure in
 * `lastError`, a booking write in `lastPushError` (adding/updating and
 * removing worded apart). Never throws.
 */
export async function recordConnectionError(
  subAccountId: string,
  uid: string,
  err: unknown,
  kind: "busy" | "push" | "remove" = "busy",
): Promise<void> {
  const at = new Date();
  const fields =
    kind === "busy"
      ? { lastError: describeFailure(err), lastErrorAt: at }
      : {
          lastPushError: `${kind === "remove" ? "A booking change wasn't removed from your Google Calendar" : "A booking change wasn't synced to your Google Calendar"}: ${describeFailure(err, "push")}`,
          lastPushErrorAt: at,
        };
  try {
    await getAdminDb()
      .doc(gcalConnectionPath(subAccountId, uid))
      // update, not set: a member who disconnected meanwhile must not get a
      // stub connection doc back.
      .update(fields);
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
  signal?: AbortSignal,
): Promise<string> {
  if (!force && conn.accessTokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return conn.accessToken;
  }
  const ref = getAdminDb().doc(gcalConnectionPath(conn.subAccountId, conn.uid));
  let tokens;
  try {
    tokens = await provider.refresh(conn.refreshToken, signal);
  } catch (err) {
    // Only the grant that failed is revoked: a member who reconnected
    // meanwhile has a new refresh token that must not be marked dead.
    if (
      err instanceof GbpProviderError &&
      err.kind === "revoked" &&
      (await ref.get()).data()?.refreshToken === conn.refreshToken
    ) {
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
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await fn(await accessToken(conn, provider, false, signal));
  } catch (err) {
    if (!(err instanceof GbpProviderError) || err.kind !== "auth_expired") throw err;
    return fn(await accessToken(conn, provider, true, signal));
  }
}
