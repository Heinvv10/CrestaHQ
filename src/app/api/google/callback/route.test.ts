import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route tests for the shared Google Business Profile OAuth callback.
 *
 * The load-bearing invariant is the token split: the refresh token is a
 * long-lived credential and `subAccounts/{id}` is readable by EVERY active
 * member (Firestore rules are document-level), so a token on that doc is a
 * token handed to every collaborator seat. The "no token on the doc" test
 * asserts that by substring, not by field name — a rename can't sneak past it.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import {
  SECRET_PATH,
  SUB,
  SUB_PATH,
  request,
  resetHarness,
  state,
  stubTokenEndpoint,
} from "@/test/google-oauth-harness";
import { signGoogleState } from "@/lib/google/oauth";
import { GET } from "./route";

const REFRESH_TOKEN = "1//0gRefreshTokenSuperSecretValue";
const ACCESS_TOKEN = "ya29.AccessTokenSuperSecretValue";

const TOKEN_RESPONSE = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_in: 3599,
  scope: "https://www.googleapis.com/auth/business.manage",
  token_type: "Bearer",
};

function callbackUrl(params: Record<string, string>) {
  const url = new URL("http://app.local/api/google/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

const validState = () => signGoogleState({ subAccountId: SUB, uid: "uid_admin" });

async function call(
  params: Record<string, string>,
  uid = "uid_admin",
): Promise<Response> {
  return GET(request(callbackUrl(params), uid));
}

beforeEach(() => {
  resetHarness();
  stubTokenEndpoint(TOKEN_RESPONSE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("state verification", () => {
  it("bounces a missing state to a safe landing and writes nothing", async () => {
    const res = await call({ code: "abc" });
    expect(res.headers.get("location")).toBe(
      "http://app.local/agency/sub-accounts?google=bad_state",
    );
    expect(state.writes).toEqual([]);
  });

  it("bounces a forged state and writes nothing", async () => {
    const [payload] = validState().split(".");
    const res = await call({
      code: "abc",
      state: `${payload}.${"0".repeat(64)}`,
    });
    expect(res.headers.get("location")).toBe(
      "http://app.local/agency/sub-accounts?google=bad_state",
    );
    expect(state.writes).toEqual([]);
  });
});

describe("guards", () => {
  it("refuses a member who is not an admin, and writes nothing", async () => {
    const res = await call({ code: "abc", state: validState() }, "uid_member");
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("refuses an admin of a DIFFERENT sub-account, and writes nothing", async () => {
    // uid_other_admin is a genuine admin — of sa_2. A route that checked
    // "is an admin somewhere" would write a Google connection into sa_1.
    const res = await call(
      { code: "abc", state: validState() },
      "uid_other_admin",
    );
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("refuses when the agency gate is off, and writes nothing", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1" });
    const res = await call({ code: "abc", state: validState() });
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=gate_off`,
    );
    expect(state.writes).toEqual([]);
  });

  it("reports not_configured when the deployment has no OAuth client", async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await call({ code: "abc", state: validState() });
    expect(res.headers.get("location")).toContain("google=not_configured");
    expect(state.writes).toEqual([]);
  });
});

describe("user declined", () => {
  it("redirects with `cancelled` and stores nothing on access_denied", async () => {
    const res = await call({ error: "access_denied", state: validState() });
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=cancelled`,
    );
    expect(state.writes).toEqual([]);
  });

  it("redirects with `cancelled` when neither code nor error arrives", async () => {
    const res = await call({ state: validState() });
    expect(res.headers.get("location")).toContain("google=cancelled");
    expect(state.writes).toEqual([]);
  });
});

describe("successful exchange", () => {
  it("stores the tokens ONLY in the locked private subcollection", async () => {
    const res = await call({ code: "abc", state: validState() });
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=connected`,
    );

    const secret = state.writes.find((w) => w.path === SECRET_PATH);
    expect(secret?.op).toBe("set");
    expect(secret?.data).toMatchObject({
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      scopes: ["https://www.googleapis.com/auth/business.manage"],
    });
  });

  it("puts NO part of either token on the member-readable sub-account doc", async () => {
    await call({ code: "abc", state: validState() });

    const docWrite = state.writes.find((w) => w.path === SUB_PATH);
    expect(docWrite).toBeDefined();
    // Substring, not field name: renaming the field cannot make this pass.
    const serialized = JSON.stringify(docWrite?.data);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    // Not even a fragment — a "last 8 chars for display" would fail here.
    expect(serialized).not.toContain(REFRESH_TOKEN.slice(-8));
    expect(serialized).not.toContain(ACCESS_TOKEN.slice(-8));

    const meta = (docWrite?.data as { googleConnectionMeta: Record<string, unknown> })
      .googleConnectionMeta;
    expect(meta).toMatchObject({ connected: true, connectedByUid: "uid_admin" });
  });

  it("refuses a grant with no refresh token rather than storing a dying link", async () => {
    stubTokenEndpoint({ ...TOKEN_RESPONSE, refresh_token: undefined });
    const res = await call({ code: "abc", state: validState() });
    expect(res.headers.get("location")).toContain("google=no_refresh_token");
    expect(state.writes).toEqual([]);
  });

  it("logs only the error's name and message, never the raw object", async () => {
    stubTokenEndpoint({ error: "invalid_grant", error_description: "LEAKY-DETAIL" }, 400);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await call({ code: "abc", state: validState() });
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0];
    expect(args.every((a) => typeof a === "string")).toBe(true);
    expect(args.join(" ")).toContain(
      "GbpProviderError: Google Business Profile provider error: revoked (HTTP 400)",
    );
    expect(args.join(" ")).not.toContain("LEAKY-DETAIL");
  });

  it("redirects with `error` and stores nothing when Google rejects the code", async () => {
    stubTokenEndpoint({ error: "invalid_grant" }, 400);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call({ code: "abc", state: validState() });
    expect(res.headers.get("location")).toContain("google=error");
    expect(state.writes).toEqual([]);
  });
});
