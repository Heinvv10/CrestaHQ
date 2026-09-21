import { afterEach, beforeEach, describe, expect, it } from "vitest";

import crypto from "node:crypto";
import {
  GOOGLE_SCOPE,
  GoogleStateSecretMissingError,
  buildGoogleOAuthUrl,
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
  delete process.env.GBP_PROVIDER;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const CLAIMS = { subAccountId: "sa_1", uid: "uid_admin" };

/** Re-sign an arbitrary payload with the test secret — a forger WITH the key. */
function signRaw(payload: string, secret = "test-state-secret"): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`googlestate:${payload}`)
    .digest("hex");
  return `${payload}.${sig}`;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("google OAuth state", () => {
  it("round-trips the sub-account, the initiating uid and the return page", () => {
    const state = signGoogleState(CLAIMS, NOW);
    expect(verifyGoogleState(state, NOW)).toEqual({
      subAccountId: "sa_1",
      uid: "uid_admin",
      returnTo: "settings",
    });
    const gbp = signGoogleState({ ...CLAIMS, returnTo: "gbp" }, NOW);
    expect(verifyGoogleState(gbp, NOW)?.returnTo).toBe("gbp");
  });

  it("is base64url(JSON {s,u,t,n}) + '.' + hex HMAC", () => {
    const state = signGoogleState(CLAIMS, NOW);
    const [payload, sig, extra] = state.split(".");
    expect(extra).toBeUndefined();
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(decoded).toMatchObject({ s: "sa_1", u: "uid_admin", t: NOW });
    expect(typeof decoded.n).toBe("string");
    expect(decoded.n.length).toBeGreaterThanOrEqual(16);
    // Two states for the same claims differ — the nonce is fresh each time.
    expect(signGoogleState(CLAIMS, NOW)).not.toBe(state);
  });

  it("rejects a state whose sub-account id was swapped", () => {
    const [payload, sig] = signGoogleState(CLAIMS, NOW).split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    const swapped = b64({ ...decoded, s: "sa_victim" });
    expect(verifyGoogleState(`${swapped}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a state whose signature was tampered with", () => {
    const [payload, sig] = signGoogleState(CLAIMS, NOW).split(".");
    // Flip one hex character — same length, so a length-only check passes.
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyGoogleState(`${payload}.${flipped}`, NOW)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signGoogleState(CLAIMS, NOW);
    process.env.AUTOMATIONS_TOKEN_SECRET = "some-other-secret";
    expect(verifyGoogleState(state, NOW)).toBeNull();
  });

  it("expires ten minutes after it was issued", () => {
    const state = signGoogleState(CLAIMS, NOW);
    expect(verifyGoogleState(state, NOW + 10 * 60_000)).not.toBeNull();
    expect(verifyGoogleState(state, NOW + 10 * 60_000 + 1)).toBeNull();
  });

  it("rejects a state issued more than 60s in the future", () => {
    expect(verifyGoogleState(signGoogleState(CLAIMS, NOW + 60_000), NOW)).not.toBeNull();
    expect(verifyGoogleState(signGoogleState(CLAIMS, NOW + 60_001), NOW)).toBeNull();
  });

  it("refuses to sign, and verifies nothing, when the secret is unset or empty", () => {
    const signedWithEmpty = signRaw(b64({ s: "sa_1", u: "uid_admin", t: NOW, n: "x".repeat(32) }), "");
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.AUTOMATIONS_TOKEN_SECRET;
      else process.env.AUTOMATIONS_TOKEN_SECRET = value;
      expect(() => signGoogleState(CLAIMS, NOW)).toThrow(GoogleStateSecretMissingError);
      expect(verifyGoogleState(signedWithEmpty, NOW)).toBeNull();
    }
  });

  it("rejects correctly-signed payloads that are not a well-formed claim set", () => {
    const good = { s: "sa_1", u: "uid_admin", t: NOW, n: "x".repeat(32) };
    const cases: unknown[] = [
      "not json",
      [],
      { ...good, s: "" },
      { ...good, u: "" },
      { ...good, s: 7 },
      { ...good, t: String(NOW) },
      { ...good, n: undefined },
      // The return page is an allow-list, never an arbitrary URL.
      { ...good, r: "https://evil.example" },
    ];
    for (const c of cases) {
      const payload =
        typeof c === "string" ? Buffer.from(c).toString("base64url") : b64(c);
      expect(verifyGoogleState(signRaw(payload), NOW)).toBeNull();
    }
    // Sanity: the same helper produces an accepted state for the good claims.
    expect(verifyGoogleState(signRaw(b64(good)), NOW)).not.toBeNull();
  });

  it("round-trips the calendar purpose, and refuses a forged or mixed one", () => {
    const cal = signGoogleState({ ...CLAIMS, purpose: "calendar" }, NOW);
    expect(verifyGoogleState(cal, NOW)).toEqual({ ...CLAIMS, returnTo: "settings", purpose: "calendar" });
    const good = { s: "sa_1", u: "uid_admin", t: NOW, n: "x".repeat(32) };
    // Signed by a key holder, but a purpose this deployment never issues.
    for (const bad of [{ ...good, p: "calendar", r: "gbp" }, { ...good, p: "drive" }, { ...good, p: "" }, { ...good, p: 1 }]) {
      expect(verifyGoogleState(signRaw(b64(bad)), NOW)).toBeNull();
    }
    expect(verifyGoogleState(signRaw(b64({ ...good, p: "calendar" })), NOW)?.purpose).toBe("calendar");
  });

  it("rejects malformed states", () => {
    expect(verifyGoogleState("", NOW)).toBeNull();
    expect(verifyGoogleState("sa_1.nonce.sig", NOW)).toBeNull();
    expect(verifyGoogleState("onlyonesegment", NOW)).toBeNull();
    // A short signature must not throw out of timingSafeEqual.
    expect(verifyGoogleState(`${b64({})}.ab`, NOW)).toBeNull();
  });
});

describe("buildGoogleOAuthUrl", () => {
  const params = () =>
    new URL(
      buildGoogleOAuthUrl({
        redirectUri: googleRedirectUri() as string,
        state: signGoogleState(CLAIMS),
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
    const state = signGoogleState(CLAIMS);
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
