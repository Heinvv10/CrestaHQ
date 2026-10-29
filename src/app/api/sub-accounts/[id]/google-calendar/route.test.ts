import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Calendar connection routes (SP3 G1/G4): connect → shared callback →
 * status → disconnect, driven through the REAL routes with the real tenancy
 * guard over faked Firestore (google-oauth-harness).
 *
 * The load-bearing invariants:
 *   - the shared callback routes by the SIGNED purpose: a GBP state still does
 *     exactly the GBP connect, a calendar state only ever writes the member's
 *     own `private/googleCalendar_{uid}`;
 *   - every route but DELETE is refused while the agency gate is off;
 *   - no token ever leaves the server.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import { SECRET_PATH, SUB, SUB_PATH, request, resetHarness, state } from "@/test/google-oauth-harness";
import { signGoogleState, verifyGoogleState } from "@/lib/google/oauth";
import { GCAL_SCOPE } from "@/lib/google-calendar/scopes";
import { GET as CALLBACK } from "../../../google/callback/route";
import { GET as GBP_CONNECT } from "../google/connect/route";
import { GET as CONNECT } from "./connect/route";
import { DELETE, GET } from "./route";

const params = { params: Promise.resolve({ id: SUB }) };
const CAL_PATH = (uid: string) => `subAccounts/${SUB}/private/googleCalendar_${uid}`;
const TOKEN_MARKERS = /1\/\/0gCal|ya29\.Cal|refreshToken|accessToken/;

type Route = { match: RegExp; status?: number; body: unknown };
let calls: string[] = [];

/** Route fetch by URL: the token endpoint, userinfo, revoke. */
function stubGoogle(routes: Route[]) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const r = routes.find((x) => x.match.test(String(url)));
      if (!r) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
}

const TOKEN = {
  access_token: "ya29.CalAccess",
  refresh_token: "1//0gCalRefresh",
  expires_in: 3599,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${GCAL_SCOPE}`,
};
const GOOGLE_OK: Route[] = [
  { match: /oauth2\.googleapis\.com\/token/, body: TOKEN },
  { match: /userinfo/, body: { email: "host@example.com" } },
  { match: /oauth2\.googleapis\.com\/revoke/, body: {} },
];

function callback(stateValue: string, uid: string, code = "abc") {
  const url = new URL("http://app.local/api/google/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", stateValue);
  return CALLBACK(request(url.toString(), uid));
}

const calState = (uid = "uid_member") => signGoogleState({ subAccountId: SUB, uid, purpose: "calendar" });
const gcal = (res: Response) => new URL(res.headers.get("location") as string).searchParams.get("gcal");

beforeEach(() => {
  resetHarness();
  state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: true });
  stubGoogle(GOOGLE_OK);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("state purpose", () => {
  it("round-trips purpose: calendar, and a GBP state carries no purpose at all", () => {
    expect(verifyGoogleState(calState())?.purpose).toBe("calendar");
    const gbp = signGoogleState({ subAccountId: SUB, uid: "uid_admin" });
    const payload = JSON.parse(Buffer.from(gbp.split(".")[0], "base64url").toString());
    expect(payload).not.toHaveProperty("p");
    expect(verifyGoogleState(gbp)).toEqual({ subAccountId: SUB, uid: "uid_admin", returnTo: "settings" });
  });

  it("the GBP connect route still mints a purpose-less state", async () => {
    const res = await GBP_CONNECT(request(`http://app.local/api/sub-accounts/${SUB}/google/connect`, "uid_admin"), params);
    const s = new URL(res.headers.get("location") as string).searchParams.get("state") as string;
    expect(JSON.parse(Buffer.from(s.split(".")[0], "base64url").toString())).not.toHaveProperty("p");
    expect(new URL(res.headers.get("location") as string).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/business.manage",
    );
  });

  it("a GBP state through the callback does the GBP connect and writes no calendar doc", async () => {
    stubGoogle([{ match: /token/, body: { ...TOKEN, scope: "https://www.googleapis.com/auth/business.manage" } }]);
    const res = await callback(signGoogleState({ subAccountId: SUB, uid: "uid_admin" }), "uid_admin");
    expect(new URL(res.headers.get("location") as string).searchParams.get("google")).toBe("connected");
    expect(state.docs.has(SECRET_PATH)).toBe(true);
    expect(state.writes.some((w) => w.path.includes("googleCalendar_"))).toBe(false);
  });

  it("a calendar state never writes the GBP connection", async () => {
    await callback(calState(), "uid_member");
    expect(state.docs.has(SECRET_PATH)).toBe(false);
    expect(state.docs.get(SUB_PATH)).not.toHaveProperty("googleConnectionMeta");
  });
});

describe("connect", () => {
  const connect = (uid = "uid_member") =>
    CONNECT(request(`http://app.local/api/sub-accounts/${SUB}/google-calendar/connect`, uid), params);

  it("sends any member to Google with the calendar scopes, offline + forced consent", async () => {
    const res = await connect();
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("scope")).toBe(`openid email ${GCAL_SCOPE}`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://app.local/api/google/callback");
    expect(verifyGoogleState(loc.searchParams.get("state") as string)).toMatchObject({
      uid: "uid_member",
      purpose: "calendar",
    });
  });

  it("refuses with gate_off while the gate is off (the GBP gate does not count)", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: false });
    expect(gcal(await connect())).toBe("gate_off");
  });

  it("refuses a non-member", async () => {
    expect((await connect("uid_other_admin")).status).toBe(403);
  });
});

describe("callback (calendar purpose)", () => {
  it("a first connect starts the import generation at 1", async () => {
    await callback(calState(), "uid_member");
    expect(state.docs.get(CAL_PATH("uid_member"))?.importGeneration).toBe(1);
  });

  it("stores the member's own connection with the Google email, and nothing on the sub-account doc", async () => {
    const res = await callback(calState(), "uid_member");
    expect(gcal(res)).toBe("connected");
    expect(res.headers.get("location")).toBe(`http://app.local/sa/${SUB}/dashboard/settings?gcal=connected`);
    expect(state.docs.get(CAL_PATH("uid_member"))).toMatchObject({
      uid: "uid_member",
      subAccountId: SUB,
      agencyId: "ag_1",
      googleEmail: "host@example.com",
      refreshToken: "1//0gCalRefresh",
      status: "connected",
      lastError: null,
    });
    expect(JSON.stringify(state.docs.get(SUB_PATH))).not.toMatch(TOKEN_MARKERS);
  });

  it("a reconnect replaces the import opt-in, and the member's imported events go with it", async () => {
    const imp = (uid: string) => ({ subAccountId: SUB, source: "google", importOwnerUid: uid, title: "Busy" });
    state.docs.set(CAL_PATH("uid_member"), { uid: "uid_member", status: "revoked", importMode: "details", importGeneration: 3 });
    state.docs.set("events/gcal_mine", imp("uid_member"));
    state.docs.set("events/gcal_colleague", imp("uid_admin"));
    state.docs.set("events/manual", { subAccountId: SUB, title: "Call", importOwnerUid: "uid_member" });
    expect(gcal(await callback(calState(), "uid_member"))).toBe("connected");
    expect(state.docs.get(CAL_PATH("uid_member"))).not.toHaveProperty("importMode");
    // Carried forward and bumped: a pass started under the old connection never sees 3 again.
    expect(state.docs.get(CAL_PATH("uid_member"))?.importGeneration).toBe(4);
    expect(state.docs.has("events/gcal_mine")).toBe(false);
    expect(state.docs.has("events/gcal_colleague")).toBe(true);
    expect(state.docs.has("events/manual")).toBe(true);
  });

  it("refuses a state replayed by a different member, writing nothing", async () => {
    const res = await callback(calState("uid_member"), "uid_admin");
    expect(gcal(res)).toBe("bad_state");
    expect(state.writes).toEqual([]);
  });

  it("refuses when the gate is off, writing nothing", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: false });
    state.writes = [];
    expect(gcal(await callback(calState(), "uid_member"))).toBe("gate_off");
    expect(state.writes).toEqual([]);
  });

  it("refuses a grant without calendar.events, and one without a refresh token", async () => {
    stubGoogle([{ match: /token/, body: { ...TOKEN, scope: "openid email" } }]);
    expect(gcal(await callback(calState(), "uid_member"))).toBe("insufficient_scope");
    stubGoogle([{ match: /token/, body: { ...TOKEN, refresh_token: undefined } }]);
    expect(gcal(await callback(calState(), "uid_member"))).toBe("no_refresh_token");
    expect(state.docs.has(CAL_PATH("uid_member"))).toBe(false);
  });

  it("a declined consent stores nothing", async () => {
    const url = new URL("http://app.local/api/google/callback");
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", calState());
    expect(gcal(await CALLBACK(request(url.toString(), "uid_member")))).toBe("cancelled");
    expect(state.docs.has(CAL_PATH("uid_member"))).toBe(false);
  });
});

describe("status + disconnect", () => {
  const status = (uid = "uid_member") =>
    GET(request(`http://app.local/api/sub-accounts/${SUB}/google-calendar`, uid), params);
  const disconnect = (uid = "uid_member") =>
    DELETE(request(`http://app.local/api/sub-accounts/${SUB}/google-calendar`, uid, "DELETE"), params);

  beforeEach(async () => {
    await callback(calState(), "uid_member");
  });

  it("returns the caller's own connection, never a token, never a colleague's", async () => {
    const res = await status();
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ connected: true, status: "connected", googleEmail: "host@example.com" });
    expect(text).not.toMatch(TOKEN_MARKERS);
    expect(await (await status("uid_admin")).json()).toMatchObject({ connected: false, status: null });
  });

  it("with the gate off, GET says only gateOff + the caller's stored connection (for Disconnect)", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: false });
    const text = await (await status()).text();
    expect(JSON.parse(text)).toEqual({ gateOff: true, connected: true, googleEmail: "host@example.com" });
    expect(text).not.toMatch(TOKEN_MARKERS);
    expect(await (await status("uid_admin")).json()).toEqual({ gateOff: true, connected: false, googleEmail: null });
  });

  it("DELETE also removes the caller's imported events, with the gate off too", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: false });
    state.docs.set("events/gcal_mine", { subAccountId: SUB, source: "google", importOwnerUid: "uid_member" });
    state.docs.set("events/gcal_colleague", { subAccountId: SUB, source: "google", importOwnerUid: "uid_admin" });
    expect((await disconnect()).status).toBe(200);
    expect(state.docs.has("events/gcal_mine")).toBe(false);
    expect(state.docs.has("events/gcal_colleague")).toBe(true);
  });

  it("DELETE is ungated, removes only the caller's doc, and never revokes at Google", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleCalendarEnabledByAgency: false });
    state.docs.set(CAL_PATH("uid_admin"), { uid: "uid_admin", refreshToken: "other" });
    stubGoogle(GOOGLE_OK);
    expect((await disconnect()).status).toBe(200);
    // Same OAuth client as GBP: a revoke would end the whole grant.
    expect(calls).toEqual([]);
    expect(state.docs.has(CAL_PATH("uid_member"))).toBe(false);
    expect(state.docs.has(CAL_PATH("uid_admin"))).toBe(true);
  });
});
