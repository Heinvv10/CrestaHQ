import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/google/locations — the listing picker's data.
 * Real route → real requireSubAccountAdmin → real gate → real token lifecycle
 * → real (fake-mode) provider; only Firestore is faked.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import { OTHER_SUB, SUB, SUB_PATH, request, resetHarness, state } from "@/test/google-oauth-harness";
import {
  DEFAULT_ACCOUNT,
  TOKEN_MARKERS,
  enableFakeMode,
  seedConnection,
  setScenario,
} from "@/test/gbp-route-harness";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

async function list(uid = "uid_admin", sub = SUB) {
  const res = await GET(
    request(`http://127.0.0.1:3100/api/sub-accounts/${sub}/google/locations`, uid),
    { params: Promise.resolve({ id: sub }) },
  );
  const text = await res.text();
  // No response from this route may ever carry a credential.
  expect(text).not.toMatch(TOKEN_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("authorization", () => {
  it.each([
    ["a non-member", "uid_other_admin"],
    ["a collaborator", "uid_collab"],
    ["a plain member", "uid_member"],
  ])("refuses %s", async (_label, uid) => {
    expect((await list(uid)).status).toBe(403);
  });

  it("refuses with gate_off when the agency gate is off", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleEnabledByAgency: false });
    const { status, body } = await list();
    expect(status).toBe(403);
    expect(body.code).toBe("gate_off");
  });
});

describe("states", () => {
  it("reports not_configured when the deployment has no Google client", async () => {
    delete process.env.GBP_PROVIDER;
    delete process.env.GOOGLE_CLIENT_ID;
    const { status, body } = await list();
    expect([status, body.code]).toEqual([503, "not_configured"]);
  });

  it("reports not_connected without a connection", async () => {
    state.docs.set(SUB_PATH, { agencyId: "ag_1", googleEnabledByAgency: true });
    const { status, body } = await list();
    expect([status, body.code]).toEqual([409, "not_connected"]);
  });

  it("reports reconnect_required without calling Google when already flagged", async () => {
    seedConnection({ reconnectRequired: true });
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "transient" }));
    const { status, body } = await list();
    expect([status, body.code]).toEqual([409, "reconnect_required"]);
    // The scripted failure was never consumed — Google was not called.
    expect(state.docs.get(`subAccounts/${SUB}/private/gbpFakeScenario`)?.failNext).toBeDefined();
  });

  it("flags and reports reconnect_required when the refresh is revoked", async () => {
    seedConnection({ expired: true });
    setScenario((s) => (s.revoked = true));
    const { status, body } = await list();
    expect([status, body.code]).toEqual([409, "reconnect_required"]);
    expect(state.docs.get(SUB_PATH)?.googleConnectionMeta).toMatchObject({ reconnectRequired: true });
  });

  it("flags reconnect when a DATA call reports insufficient scope", async () => {
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "insufficient_scope" }));
    const { status, body } = await list();
    expect([status, body.code]).toEqual([409, "reconnect_required"]);
    expect(state.docs.get(SUB_PATH)?.googleConnectionMeta).toMatchObject({
      reconnectRequired: true,
      reconnectReason: "insufficient_scope",
    });
  });

  it("maps other provider errors to 502 with only the kind", async () => {
    setScenario((s) => (s.failNext = { op: "listLocations", kind: "rate_limited" }));
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(body).toEqual({ error: "Google request failed", code: "rate_limited" });
  });
});

describe("discovery", () => {
  it("returns every account with identifying location details", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body).toEqual({
      truncated: false,
      accounts: [
        {
          name: DEFAULT_ACCOUNT,
          accountName: "E2E Fixture Group",
          locations: [
            {
              name: "locations/e2e-velo-gqeberha",
              title: "Velo Test Fibre — Gqeberha",
              address: "1 Fixture Road, Gqeberha, 6001",
              websiteUri: "https://gqeberha.fixture.example",
              placeId: "fake-place-gqeberha",
              mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha",
            },
            {
              name: "locations/e2e-velo-gqeberha-north",
              title: "Velo Test Fibre — Gqeberha North",
              address: "9 Fixture Avenue, Gqeberha North, 6100",
              websiteUri: "https://north.fixture.example",
              placeId: "fake-place-gqeberha-north",
              mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha-north",
            },
          ],
        },
      ],
    });
  });

  it("walks every page of accounts and of locations", async () => {
    setScenario((s) => {
      const base = s.locations[DEFAULT_ACCOUNT][0];
      for (let i = 0; i < 4; i++) {
        const name = `accounts/extra-${i}`;
        s.accounts.push({ name, accountName: `Extra ${i}`, type: "PERSONAL" });
        s.locations[name] = Array.from({ length: 7 }, (_, j) => ({ ...base, name: `locations/x-${i}-${j}` }));
      }
    });
    const { body } = await list();
    const accounts = body.accounts as Array<{ locations: unknown[] }>;
    expect(accounts).toHaveLength(5);
    expect(accounts.slice(1).every((a) => a.locations.length === 7)).toBe(true);
    expect(body.truncated).toBe(false);
  });

  it("stops after 20 pages and says so", async () => {
    setScenario((s) => {
      for (let i = 0; i < 70; i++) {
        s.accounts.push({ name: `accounts/many-${i}`, accountName: `Many ${i}`, type: "PERSONAL" });
      }
    });
    const { body } = await list();
    expect((body.accounts as unknown[]).length).toBe(60);
    expect(body.truncated).toBe(true);
  });

  it("refuses in fake mode for a sub-account outside the fixture agency", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, {
      agencyId: "ag_real_client",
      googleEnabledByAgency: true,
      googleConnectionMeta: { connected: true },
    });
    state.docs.set(`subAccounts/${OTHER_SUB}/private/googleConnection`, {
      refreshToken: `fake-refresh:${OTHER_SUB}:1`,
      accessToken: `fake-access:${OTHER_SUB}:1`,
      accessTokenExpiresAt: Date.now() + 3_600_000,
      scopes: [],
    });
    await expect(
      GET(request(`http://127.0.0.1:3100/api/sub-accounts/${OTHER_SUB}/google/locations`, "uid_other_admin"), {
        params: Promise.resolve({ id: OTHER_SUB }),
      }),
    ).rejects.toThrow("GBP fake provider refused");
  });
});
