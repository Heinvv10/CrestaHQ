import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Token refresh (G4), the reconnect race, and the aborting time budget. */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { state } from "@/test/google-oauth-harness";
import { CAL, conn, connect, resetGcal, stubProvider, type StubProvider } from "@/test/gcal-harness";
import { GbpProviderError } from "@/lib/gbp/provider/types";
import { GoogleCalendarTimeoutError, withBudget, withGoogleToken } from "./connection";
import type { GcalProvider } from "./provider/types";

let provider: StubProvider;
const run = <T,>(fn: (t: string) => Promise<T>) => withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, fn);

beforeEach(() => {
  resetGcal();
  provider = stubProvider();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("token refresh (G4)", () => {
  it("uses the cached access token while more than a minute is left", async () => {
    connect("host_a");
    expect(await run(async (t) => t)).toBe("a-host_a");
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("refreshes under a minute left, storing the new token and a rotated refresh token", async () => {
    connect("host_a", { accessTokenExpiresAt: Date.now() + 30_000 });
    provider.refresh.mockResolvedValueOnce({ accessToken: "fresh", refreshToken: "rotated", expiresAt: 123, scopes: [] });
    expect(await run(async (t) => t)).toBe("fresh");
    expect(state.docs.get(CAL("host_a"))).toMatchObject({ accessToken: "fresh", refreshToken: "rotated", accessTokenExpiresAt: 123 });
  });

  it("invalid_grant marks the connection revoked with a lastError, and rethrows", async () => {
    connect("host_a", { accessTokenExpiresAt: 0 });
    provider.refresh.mockRejectedValueOnce(new GbpProviderError("revoked", { status: 400 }));
    await expect(run(async (t) => t)).rejects.toThrow();
    expect(state.docs.get(CAL("host_a"))).toMatchObject({ status: "revoked", lastError: expect.stringContaining("Reconnect") });
  });

  it("does not mark a grant the member replaced meanwhile (reconnect race)", async () => {
    connect("host_a", { accessTokenExpiresAt: 0 });
    const stale = conn("host_a");
    provider.refresh.mockImplementationOnce(async () => {
      // The member reconnects while the old refresh token is being refused.
      state.docs.set(CAL("host_a"), { ...state.docs.get(CAL("host_a")), refreshToken: "brand-new" });
      throw new GbpProviderError("revoked", { status: 400 });
    });
    await expect(withGoogleToken(stale, provider as unknown as GcalProvider, async (t) => t)).rejects.toThrow();
    expect(state.docs.get(CAL("host_a"))).toMatchObject({ status: "connected", refreshToken: "brand-new" });
  });

  it("a 401 on a still-cached token earns exactly one forced refresh and a retry", async () => {
    connect("host_a");
    const fn = vi.fn(async (t: string) => {
      if (t === "a-host_a") throw new GbpProviderError("auth_expired", { status: 401 });
      return t;
    });
    expect(await run(fn)).toBe("fresh");
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes the budget's signal to the refresh", async () => {
    connect("host_a", { accessTokenExpiresAt: 0 });
    const ac = new AbortController();
    await withGoogleToken(conn("host_a"), provider as unknown as GcalProvider, async (t) => t, ac.signal);
    expect(provider.refresh).toHaveBeenCalledWith("r-host_a", ac.signal);
  });
});

describe("withBudget", () => {
  it("rejects on expiry AND aborts the in-flight work", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withBudget(1_000, (signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const assertion = expect(p).rejects.toBeInstanceOf(GoogleCalendarTimeoutError);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });
});
