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
// sub-account) without persisting anything. Same construction as Meta's.
// ---------------------------------------------------------------------------

function stateSecret(): string {
  return process.env.AUTOMATIONS_TOKEN_SECRET ?? "";
}

export function signGoogleState(subAccountId: string, nonce: string): string {
  const payload = `${subAccountId}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(`googlestate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyGoogleState(
  state: string,
): { subAccountId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [subAccountId, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", stateSecret())
    .update(`googlestate:${subAccountId}.${nonce}`)
    .digest("hex");
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  return { subAccountId };
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
