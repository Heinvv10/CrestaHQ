import "server-only";

import crypto from "node:crypto";

/**
 * Pure helpers for the Business Profile OAuth connection: the scope, the
 * redirect URI, the consent URL and the signed `state`. Everything is INERT
 * unless the deployment has a Google OAuth client configured
 * (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, or the fenced fake provider)
 * AND the sub-account's agency gate (`googleEnabledByAgency`) is on.
 *
 * Calls to Google's token endpoint live behind the GBP provider
 * (`lib/gbp/provider/google-token.ts`) so they get typed errors like every
 * other Google call. No Firestore writes here.
 */

/**
 * The ONLY scope requested. Google Business Profile management — read/write
 * of locations and reviews. Adding a scope here means re-submitting the OAuth
 * consent screen, so it is deliberately a single constant, not a builder.
 */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

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

/**
 * True when the deployment has Google OAuth client credentials — or runs the
 * fake provider, which needs none. Whether the fake is actually ALLOWED here
 * is decided (loudly) by `getGbpProviderFor` in lib/gbp/provider/select.ts.
 */
export function googleAppConfigured(): boolean {
  if (process.env.GBP_PROVIDER === "fake") return true;
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
// Token shape — returned by the provider's exchange / refresh.
// ---------------------------------------------------------------------------

export interface GoogleTokens {
  accessToken: string;
  /** Null on a refresh unless Google rotated it (then it must be stored). */
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}
