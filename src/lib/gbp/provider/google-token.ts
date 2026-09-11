import "server-only";

import type { GoogleTokens } from "@/lib/google/oauth";
import { errorForStatus } from "./google-http";
import { GbpProviderError } from "./types";

/**
 * Google's OAuth token endpoint — code exchange, refresh, revoke. The pure
 * helpers (scope, redirect URI, consent URL, signed state) stay in
 * lib/google/oauth.ts; everything that talks to Google lives behind the
 * provider so it gets typed errors like every other Google call.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

function credentials(): { client_id: string; client_secret: string } {
  return {
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}

async function postForm(url: string, body: URLSearchParams): Promise<{ res: Response; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new GbpProviderError("transient");
  }
  const data = (await res.json().catch(() => null)) as unknown;
  return { res, data };
}

async function postToken(body: URLSearchParams): Promise<GoogleTokens> {
  const { res, data } = await postForm(TOKEN_ENDPOINT, body);
  const d = (data ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  if (!res.ok) {
    // OAuth errors carry a machine code in `error`. invalid_grant = the
    // refresh token (or code) was revoked, expired or already used.
    if (d.error === "invalid_grant") {
      throw new GbpProviderError("revoked", { status: res.status });
    }
    if (d.error === "invalid_scope") {
      throw new GbpProviderError("insufficient_scope", { status: res.status });
    }
    throw errorForStatus(res, data);
  }
  if (typeof d.access_token !== "string" || typeof d.expires_in !== "number") {
    throw new GbpProviderError("malformed", { status: res.status });
  }
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : null,
    expiresAt: Date.now() + d.expires_in * 1000,
    scopes: typeof d.scope === "string" ? d.scope.split(" ").filter(Boolean) : [],
  };
}

/** Exchange the one-time `code` from the callback for tokens. */
export function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      code,
      ...credentials(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

/**
 * Mint a fresh access token. `refreshToken` on the result is non-null only
 * when Google rotated it — the caller must then persist the new one.
 */
export function refresh(refreshToken: string): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      ...credentials(),
      grant_type: "refresh_token",
    }),
  );
}

/**
 * Revoke at Google. Callers treat this as best-effort — a revoke that doesn't
 * land must never block the local disconnect.
 */
export async function revoke(token: string): Promise<void> {
  const { res, data } = await postForm(REVOKE_ENDPOINT, new URLSearchParams({ token }));
  if (!res.ok) throw errorForStatus(res, data);
}
