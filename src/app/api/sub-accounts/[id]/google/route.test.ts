import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route tests for the Google connect starter and its disconnect sibling.
 *
 * Connect must never reach Google unless the caller is an admin OF THIS
 * sub-account and the agency gate is on. Disconnect is deliberately UNGATED on
 * the agency flag (so a connection can always be cleaned up) but still
 * admin-only.
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
} from "@/test/google-oauth-harness";
import { verifyGoogleState } from "@/lib/google/oauth";
import { GET as CONNECT } from "./connect/route";
import { DELETE } from "./route";

const CONNECT_URL = `http://app.local/api/sub-accounts/${SUB}/google/connect`;
const DISCONNECT_URL = `http://app.local/api/sub-accounts/${SUB}/google`;
const SETTINGS = `http://app.local/sa/${SUB}/dashboard/settings`;

const connect = (uid = "uid_admin") =>
  CONNECT(request(CONNECT_URL, uid), { params: Promise.resolve({ id: SUB }) });

const disconnect = (uid = "uid_admin") =>
  DELETE(request(DISCONNECT_URL, uid, "DELETE"), {
    params: Promise.resolve({ id: SUB }),
  });

beforeEach(() => {
  resetHarness();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect", () => {
  it("redirects to Google with a state that names THIS sub-account", async () => {
    const res = await connect();
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(
      verifyGoogleState(location.searchParams.get("state") as string),
    ).toEqual({ subAccountId: SUB, uid: "uid_admin", returnTo: "settings" });
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://app.local/api/google/callback",
    );
    expect(state.writes).toEqual([]);
  });

  it("refuses a member who is not an admin", async () => {
    const res = await connect("uid_member");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an admin of a DIFFERENT sub-account", async () => {
    const res = await connect("uid_other_admin");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not reach Google when the agency gate is off", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1" });
    const res = await connect();
    expect(res.headers.get("location")).toBe(`${SETTINGS}?google=gate_off`);
  });

  it("does not reach Google when the deployment has no OAuth client", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await connect();
    expect(res.headers.get("location")).toBe(
      `${SETTINGS}?google=not_configured`,
    );
  });

  it("does not reach Google when there is no app URL to build a redirect from", async () => {
    // Guessing a redirect_uri would just fail Google's exact match; better to
    // say "not configured" than to bounce the admin off an error page.
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = await connect();
    expect(
      new URL(res.headers.get("location") as string).searchParams.get("google"),
    ).toBe("not_configured");
  });
});

describe("disconnect", () => {
  beforeEach(() => {
    state.docs.set(SECRET_PATH, {
      refreshToken: "1//0gRefreshToken",
      accessToken: "ya29.Access",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      scopes: ["https://www.googleapis.com/auth/business.manage"],
    });
  });

  it("refuses a non-admin member, and writes nothing", async () => {
    const res = await disconnect("uid_member");
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("refuses an admin of a DIFFERENT sub-account, and writes nothing", async () => {
    const res = await disconnect("uid_other_admin");
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("revokes at Google, deletes the secret, and clears the meta", async () => {
    const res = await disconnect();
    expect(res.status).toBe(200);
    const fetchSpy = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchSpy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke");
    expect((fetchSpy.mock.calls[0][1].body as URLSearchParams).get("token")).toBe(
      "1//0gRefreshToken",
    );
    expect(state.writes).toEqual([
      { op: "delete", path: SECRET_PATH },
      {
        op: "set",
        path: SUB_PATH,
        data: { googleConnectionMeta: null, updatedAt: "SERVER_TS" },
      },
    ]);
  });

  it("still clears local state when the revoke fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(state.writes.map((w) => w.op)).toEqual(["delete", "set"]);
  });

  it("works while the agency gate is off, so a connection is never stranded", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1", googleEnabledByAgency: false });
    expect((await disconnect()).status).toBe(200);
    expect(state.writes.map((w) => w.op)).toEqual(["delete", "set"]);
  });
});
