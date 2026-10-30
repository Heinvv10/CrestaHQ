import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR #418 breaker repro: reconciliation must refund a lapsed grant only on
 * positive evidence that no call used it. Ported as written — F1–F5 and F8
 * must end charged, F6 and F7 are controls. F1/F2/F4/F5 were already closed
 * by the watermark round (malformed items and other agents keep charges);
 * F3 (failed call with a duration) and F8 (no has_more) by this one.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, reserveGrant, sweepStalePending } = await import("./web-voice-usage");

const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 600 };
const MIN = 60 * 1000;
let t0: number;
let page: () => unknown;
const today = async () => (await getWebVoiceUsage("sa1")).secondsToday;
const start = () => Math.floor((t0 + 30_000) / 1000);

beforeEach(() => {
  mem.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T08:00:00Z`));
  t0 = Date.now();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/v1/convai/conversations?")) return Response.json(page());
    return Response.json({ detail: "nf" }, { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function lapsedThenSweep(conn = CONN) {
  await reserveGrant("sa1", CONN);
  vi.setSystemTime(t0 + 3 * MIN);
  expect(await today()).toBe(300);
  vi.setSystemTime(t0 + 60 * MIN);
  await sweepStalePending({ subAccountId: "sa1", conn });
}
const one = (c: Record<string, unknown>) => () => ({ conversations: [c], has_more: false, next_cursor: null });

describe("BREAKER: reconcile refunds without proof of no call", () => {
  it("F1: list items without agent_id (filtered server-side by agent_id) -> refund", async () => {
    page = one({ conversation_id: "conv_real_001", status: "done", start_time_unix_secs: start(), call_duration_secs: 300 });
    await lapsedThenSweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
  it("F2: list items without start_time_unix_secs -> refund", async () => {
    page = one({ conversation_id: "conv_real_001", agent_id: "agent1", status: "done", call_duration_secs: 300 });
    await lapsedThenSweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
  it("F3: status 'failed' with a 300 s duration is counted as 0", async () => {
    page = one({ conversation_id: "conv_real_001", agent_id: "agent1", status: "failed", start_time_unix_secs: start(), call_duration_secs: 300 });
    await lapsedThenSweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
  it("F4: a conversation id outside [A-Za-z0-9_-] is dropped from the page -> refund", async () => {
    page = one({ conversation_id: "conv:real.001", agent_id: "agent1", status: "done", start_time_unix_secs: start(), call_duration_secs: 300 });
    await lapsedThenSweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
  it("F5: agent re-keyed after the grant lapsed -> the old agent's call is never listed -> refund", async () => {
    page = () => ({ conversations: [], has_more: false, next_cursor: null }); // new agent has no calls
    await lapsedThenSweep({ ...CONN, agentId: "agent_new" });
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
  it("F6 (control): API error keeps the charge", async () => {
    page = () => { throw new Error("x"); };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "boom" }, { status: 500 })));
    await lapsedThenSweep();
    expect(await today()).toBe(300);
  });
  it("F7 (control): has_more with no cursor keeps the charge", async () => {
    page = () => ({ conversations: [], has_more: true, next_cursor: null });
    await lapsedThenSweep();
    expect(await today()).toBe(300);
  });
  it("F8: has_more omitted (undefined) on a full page -> treated as last page -> refund", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ conversation_id: `conv_other_${i}`, agent_id: "agent1", status: "done", start_time_unix_secs: start() + 7200, call_duration_secs: 1 }));
    page = () => ({ conversations: filler, next_cursor: "abc" });
    await lapsedThenSweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });
});
