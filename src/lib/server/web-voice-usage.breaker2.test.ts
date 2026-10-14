import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeElevenLabsConversations } from "@/test/fake-elevenlabs-conversations";

/**
 * PR #418 round-2 breaker repro, ported as written: N6 (a call started on a
 * claimed grant's URL fell outside every lapsed-grant window), N1 (a listed
 * call with no start time was dropped and its grant refunded) and N2 (one
 * `connected` ping cost three lookups). Fixed by the watermark
 * reconciliation and one-id-per-grant claims.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, markConnected, reserveGrant, settleConversation, sweepStalePending } =
  await import("./web-voice-usage");

const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 600 };
const MIN = 60 * 1000;
let el: ReturnType<typeof fakeElevenLabsConversations>;
let t0: number;
const secs = (ms: number) => Math.floor(ms / 1000);
const today = async () => (await getWebVoiceUsage("sa1")).secondsToday;

beforeEach(() => {
  mem.clear();
  el = fakeElevenLabsConversations();
  vi.stubGlobal("fetch", el.fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T08:00:00Z`));
  t0 = Date.now();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("BREAKER round 2", () => {
  it("N6: a lapsed grant's call claimed by a later grant frees that grant's own call, outside every window", async () => {
    // G1 at t0: never claimed -> lapses (charged 300), its signed URL is used for X.
    await reserveGrant("sa1", CONN);
    // G2 at t0+14m. X starts at t0+13m50s on G1's URL (within G2.issued - 30 s).
    vi.setSystemTime(t0 + 14 * MIN);
    const g2 = await reserveGrant("sa1", CONN);
    const xStart = secs(t0 + 13 * MIN + 50_000);
    el.live("conv_X_000001", { start_time_unix_secs: xStart });
    expect(
      await markConnected({ subAccountId: "sa1", grantId: g2, conversationId: "conv_X_000001", sessionId: SESSION_ID, conn: CONN, retryDelayMs: 0 }),
    ).toBe(true);
    // Y: G2's own signed URL, started t0+16m (after G1's window), 300 s, never reported.
    const yStart = secs(t0 + 16 * MIN);
    el.state.listed.set("conv_Y_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: yStart, call_duration_secs: 300 });
    el.state.listed.set("conv_X_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: xStart, call_duration_secs: 300 });
    el.done("conv_X_000001", 300, { start_time_unix_secs: xStart });
    vi.setSystemTime(t0 + 20 * MIN);
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_X_000001", conn: CONN, maxCallSeconds: 300, sessionId: SESSION_ID });
    vi.setSystemTime(t0 + 60 * MIN);
    await sweepStalePending({ subAccountId: "sa1", conn: CONN });
    // ElevenLabs billed X + Y = 600 s on this agent.
    expect(await today()).toBeGreaterThanOrEqual(600);
  });

  it("N1: a listed call without a start time is dropped, and its grant refunded (fail-open on list shape)", async () => {
    await reserveGrant("sa1", CONN);
    el.state.listed.set("conv_nostart1", { agent_id: "agent1", status: "done", call_duration_secs: 300 });
    // fake filters start >= after; a missing start reads as 0 -> force it through
    el.state.listed.set("conv_nostart1", { agent_id: "agent1", status: "done", call_duration_secs: 300, start_time_unix_secs: undefined });
    vi.setSystemTime(t0 + 60 * MIN);
    // Make the fake return it regardless of the start filter.
    const orig = el.fetchMock.getMockImplementation()!;
    el.fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("conversations?")) {
        return Response.json({ conversations: [{ conversation_id: "conv_nostart1", agent_id: "agent1", status: "done", call_duration_secs: 300 }], has_more: false, next_cursor: null });
      }
      return orig(input);
    });
    await sweepStalePending({ subAccountId: "sa1", conn: CONN });
    expect(await today()).toBeGreaterThanOrEqual(300);
  });

  it("N2: one unauthenticated 'connected' ping with a random id costs 3 ElevenLabs calls on the client's key", async () => {
    const g = await reserveGrant("sa1", CONN);
    for (let i = 0; i < 20; i++) {
      await markConnected({ subAccountId: "sa1", grantId: g, conversationId: `conv_rand_${i}xx`, sessionId: SESSION_ID, conn: CONN, retryDelayMs: 0 });
    }
    // 20 pings -> how many ElevenLabs lookups?
    expect(el.state.lookups.length).toBeLessThanOrEqual(20);
  });
});
