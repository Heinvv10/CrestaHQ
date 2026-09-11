import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Token lifecycle through the real provider selection and the real Google
 * token-endpoint code — only `fetch` and Firestore are faked underneath.
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
  resetHarness,
  state,
} from "@/test/google-oauth-harness";
import { GbpFakeRefusedError } from "./provider/select";
import { GbpProviderError } from "./provider/types";
import {
  GbpNotConnectedError,
  getValidAccessToken,
  invalidateAccessToken,
  markReconnectRequiredIf,
} from "./tokens";

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const ORIGINAL = { ...process.env };

function seedSecret(overrides: Record<string, unknown> = {}) {
  state.docs.set(SECRET_PATH, {
    refreshToken: "1//0gStoredRefresh",
    accessToken: "ya29.StoredAccess",
    accessTokenExpiresAt: Date.now() - 1000,
    scopes: [SCOPE],
    ...overrides,
  });
  state.docs.set(SUB_PATH, {
    ...state.docs.get(SUB_PATH),
    googleConnectionMeta: { connected: true, email: null, scopes: [SCOPE], connectedByUid: "uid_admin" },
  });
}

function stubRefresh(body: Record<string, unknown>, status = 200, onCall?: () => void) {
  const spy = vi.fn(async () => {
    onCall?.();
    // Yield so concurrent callers really overlap the in-flight refresh.
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const FRESH = { access_token: "ya29.FreshAccess", expires_in: 3599, scope: SCOPE };

beforeEach(() => {
  resetHarness();
  delete process.env.GBP_PROVIDER;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

const secret = () => state.docs.get(SECRET_PATH) as Record<string, unknown>;
const meta = () => state.docs.get(SUB_PATH)?.googleConnectionMeta as Record<string, unknown>;

describe("getValidAccessToken", () => {
  it("returns the cached token without calling Google while it has >60s left", async () => {
    seedSecret({ accessTokenExpiresAt: Date.now() + 120_000 });
    const spy = stubRefresh(FRESH);
    expect(await getValidAccessToken(SUB)).toBe("ya29.StoredAccess");
    expect(spy).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("refreshes a token inside the 60s margin and stores the new one", async () => {
    seedSecret({ accessTokenExpiresAt: Date.now() + 30_000 });
    const spy = stubRefresh(FRESH);
    expect(await getValidAccessToken(SUB)).toBe("ya29.FreshAccess");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(secret()).toMatchObject({
      accessToken: "ya29.FreshAccess",
      refreshToken: "1//0gStoredRefresh",
      scopes: [SCOPE],
    });
    expect(secret().accessTokenExpiresAt as number).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("shares ONE refresh between concurrent callers", async () => {
    seedSecret();
    const spy = stubRefresh(FRESH);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => getValidAccessToken(SUB)));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(["ya29.FreshAccess"]));
  });

  it("does not keep a settled refresh around: a later expiry refreshes again", async () => {
    seedSecret();
    const spy = stubRefresh({ error: "backend_error" }, 503);
    await expect(getValidAccessToken(SUB)).rejects.toBeInstanceOf(GbpProviderError);
    stubRefresh(FRESH);
    expect(await getValidAccessToken(SUB)).toBe("ya29.FreshAccess");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("persists a rotated refresh token", async () => {
    seedSecret();
    stubRefresh({ ...FRESH, refresh_token: "1//0gRotated" });
    await getValidAccessToken(SUB);
    expect(secret().refreshToken).toBe("1//0gRotated");
  });

  it("adopts a token another writer stored while this refresh was in flight", async () => {
    seedSecret();
    stubRefresh(FRESH, 200, () => {
      state.docs.set(SECRET_PATH, {
        ...secret(),
        accessToken: "ya29.OtherProcess",
        accessTokenExpiresAt: Date.now() + 3_000_000,
      });
    });
    expect(await getValidAccessToken(SUB)).toBe("ya29.OtherProcess");
    expect(secret().accessToken).toBe("ya29.OtherProcess");
  });

  it("never overwrites a refresh token another process rotated underneath", async () => {
    seedSecret();
    stubRefresh({ ...FRESH, refresh_token: "1//0gMineButStale" }, 200, () => {
      state.docs.set(SECRET_PATH, { ...secret(), refreshToken: "1//0gTheirRotation" });
    });
    await getValidAccessToken(SUB);
    expect(secret().refreshToken).toBe("1//0gTheirRotation");
  });

  it("marks reconnect-required on a revoked grant and keeps the secret for revoke", async () => {
    seedSecret();
    stubRefresh({ error: "invalid_grant" }, 400);
    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);
    expect((err as GbpProviderError).kind).toBe("revoked");
    expect(meta()).toMatchObject({ connected: true, reconnectRequired: true, reconnectReason: "revoked" });
    expect(state.docs.has(SECRET_PATH)).toBe(true);
    expect(state.writes.some((w) => w.op === "delete")).toBe(false);
  });

  it("marks insufficient_scope when a refresh comes back without business.manage", async () => {
    seedSecret();
    stubRefresh({ ...FRESH, scope: "openid email" });
    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);
    expect((err as GbpProviderError).kind).toBe("insufficient_scope");
    expect(meta()).toMatchObject({ reconnectRequired: true, reconnectReason: "insufficient_scope" });
    expect(secret().accessToken).toBe("ya29.StoredAccess");
  });

  it("keeps the stored scopes when Google omits the scope field", async () => {
    seedSecret();
    stubRefresh({ access_token: "ya29.FreshAccess", expires_in: 3599 });
    expect(await getValidAccessToken(SUB)).toBe("ya29.FreshAccess");
    expect(secret().scopes).toEqual([SCOPE]);
  });

  it("throws a typed error when there is no secret or no refresh token", async () => {
    stubRefresh(FRESH);
    await expect(getValidAccessToken(SUB)).rejects.toBeInstanceOf(GbpNotConnectedError);
    seedSecret({ refreshToken: "" });
    await expect(getValidAccessToken(SUB)).rejects.toBeInstanceOf(GbpNotConnectedError);
  });

  it("does not resurrect a connection that was disconnected mid-refresh", async () => {
    seedSecret();
    stubRefresh(FRESH, 200, () => state.docs.delete(SECRET_PATH));
    await expect(getValidAccessToken(SUB)).rejects.toBeInstanceOf(GbpNotConnectedError);
    expect(state.docs.has(SECRET_PATH)).toBe(false);
  });
});

function stubSequence(...steps: Array<{ body: Record<string, unknown>; status?: number; onCall?: () => void }>) {
  const queue = [...steps];
  const spy = vi.fn(async () => {
    const step = queue.shift();
    if (!step) throw new Error("unexpected extra token-endpoint call");
    step.onCall?.();
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const NEWER_GRANT = (fresh: boolean) => ({
  refreshToken: "1//0gNewerGrant",
  accessToken: "ya29.NewerGrantAccess",
  accessTokenExpiresAt: Date.now() + (fresh ? 3_000_000 : -1000),
  scopes: [SCOPE],
});

describe("invalidateAccessToken", () => {
  it("expires the cached token only if the secret still holds that token", async () => {
    seedSecret({ accessTokenExpiresAt: Date.now() + 3_000_000 });
    await invalidateAccessToken(SUB, "ya29.SomeoneElses");
    expect(secret().accessTokenExpiresAt as number).toBeGreaterThan(Date.now());
    await invalidateAccessToken(SUB, "ya29.StoredAccess");
    expect(secret().accessTokenExpiresAt).toBe(0);
    expect(secret().refreshToken).toBe("1//0gStoredRefresh");
  });
});

describe("markReconnectRequiredIf by access token", () => {
  it("flags only when the refused access token is still the stored one", async () => {
    seedSecret({ accessTokenExpiresAt: Date.now() + 3_000_000 });
    expect(await markReconnectRequiredIf(SUB, "insufficient_scope", { accessToken: "ya29.Old" })).toMatchObject({
      accessToken: "ya29.StoredAccess",
    });
    expect(meta().reconnectRequired).toBeUndefined();
    expect(await markReconnectRequiredIf(SUB, "insufficient_scope", { accessToken: "ya29.StoredAccess" })).toBeNull();
    expect(meta()).toMatchObject({ reconnectRequired: true, reconnectReason: "insufficient_scope" });
  });
});

describe("races with a newer grant (reconnect during a refresh)", () => {
  it("does not flag reconnect when a stale refresh token is revoked but a newer grant is stored", async () => {
    seedSecret();
    stubSequence({ body: { error: "invalid_grant" }, status: 400, onCall: () => state.docs.set(SECRET_PATH, NEWER_GRANT(true)) });
    expect(await getValidAccessToken(SUB)).toBe("ya29.NewerGrantAccess");
    expect(meta().reconnectRequired).toBeUndefined();
  });

  it("retries once with the newer grant when its access token also needs a refresh", async () => {
    seedSecret();
    const spy = stubSequence(
      { body: { error: "invalid_grant" }, status: 400, onCall: () => state.docs.set(SECRET_PATH, NEWER_GRANT(false)) },
      { body: FRESH },
    );
    expect(await getValidAccessToken(SUB)).toBe("ya29.FreshAccess");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(secret().refreshToken).toBe("1//0gNewerGrant");
    expect(meta().reconnectRequired).toBeUndefined();
  });

  it("retries at most ONCE, even if the grant keeps changing underneath", async () => {
    seedSecret();
    const third = { ...NEWER_GRANT(false), refreshToken: "1//0gThirdGrant" };
    const spy = stubSequence(
      { body: { error: "invalid_grant" }, status: 400, onCall: () => state.docs.set(SECRET_PATH, NEWER_GRANT(false)) },
      { body: { error: "invalid_grant" }, status: 400, onCall: () => state.docs.set(SECRET_PATH, third) },
    );
    const err = await getValidAccessToken(SUB).catch((e: unknown) => e);
    expect((err as GbpProviderError).kind).toBe("revoked");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not flag insufficient_scope from a stale grant either", async () => {
    seedSecret();
    stubSequence({ body: { ...FRESH, scope: "openid" }, onCall: () => state.docs.set(SECRET_PATH, NEWER_GRANT(true)) });
    expect(await getValidAccessToken(SUB)).toBe("ya29.NewerGrantAccess");
    expect(meta().reconnectRequired).toBeUndefined();
  });

  it("persists a rotated refresh token even when another writer stored a fresh access token", async () => {
    seedSecret();
    stubSequence({
      body: { ...FRESH, refresh_token: "1//0gRotatedR2" },
      // Another process refreshed with the SAME refresh token meanwhile.
      onCall: () =>
        state.docs.set(SECRET_PATH, { ...secret(), accessToken: "ya29.OtherProcess", accessTokenExpiresAt: Date.now() + 3_000_000 }),
    });
    expect(await getValidAccessToken(SUB)).toBe("ya29.OtherProcess");
    expect(secret()).toMatchObject({ accessToken: "ya29.OtherProcess", refreshToken: "1//0gRotatedR2" });
  });
});

describe("fake mode fence", () => {
  it("refuses a sub-account outside the fixture agency and writes nothing", async () => {
    process.env.GBP_PROVIDER = "fake";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    process.env.GBP_FAKE_AGENCY_ID = "ag_fixture_only";
    seedSecret();
    const spy = stubRefresh(FRESH);
    await expect(getValidAccessToken(SUB)).rejects.toBeInstanceOf(GbpFakeRefusedError);
    expect(spy).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
