import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaStateSubAccountHint, signMetaState, verifyMetaState } from "./meta";

/**
 * The Meta OAuth `state` must expire and be bound to the admin who started
 * the connect: otherwise a captured state (logs, referrer, a shared link)
 * lets anyone who is also an admin of that sub-account finish a connect
 * with THEIR Facebook grant, at any later time.
 */

beforeEach(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
});
afterEach(() => vi.useRealTimers());

describe("Meta OAuth state", () => {
  it("round-trips for the uid that started it", () => {
    const state = signMetaState("sa1", "uid-a", "nonce1");
    expect(verifyMetaState(state, "uid-a")).toEqual({ subAccountId: "sa1" });
  });

  it("refuses a different uid, or none", () => {
    const state = signMetaState("sa1", "uid-a", "nonce1");
    expect(verifyMetaState(state, "uid-b")).toBeNull();
    expect(verifyMetaState(state, null)).toBeNull();
  });

  it("expires after twenty minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-23T10:00:00Z") });
    const state = signMetaState("sa1", "uid-a", "nonce1");
    vi.setSystemTime(new Date("2026-09-23T10:19:59Z"));
    expect(verifyMetaState(state, "uid-a")).not.toBeNull();
    vi.setSystemTime(new Date("2026-09-23T10:20:01Z"));
    expect(verifyMetaState(state, "uid-a")).toBeNull();
  });

  it("still names its sub-account after a refusal, so the user can be sent back there", () => {
    const state = signMetaState("sa1", "uid-a", "nonce1");
    expect(verifyMetaState(state, "uid-b")).toBeNull();
    expect(metaStateSubAccountHint(state)).toBe("sa1");
    expect(metaStateSubAccountHint("garbage")).toBeNull();
    const pathy = Buffer.from(JSON.stringify({ sa: "../agency" })).toString("base64url");
    expect(metaStateSubAccountHint(`${pathy}.sig`)).toBeNull();
  });

  it("refuses a tampered sub-account or a state signed under another secret", () => {
    const state = signMetaState("sa1", "uid-a", "nonce1");
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(Buffer.from(payload, "base64url").toString().replace("sa1", "sa2")).toString("base64url");
    expect(verifyMetaState(`${forged}.${sig}`, "uid-a")).toBeNull();
    process.env.AUTOMATIONS_TOKEN_SECRET = "other";
    expect(verifyMetaState(state, "uid-a")).toBeNull();
  });
});
