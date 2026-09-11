import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connect + callback through the provider seam: the real routes, the real
 * provider selection, Firestore faked underneath. The fake-mode cases matter
 * because local dev and CI share the PRODUCTION Firestore — a fake callback
 * that reached a real tenant would overwrite its real Google connection.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import {
  OTHER_SUB,
  SECRET_PATH,
  SUB,
  SUB_PATH,
  request,
  resetHarness,
  state,
  stubTokenEndpoint,
} from "@/test/google-oauth-harness";
import { googleAppConfigured, signGoogleState } from "@/lib/google/oauth";
import { DEFAULT_ACCOUNT, LOC_NORTH, TOKEN_MARKERS, setScenario } from "@/test/gbp-route-harness";
import { GET as CONNECT } from "../../sub-accounts/[id]/google/connect/route";
import { GET as CALLBACK } from "./route";

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const ORIGINAL = { ...process.env };

function callback(sub: string, uid: string, code = "abc") {
  const url = new URL("http://127.0.0.1:3100/api/google/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", signGoogleState({ subAccountId: sub, uid }));
  return CALLBACK(request(url.toString(), uid));
}

function fakeMode(agencyId = "ag_1") {
  process.env.GBP_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.GBP_FAKE_AGENCY_ID = agencyId;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
}

beforeEach(() => {
  resetHarness();
  stubTokenEndpoint({ access_token: "ya29.New", refresh_token: "1//0gNew", expires_in: 3599, scope: SCOPE });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconnect", () => {
  it("clears a previous reconnect-required flag", async () => {
    state.docs.set(SUB_PATH, {
      ...state.docs.get(SUB_PATH),
      googleConnectionMeta: { connected: true, scopes: [SCOPE], reconnectRequired: true, reconnectReason: "revoked" },
    });
    await callback(SUB, "uid_admin");
    expect(state.docs.get(SUB_PATH)?.googleConnectionMeta).toMatchObject({
      connected: true,
      reconnectRequired: false,
      reconnectReason: null,
    });
  });

  it("refuses a grant without business.manage and stores nothing", async () => {
    stubTokenEndpoint({ access_token: "ya29.New", refresh_token: "1//0gNew", expires_in: 3599, scope: "openid" });
    const res = await callback(SUB, "uid_admin");
    expect(res.headers.get("location")).toContain("google=insufficient_scope");
    expect(state.writes).toEqual([]);
  });
});

describe("fake mode", () => {
  it("counts as configured without Google client credentials", () => {
    fakeMode();
    expect(googleAppConfigured()).toBe(true);
    delete process.env.GBP_PROVIDER;
    expect(googleAppConfigured()).toBe(false);
  });

  it("is NOT configured when the fake is requested but refused — even with Google creds", () => {
    fakeMode();
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect(googleAppConfigured()).toBe(false);
  });

  it("connect reports not_configured, rather than a 500, when the fake is refused", async () => {
    fakeMode();
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const res = await CONNECT(
      request(`http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/connect`),
      { params: Promise.resolve({ id: SUB }) },
    );
    expect(res.headers.get("location")).toContain("google=not_configured");
  });

  it("connect skips Google and lands on the callback with a fake code", async () => {
    fakeMode();
    const res = await CONNECT(
      request(`http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/connect?return=gbp`),
      { params: Promise.resolve({ id: SUB }) },
    );
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:3100/api/google/callback");
    expect(location.searchParams.get("code")).toBe(`fake-code:${SUB}`);
  });

  it("callback stores fake tokens in the locked doc only", async () => {
    fakeMode();
    const res = await callback(SUB, "uid_admin", `fake-code:${SUB}`);
    expect(res.headers.get("location")).toContain("google=connected");
    expect(res.headers.get("location")).not.toMatch(TOKEN_MARKERS);
    expect(await res.text()).not.toMatch(TOKEN_MARKERS);
    expect(state.docs.get(SECRET_PATH)).toMatchObject({
      refreshToken: expect.stringMatching(/^fake-refresh:/),
      accessToken: expect.stringMatching(/^fake-access:/),
    });
    expect(JSON.stringify(state.docs.get(SUB_PATH))).not.toMatch(/fake-refresh|fake-access/);
  });

  it("refuses a sub-account of another agency and writes NOTHING", async () => {
    fakeMode();
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client", googleEnabledByAgency: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callback(OTHER_SUB, "uid_other_admin", `fake-code:${OTHER_SUB}`);
    expect(res.headers.get("location")).toContain("google=error");
    expect(state.writes).toEqual([]);
    expect(state.docs.has(`subAccounts/${OTHER_SUB}/private/googleConnection`)).toBe(false);
  });

  it("refuses a code naming another sub-account: nothing stored, nothing of theirs read", async () => {
    fakeMode();
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A valid state for the fixture SUB, but a code minted for OTHER_SUB.
    const res = await callback(SUB, "uid_admin", `fake-code:${OTHER_SUB}`);
    expect(res.headers.get("location")).toContain("google=error");
    expect(state.writes).toEqual([]);
    expect(state.reads.filter((p) => p.startsWith(`subAccounts/${OTHER_SUB}`))).toEqual([]);
  });

  it("connect refuses a sub-account of another agency", async () => {
    fakeMode();
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client", googleEnabledByAgency: true });
    await expect(
      CONNECT(
        request(`http://127.0.0.1:3100/api/sub-accounts/${OTHER_SUB}/google/connect`, "uid_other_admin"),
        { params: Promise.resolve({ id: OTHER_SUB }) },
      ),
    ).rejects.toThrow("GBP fake provider refused");
    expect(state.writes).toEqual([]);
  });
});

describe("reconnect re-verifies the selected listing", () => {
  const seedListing = (locationName: string) =>
    state.docs.set(SUB_PATH, {
      ...state.docs.get(SUB_PATH),
      googleListing: { accountName: DEFAULT_ACCOUNT, locationName, title: "Old" },
    });
  const events = () =>
    [...state.docs.entries()].filter(([p]) => p.startsWith(`${SUB_PATH}/gbpEvents/`)).map(([, d]) => d);

  beforeEach(() => {
    fakeMode();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps a listing the new grant can still see", async () => {
    seedListing(LOC_NORTH);
    const res = await callback(SUB, "uid_admin", `fake-code:${SUB}`);
    expect(res.headers.get("location")).toContain("google=connected");
    expect(state.docs.get(SUB_PATH)?.googleListing).toMatchObject({ locationName: LOC_NORTH });
    expect(events()).toEqual([]);
  });

  it("clears, and audits, a listing the new grant cannot see", async () => {
    seedListing("locations/not-under-this-google-account");
    const res = await callback(SUB, "uid_admin", `fake-code:${SUB}`);
    expect(res.headers.get("location")).toContain("google=connected");
    expect(state.docs.get(SUB_PATH)?.googleListing).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({
        type: "listing_cleared",
        reason: "not_accessible_after_reconnect",
        createdByUid: "uid_admin",
        previousLocationName: "locations/not-under-this-google-account",
      }),
    ]);
  });

  it("keeps the listing, and still connects, when the re-verify itself fails", async () => {
    seedListing("locations/not-under-this-google-account");
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "transient" }));
    const res = await callback(SUB, "uid_admin", `fake-code:${SUB}`);
    expect(res.headers.get("location")).toContain("google=connected");
    expect(state.docs.get(SUB_PATH)?.googleListing).toMatchObject({
      locationName: "locations/not-under-this-google-account",
    });
    expect(state.docs.has(SECRET_PATH)).toBe(true);
  });
});
