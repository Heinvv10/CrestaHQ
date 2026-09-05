import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_SCOPE,
  buildGoogleOAuthUrl,
  exchangeCodeForTokens,
  googleAppConfigured,
  googleRedirectUri,
  signGoogleState,
  verifyGoogleState,
} from "./oauth";

/**
 * The signed `state` is the ONLY thing authenticating which sub-account a
 * callback belongs to — the callback trusts it before it will even look up
 * membership. A forgeable state means anyone who can hit /api/google/callback
 * picks whose workspace gets a Google connection written to it.
 *
 * The two redirect URIs registered on the OAuth client are exact strings
 * ("https://crm.crestahq.com/api/google/callback" and the :3777 localhost
 * one). Google rejects anything else, so the URL builder is pinned too.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-state-secret";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3777";
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

function stubToken(body: unknown, status = 200) {
  const spy = vi.fn(
    async (_url: string, _init: { body: URLSearchParams }) =>
      new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("google OAuth state", () => {
  it("round-trips the sub-account id", () => {
    const state = signGoogleState("sa_1", "nonce123");
    expect(verifyGoogleState(state)).toEqual({ subAccountId: "sa_1" });
  });

  it("rejects a state whose sub-account id was swapped", () => {
    const state = signGoogleState("sa_1", "nonce123");
    const [, nonce, sig] = state.split(".");
    expect(verifyGoogleState(`sa_victim.${nonce}.${sig}`)).toBeNull();
  });

  it("rejects a state whose signature was tampered with", () => {
    const state = signGoogleState("sa_1", "nonce123");
    const [id, nonce, sig] = state.split(".");
    // Flip one hex character — same length, so a length-only check passes.
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyGoogleState(`${id}.${nonce}.${flipped}`)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signGoogleState("sa_1", "nonce123");
    process.env.AUTOMATIONS_TOKEN_SECRET = "some-other-secret";
    expect(verifyGoogleState(state)).toBeNull();
  });

  it("rejects malformed states", () => {
    expect(verifyGoogleState("")).toBeNull();
    expect(verifyGoogleState("sa_1.nonce")).toBeNull();
    expect(verifyGoogleState("sa_1.nonce.sig.extra")).toBeNull();
    // A short signature must not throw out of timingSafeEqual.
    expect(verifyGoogleState("sa_1.nonce.ab")).toBeNull();
  });
});

describe("buildGoogleOAuthUrl", () => {
  const params = () =>
    new URL(
      buildGoogleOAuthUrl({
        redirectUri: googleRedirectUri() as string,
        state: signGoogleState("sa_1", "nonce123"),
      }),
    ).searchParams;

  it("requests exactly the business.manage scope", () => {
    expect(params().get("scope")).toBe(
      "https://www.googleapis.com/auth/business.manage",
    );
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/business.manage");
  });

  it("requests offline access with a forced consent prompt", () => {
    // Both are required for Google to return a refresh token on a RE-connect.
    // Without them the stored connection dies when the access token expires.
    expect(params().get("access_type")).toBe("offline");
    expect(params().get("prompt")).toBe("consent");
  });

  it("sends a redirect_uri matching a registered one exactly", () => {
    expect(params().get("redirect_uri")).toBe(
      "http://localhost:3777/api/google/callback",
    );
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect(googleRedirectUri()).toBe(
      "https://crm.crestahq.com/api/google/callback",
    );
    // A trailing slash on the env var must not produce a double slash.
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com/";
    expect(googleRedirectUri()).toBe(
      "https://crm.crestahq.com/api/google/callback",
    );
  });

  it("carries the signed state through untouched", () => {
    const state = signGoogleState("sa_1", "nonce123");
    const url = new URL(
      buildGoogleOAuthUrl({ redirectUri: "http://x/cb", state }),
    );
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
  });
});

describe("googleRedirectUri / googleAppConfigured", () => {
  it("returns null rather than a guessed URI when the app URL is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(googleRedirectUri()).toBeNull();
  });

  it("is unconfigured when either credential is missing", () => {
    expect(googleAppConfigured()).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(googleAppConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    delete process.env.GOOGLE_CLIENT_ID;
    expect(googleAppConfigured()).toBe(false);
  });
});

describe("token endpoint", () => {
  const OK = {
    access_token: "ya29.abc",
    refresh_token: "1//0gRefresh",
    expires_in: 3599,
    scope: "https://www.googleapis.com/auth/business.manage",
  };

  it("exchanges a code, sending the client credentials and redirect URI", async () => {
    const spy = stubToken(OK);
    const before = Date.now();
    const tokens = await exchangeCodeForTokens("the-code", "http://x/cb");

    expect(spy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    const body = spy.mock.calls[0][1].body;
    expect(Object.fromEntries(body)).toEqual({
      code: "the-code",
      client_id: "client-id.apps.googleusercontent.com",
      client_secret: "client-secret",
      redirect_uri: "http://x/cb",
      grant_type: "authorization_code",
    });
    expect(tokens.accessToken).toBe("ya29.abc");
    expect(tokens.refreshToken).toBe("1//0gRefresh");
    expect(tokens.scopes).toEqual([
      "https://www.googleapis.com/auth/business.manage",
    ]);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3599 * 1000);
  });

  it("reports a null refresh token rather than inventing one", async () => {
    stubToken({ ...OK, refresh_token: undefined });
    expect((await exchangeCodeForTokens("c", "http://x/cb")).refreshToken).toBeNull();
  });

  it("throws with Google's own reason on an error response", async () => {
    stubToken({ error: "invalid_grant", error_description: "Bad Request" }, 400);
    await expect(exchangeCodeForTokens("c", "http://x/cb")).rejects.toThrow(
      "Google token request failed: Bad Request",
    );
  });

  it("throws rather than storing a response missing an access token", async () => {
    stubToken({ expires_in: 3599 });
    await expect(exchangeCodeForTokens("c", "http://x/cb")).rejects.toThrow(
      "Google token response was malformed",
    );
  });
});
