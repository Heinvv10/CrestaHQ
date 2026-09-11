import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exchangeCode, refresh, revoke } from "./google-token";
import { GbpProviderError } from "./types";

/**
 * Google's OAuth token endpoint, behind the provider. Moved here from
 * lib/google/oauth.ts so every Google call has typed errors — and so no error
 * message can carry a response body (Google echoes request detail there).
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
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
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const OK = {
  access_token: "ya29.abc",
  refresh_token: "1//0gRefresh",
  expires_in: 3599,
  scope: "https://www.googleapis.com/auth/business.manage",
};

async function kindOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GbpProviderError);
  return (err as GbpProviderError).kind;
}

describe("exchangeCode", () => {
  it("sends the client credentials and redirect URI, and maps the tokens", async () => {
    const spy = stubToken(OK);
    const before = Date.now();
    const tokens = await exchangeCode("the-code", "http://x/cb");

    expect(spy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(spy.mock.calls[0][1].body)).toEqual({
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
    expect((await exchangeCode("c", "http://x/cb")).refreshToken).toBeNull();
  });

  it("throws malformed rather than storing a response missing an access token", async () => {
    stubToken({ expires_in: 3599 });
    expect(await kindOf(exchangeCode("c", "http://x/cb"))).toBe("malformed");
    stubToken("<html>not json</html>");
    expect(await kindOf(exchangeCode("c", "http://x/cb"))).toBe("malformed");
  });
});

describe("refresh", () => {
  it("uses the refresh_token grant", async () => {
    const spy = stubToken({ ...OK, refresh_token: undefined });
    const tokens = await refresh("1//0gStored");
    expect(Object.fromEntries(spy.mock.calls[0][1].body)).toEqual({
      refresh_token: "1//0gStored",
      client_id: "client-id.apps.googleusercontent.com",
      client_secret: "client-secret",
      grant_type: "refresh_token",
    });
    expect(tokens.accessToken).toBe("ya29.abc");
    // No rotation → null, so the caller keeps the stored one.
    expect(tokens.refreshToken).toBeNull();
  });

  it("surfaces a rotated refresh token", async () => {
    stubToken({ ...OK, refresh_token: "1//0gRotated" });
    expect((await refresh("1//0gStored")).refreshToken).toBe("1//0gRotated");
  });

  it("maps invalid_grant to revoked", async () => {
    stubToken({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    expect(await kindOf(refresh("1//0gStored"))).toBe("revoked");
  });

  it("maps invalid_scope to insufficient_scope", async () => {
    stubToken({ error: "invalid_scope" }, 400);
    expect(await kindOf(refresh("1//0gStored"))).toBe("insufficient_scope");
  });

  it("maps 5xx and a network throw to transient, 429 to rate_limited", async () => {
    stubToken({ error: "backend_error" }, 503);
    expect(await kindOf(refresh("r"))).toBe("transient");
    stubToken({ error: "rate" }, 429);
    expect(await kindOf(refresh("r"))).toBe("rate_limited");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await kindOf(refresh("r"))).toBe("transient");
  });

  it("never puts the response body or the token in the error message", async () => {
    stubToken({ error: "invalid_grant", error_description: "SECRET-DETAIL 1//0gStored" }, 400);
    const err = (await refresh("1//0gStored").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET-DETAIL");
    expect(err.message).not.toContain("1//0gStored");
    expect(err.message).toBe("Google Business Profile provider error: revoked (HTTP 400)");
  });
});

describe("revoke", () => {
  it("posts the token to the revoke endpoint", async () => {
    const spy = stubToken({});
    await revoke("1//0gStored");
    expect(spy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(spy.mock.calls[0][1].body.get("token")).toBe("1//0gStored");
  });

  it("throws a typed error when Google refuses", async () => {
    stubToken({ error: "invalid_token" }, 400);
    await expect(revoke("x")).rejects.toBeInstanceOf(GbpProviderError);
  });
});
