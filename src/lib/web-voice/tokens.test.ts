import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * Web Voice tokens (WV-2). The widget token gates /voice/start; the session
 * token is the only thing that ties a spoken turn to a chat session, so every
 * way of forging, stretching or re-targeting one must fail.
 */

vi.mock("server-only", () => ({}));

const { issueSessionToken, issueWidgetToken, verifySessionToken, verifyWidgetToken } = await import("./tokens");

const SECRET = "test-secret-at-least-16-chars";
const CLAIMS = { subAccountId: "sa1", sessionId: "sess_abcdefghijklmnop", grantId: "grant_1" };

/** Re-sign a payload with the real secret (what a forger cannot do). */
const sig = (scope: string, payload: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${scope}|${payload}`).digest("base64url");

beforeEach(() => {
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("widget token", () => {
  it("round-trips for its own sub-account only", () => {
    const t = issueWidgetToken("sa1")!;
    expect(verifyWidgetToken(t, "sa1")).toBe(true);
    expect(verifyWidgetToken(t, "sa2")).toBe(false);
  });

  it("is refused once expired", () => {
    vi.useFakeTimers();
    const t = issueWidgetToken("sa1")!;
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1);
    expect(verifyWidgetToken(t, "sa1")).toBe(false);
  });

  it("refuses a tampered signature, a stretched expiry and a different secret", () => {
    const t = issueWidgetToken("sa1")!;
    const [p, sa, exp, s] = t.split(".");
    const flipped = s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    expect(verifyWidgetToken(`${p}.${sa}.${exp}.${flipped}`, "sa1")).toBe(false);
    expect(verifyWidgetToken(`${p}.${sa}.${Number(exp) + 1}.${s}`, "sa1")).toBe(false);
    const other = `w1.sa1.${exp}.${sig("web-voice-widget", `w1.sa1.${exp}`, "another-secret-16chars")}`;
    expect(verifyWidgetToken(other, "sa1")).toBe(false);
  });

  it("refuses everything when the secret is missing or short", () => {
    const t = issueWidgetToken("sa1")!;
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "");
    expect(issueWidgetToken("sa1")).toBeNull();
    expect(verifyWidgetToken(t, "sa1")).toBe(false);
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "short");
    expect(verifyWidgetToken(t, "sa1")).toBe(false);
  });

  it("refuses a non-string, a wrong prefix and a session token in its place", () => {
    expect(verifyWidgetToken(undefined, "sa1")).toBe(false);
    expect(verifyWidgetToken(42, "sa1")).toBe(false);
    const t = issueWidgetToken("sa1")!;
    expect(verifyWidgetToken(t.replace(/^w1/, "w2"), "sa1")).toBe(false);
    expect(verifyWidgetToken(issueSessionToken(CLAIMS), "sa1")).toBe(false);
  });
});

describe("session token", () => {
  it("round-trips its claims", () => {
    expect(verifySessionToken(issueSessionToken(CLAIMS))).toEqual(CLAIMS);
  });

  it("is refused once expired", () => {
    vi.useFakeTimers();
    const t = issueSessionToken(CLAIMS)!;
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(verifySessionToken(t)).toEqual(CLAIMS);
    vi.advanceTimersByTime(2);
    expect(verifySessionToken(t)).toBeNull();
  });

  it("cannot be re-targeted: changing any claim breaks the signature", () => {
    const t = issueSessionToken(CLAIMS)!;
    const parts = t.split(".");
    for (const [i, value] of [[1, "sa2"], [2, "sess_zzzzzzzzzzzzzzzz"], [3, "grant_2"]] as const) {
      const forged = [...parts];
      forged[i] = value;
      expect(verifySessionToken(forged.join(".")), `claim ${i}`).toBeNull();
    }
  });

  it("a widget-scoped signature over the same payload is not a session token", () => {
    const exp = Date.now() + 60_000;
    const payload = `s1.sa1.${CLAIMS.sessionId}.grant_1.${exp}`;
    expect(verifySessionToken(`${payload}.${sig("web-voice-widget", payload)}`)).toBeNull();
    expect(verifySessionToken(`${payload}.${sig("web-voice-session", payload)}`)).toEqual(CLAIMS);
  });

  it("refuses ids that are not doc ids or are malformed, even when signed", () => {
    const exp = Date.now() + 60_000;
    for (const sa of ["__x__", "a/b", ""]) {
      const payload = `s1.${sa}.${CLAIMS.sessionId}.grant_1.${exp}`;
      expect(verifySessionToken(`${payload}.${sig("web-voice-session", payload)}`), sa).toBeNull();
    }
    expect(issueSessionToken({ ...CLAIMS, sessionId: "__reserved__" })).toBeNull();
  });

  it("refuses a signed expiry that is not plain digits", () => {
    const payload = `s1.sa1.${CLAIMS.sessionId}.grant_1.1e20`;
    expect(verifySessionToken(`${payload}.${sig("web-voice-session", payload)}`)).toBeNull();
  });
});
