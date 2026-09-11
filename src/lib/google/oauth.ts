import "server-only";

import crypto from "node:crypto";

/**
 * Google OAuth wrapper for the Business Profile connection. Everything here is
 * INERT unless the deployment has a Google OAuth client configured
 * (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`) AND the sub-account's agency
 * gate (`googleEnabledByAgency`) is on.
 *
 * Mirrors the shape of `lib/comms/meta.ts`: pure helpers + token-endpoint
 * calls, no Firestore writes. The connect route and the shared callback are
 * the only callers.
 */

/**
 * The ONLY scope requested. Google Business Profile management — read/write
 * of locations and reviews. Adding a scope here means re-submitting the OAuth
 * consent screen, so it is deliberately a single constant, not a builder.
 */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * The ONE OAuth redirect URI for the whole deployment. Google validates
 * `redirect_uri` with an exact string match against the client's registered
 * list, so it must be a single fixed value — NOT per-sub-account. The
 * connecting sub-account is carried in the signed `state` instead.
 *
 * Anchored to NEXT_PUBLIC_APP_URL (not the request origin) so the value is
 * stable across preview/www/apex hosts and byte-identical between the
 * authorize step and the token exchange. Returns null when the env var is
 * unset, so callers fail loudly rather than send Google a URL that can't match.
 */
export function googleRedirectUri(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/api/google/callback`;
}

/** True when the deployment has Google OAuth client credentials. */
export function googleAppConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

/**
 * Build the Google consent-screen URL the admin is redirected to.
 *
 * `access_type=offline` + `prompt=consent` are load-bearing: without BOTH,
 * Google returns a refresh token only on the user's FIRST authorisation and
 * omits it on every re-connect — the stored connection would then silently
 * die when the access token expires an hour later.
 */
export function buildGoogleOAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// CSRF state — HMAC-signed with the existing AUTOMATIONS_TOKEN_SECRET so the
// callback can trust `state` came from our connect route (and names the right
// sub-account) without persisting anything.
//
//   state = base64url(JSON {s, u, t, n, r?}) + "." + hex HMAC-SHA256("googlestate:" + payload)
//
// s = sub-account, u = the uid that started the flow, t = issued-at (ms),
// n = nonce, r = return page (allow-listed). `t` bounds how long a leaked state
// stays usable; `u` means a state leaked to another admin of the same
// sub-account is useless to them. Without both, a state was replayable forever
// by anyone who could pass the admin check.
// ---------------------------------------------------------------------------

/** Where the callback sends the admin back to. An allow-list, never a URL. */
export type GoogleReturnTo = "settings" | "gbp";

export interface GoogleStateClaims {
  subAccountId: string;
  uid: string;
  returnTo: GoogleReturnTo;
}

const STATE_MAX_AGE_MS = 10 * 60_000;
const STATE_MAX_SKEW_MS = 60_000;

/** Thrown by signGoogleState when there is no key to sign with. */
export class GoogleStateSecretMissingError extends Error {
  constructor() {
    super("AUTOMATIONS_TOKEN_SECRET is not set; cannot sign OAuth state");
    this.name = "GoogleStateSecretMissingError";
  }
}

function stateHmac(secret: string, payload: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`googlestate:${payload}`)
    .digest("hex");
}

export function signGoogleState(
  claims: { subAccountId: string; uid: string; returnTo?: GoogleReturnTo },
  now: number = Date.now(),
): string {
  // An empty key makes the HMAC forgeable by anyone who reads this file.
  const secret = process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
  if (!secret) throw new GoogleStateSecretMissingError();
  const body: Record<string, unknown> = {
    s: claims.subAccountId,
    u: claims.uid,
    t: now,
    n: crypto.randomBytes(16).toString("hex"),
  };
  if (claims.returnTo === "gbp") body.r = "gbp";
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${stateHmac(secret, payload)}`;
}

export function verifyGoogleState(
  state: string,
  now: number = Date.now(),
): GoogleStateClaims | null {
  const secret = process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
  if (!secret) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  // Shape-check first: timingSafeEqual throws on unequal BYTE lengths, and a
  // non-hex character can make equal string lengths differ in bytes.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = stateHmac(secret, payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    // Correctly signed but not JSON — only a key holder could produce it, and
    // it still names no sub-account. Refuse like any other bad state.
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { s, u, t, n, r } = body as Record<string, unknown>;
  if (typeof s !== "string" || !s) return null;
  if (typeof u !== "string" || !u) return null;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (typeof n !== "string" || !n) return null;
  if (r !== undefined && r !== "gbp") return null;
  if (now - t > STATE_MAX_AGE_MS) return null;
  if (t - now > STATE_MAX_SKEW_MS) return null;
  return { subAccountId: s, uid: u, returnTo: r === "gbp" ? "gbp" : "settings" };
}

/** The in-app page a Google flow returns to. Allow-listed by construction. */
export function googleReturnPath(
  subAccountId: string,
  returnTo: GoogleReturnTo,
): string {
  return returnTo === "gbp"
    ? `/sa/${subAccountId}/ai-agents/google-business`
    : `/sa/${subAccountId}/dashboard/settings`;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface GoogleTokens {
  accessToken: string;
  /** Absent on a refresh — Google only returns it at authorisation time. */
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

function credentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}

async function postToken(body: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error_description?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || !data) {
    const detail =
      typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.error === "string"
          ? data.error
          : `HTTP ${res.status}`;
    throw new Error(`Google token request failed: ${detail}`);
  }
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new Error("Google token response was malformed");
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : [],
  };
}

/** Exchange the one-time `code` from the callback for tokens. */
export function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<GoogleTokens> {
  const { clientId, clientSecret } = credentials();
  return postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
}


/**
 * Best-effort revoke at Google's end. Callers swallow failures — a revoke that
 * doesn't land must never block the local disconnect, or the operator is stuck
 * with a connection they can't remove.
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  const res = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) {
    throw new Error(`Google revoke failed: HTTP ${res.status}`);
  }
}
