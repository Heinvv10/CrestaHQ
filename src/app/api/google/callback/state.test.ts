import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OAuth `state` round trip, driven through BOTH real routes: the state the
 * connect route mints is the one the callback must accept. A unit test of the
 * sign/verify pair alone would pass while the connect route signed something
 * the callback could never verify.
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
  request,
  resetHarness,
  state,
  stubTokenEndpoint,
} from "@/test/google-oauth-harness";
import { GET as CONNECT } from "../../sub-accounts/[id]/google/connect/route";
import { GET as CALLBACK } from "./route";

const TOKEN_RESPONSE = {
  access_token: "ya29.RoundTripAccess",
  refresh_token: "1//0gRoundTripRefresh",
  expires_in: 3599,
  scope: "https://www.googleapis.com/auth/business.manage",
};

async function mintState(uid = "uid_admin", query = ""): Promise<string> {
  const res = await CONNECT(
    request(`http://app.local/api/sub-accounts/${SUB}/google/connect${query}`, uid),
    { params: Promise.resolve({ id: SUB }) },
  );
  const location = new URL(res.headers.get("location") as string);
  return location.searchParams.get("state") as string;
}

function callback(stateValue: string, uid = "uid_admin") {
  const url = new URL("http://app.local/api/google/callback");
  url.searchParams.set("code", "abc");
  url.searchParams.set("state", stateValue);
  return CALLBACK(request(url.toString(), uid));
}

beforeEach(() => {
  resetHarness();
  stubTokenEndpoint(TOKEN_RESPONSE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("state minted by connect, accepted by callback", () => {
  it("connects when the same admin completes the flow", async () => {
    const stateValue = await mintState();
    const res = await callback(stateValue);
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=connected`,
    );
    expect(state.writes.some((w) => w.path === SECRET_PATH)).toBe(true);
  });

  it("bounces a state whose signature was altered, writing nothing", async () => {
    const stateValue = await mintState();
    const last = stateValue.slice(-1);
    const altered = stateValue.slice(0, -1) + (last === "a" ? "b" : "a");
    const res = await callback(altered);
    expect(res.headers.get("location")).toBe(
      "http://app.local/agency/sub-accounts?google=bad_state",
    );
    expect(state.writes).toEqual([]);
  });
});

describe("state hardening", () => {
  it("bounces a state replayed by a DIFFERENT admin of the same sub-account", async () => {
    // uid_admin2 passes requireSubAccountAdmin for SUB — only the uid binding
    // in the state stops them completing a flow uid_admin started.
    const stateValue = await mintState("uid_admin");
    const res = await callback(stateValue, "uid_admin2");
    expect(res.headers.get("location")).toBe(
      "http://app.local/agency/sub-accounts?google=bad_state",
    );
    expect(state.writes).toEqual([]);
  });

  it("still refuses a non-member presenting another sub-account's state", async () => {
    const stateValue = await mintState("uid_admin");
    const res = await callback(stateValue, "uid_other_admin");
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it("bounces a state older than ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 11, 12, 0, 0));
    const stateValue = await mintState();
    vi.setSystemTime(Date.UTC(2026, 8, 11, 12, 10, 1));
    const res = await callback(stateValue);
    expect(res.headers.get("location")).toContain("google=bad_state");
    expect(state.writes).toEqual([]);
  });

  it("reports not_configured from connect, and bad_state from callback, with no state secret", async () => {
    const minted = await mintState();
    process.env.AUTOMATIONS_TOKEN_SECRET = "";
    const res = await CONNECT(
      request(`http://app.local/api/sub-accounts/${SUB}/google/connect`),
      { params: Promise.resolve({ id: SUB }) },
    );
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=not_configured`,
    );
    expect((await callback(minted)).headers.get("location")).toContain(
      "google=bad_state",
    );
    expect(state.writes).toEqual([]);
  });
});

describe("return page", () => {
  it("returns to the Google Business page when connect was started with ?return=gbp", async () => {
    const stateValue = await mintState("uid_admin", "?return=gbp");
    const res = await callback(stateValue);
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/ai-agents/google-business?google=connected`,
    );
  });

  it("sends connect-time refusals to the same page", async () => {
    state.docs.set(`subAccounts/${SUB}`, { agencyId: "ag_1" });
    const res = await CONNECT(
      request(`http://app.local/api/sub-accounts/${SUB}/google/connect?return=gbp`),
      { params: Promise.resolve({ id: SUB }) },
    );
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/ai-agents/google-business?google=gate_off`,
    );
  });

  it("ignores a return value outside the allow-list", async () => {
    const stateValue = await mintState(
      "uid_admin",
      "?return=https%3A%2F%2Fevil.example",
    );
    const res = await callback(stateValue);
    expect(res.headers.get("location")).toBe(
      `http://app.local/sa/${SUB}/dashboard/settings?google=connected`,
    );
  });
});
