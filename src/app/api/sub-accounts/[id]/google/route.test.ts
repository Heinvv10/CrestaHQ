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
import { CLEARED, TOKEN_MARKERS, cacheLeft, seedSyncedCache } from "@/test/gbp-route-harness";
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
    expect(await res.text()).not.toMatch(TOKEN_MARKERS);
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
        data: {
          googleConnectionMeta: null,
          // The chosen listing belongs to the connection it was picked through.
          googleListing: null,
          updatedAt: "SERVER_TS",
        },
      },
      // The listing's synced review cache goes with it: take the lease,
      // delete, drop the summary, then the sync state (and lease) last.
      {
        op: "set",
        path: `${SUB_PATH}/private/gbpSyncState`,
        data: { lease: { runId: "clearing", until: expect.any(Number) } },
      },
      { op: "set", path: SUB_PATH, data: { gbpSummary: null } },
      { op: "delete", path: `${SUB_PATH}/private/gbpSyncState` },
    ]);
  });

  it("audits the listing it clears on disconnect", async () => {
    state.docs.set(SUB_PATH, {
      ...state.docs.get(SUB_PATH),
      googleListing: { locationName: "locations/l1", accountName: "accounts/a1" },
    });
    await disconnect();
    const events = [...state.docs.entries()]
      .filter(([p]) => p.startsWith(`${SUB_PATH}/gbpEvents/`))
      .map(([, d]) => d);
    expect(events).toEqual([
      expect.objectContaining({
        type: "listing_cleared",
        reason: "disconnected",
        agencyId: "ag_1",
        subAccountId: SUB,
        createdByUid: "uid_admin",
        previousLocationName: "locations/l1",
      }),
    ]);
    expect(state.docs.get(SUB_PATH)?.googleListing).toBeNull();
  });

  it("clears the review cache, summary and sync state", async () => {
    seedSyncedCache();
    await disconnect();
    expect(cacheLeft()).toEqual(CLEARED);
  });

  it("still clears local state when the revoke fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(state.writes.map((w) => w.op)).toEqual(["delete", "set", "set", "set", "delete"]);
  });

  it("refuses in fake mode for a sub-account outside the fixture agency, touching nothing", async () => {
    process.env.GBP_PROVIDER = "fake";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    process.env.GBP_FAKE_AGENCY_ID = "ag_fixture_only";
    await expect(disconnect()).rejects.toThrow("GBP fake provider refused");
    expect(state.writes).toEqual([]);
    delete process.env.GBP_PROVIDER;
    delete process.env.GBP_FAKE_AGENCY_ID;
  });

  it("still disconnects locally when the deployment's fake provider is refused", async () => {
    // GBP_PROVIDER=fake on a non-loopback URL: no provider can be used here,
    // so there is nothing to revoke with — but the local connection must still
    // be removable (it is the "not configured" state's Disconnect button).
    process.env.GBP_PROVIDER = "fake";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    // A misconfigured deployment carries no fixture agency: the fence must NOT
    // apply here (the tenant is the deployment's own).
    delete process.env.GBP_FAKE_AGENCY_ID;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear(); // earlier tests in this file share the spy
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(state.docs.has(SECRET_PATH)).toBe(false);
    expect(state.docs.get(SUB_PATH)?.googleConnectionMeta).toBeNull();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // Revoke was skipped, not attempted-and-failed.
    expect(warn.mock.calls.flat().join(" ")).not.toContain("revoke failed");
    delete process.env.GBP_PROVIDER;
    delete process.env.GBP_FAKE_AGENCY_ID;
  });

  describe("a refused fake on a DEV machine (loopback app URL) still honours the fixture fence", () => {
    const devRefused = (agencyId?: string) => {
      process.env.GBP_PROVIDER = "fake";
      process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
      // Refused because it is a production build without the opt-in.
      (process.env as Record<string, string>).NODE_ENV = "production";
      delete process.env.GBP_FAKE_ALLOW_PROD_BUILD;
      if (agencyId === undefined) delete process.env.GBP_FAKE_AGENCY_ID;
      else process.env.GBP_FAKE_AGENCY_ID = agencyId;
    };
    afterEach(() => {
      (process.env as Record<string, string>).NODE_ENV = "test";
      delete process.env.GBP_PROVIDER;
      delete process.env.GBP_FAKE_AGENCY_ID;
    });

    it.each(["http://0.0.0.0:4300", "http://foo.localhost:4300", "not a url"])(
      "treats %s as a dev machine too (the WIDE rule — fail toward fencing)",
      async (url) => {
        devRefused(undefined);
        process.env.NEXT_PUBLIC_APP_URL = url;
        await expect(disconnect()).rejects.toThrow("GBP fake provider refused");
        expect(state.writes).toEqual([]);
      },
    );

    it("refuses, touching nothing, when no fixture agency is configured", async () => {
      devRefused(undefined);
      await expect(disconnect()).rejects.toThrow("GBP fake provider refused");
      expect(state.writes).toEqual([]);
    });

    it("refuses, touching nothing, for a sub-account of another agency", async () => {
      devRefused("ag_fixture_only");
      await expect(disconnect()).rejects.toThrow("GBP fake provider refused");
      expect(state.writes).toEqual([]);
    });

    it("clears the fixture sub-account locally, without a revoke", async () => {
      devRefused("ag_1");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await disconnect()).status).toBe(200);
      expect(state.docs.has(SECRET_PATH)).toBe(false);
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  it("works while the agency gate is off, so a connection is never stranded", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1", googleEnabledByAgency: false });
    expect((await disconnect()).status).toBe(200);
    expect(state.writes.map((w) => w.op)).toEqual(["delete", "set", "set", "set", "delete"]);
  });
});
