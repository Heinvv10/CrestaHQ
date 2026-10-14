import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR #418 round-3 breaker repro, ported. W1/W2: calls on the watermark's
 * boundary second or indexed late — closed by the 10-minute overlap. W3/W4:
 * one permanently doubtful item stalled the watermark — closed by counting an
 * item doubtful for over an hour at maxCallSeconds. Only adaptation: the
 * watermark is now per agent, `watermarks.agent1` (was `reconciledThroughMs`).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, markConnected, reserveGrant, settleConversation, sweepStalePending } =
  await import("./web-voice-usage");

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 600 };
const MIN = 60 * 1000;
const RIPE = 7 * MIN; // maxCallSeconds 300 + 2 min
type C = { agent_id: string; status: string; start_time_unix_secs: number; call_duration_secs?: number };
let t0: number;
let listed: Map<string, C>;
let byId: Map<string, C>;
let exclusiveAfter: boolean;
let listCalls: number;
const secs = (ms: number) => Math.floor(ms / 1000);
const today = async () => (await getWebVoiceUsage("sa1")).secondsToday;
const sweep = () => sweepStalePending({ subAccountId: "sa1", conn: CONN });

beforeEach(() => {
  mem.clear();
  listed = new Map();
  byId = new Map();
  exclusiveAfter = false;
  listCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T08:00:00Z`));
  t0 = Date.now();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/v1/convai/conversations?")) {
      listCalls++;
      const after = Number(new URL(url).searchParams.get("call_start_after_unix"));
      const conversations = [...listed.entries()]
        .filter(([, c]) => (exclusiveAfter ? c.start_time_unix_secs > after : c.start_time_unix_secs >= after))
        .map(([id, c]) => ({ conversation_id: id, ...c }));
      return Response.json({ conversations, has_more: false, next_cursor: null });
    }
    const id = url.split("/v1/convai/conversations/")[1];
    const c = byId.get(id);
    if (!c) return Response.json({ detail: "nf" }, { status: 404 });
    return Response.json({ agent_id: c.agent_id, status: c.status, metadata: { call_duration_secs: c.call_duration_secs, start_time_unix_secs: c.start_time_unix_secs } });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("BREAKER round 3: calls behind the watermark", () => {
  it("W1: call_start_after_unix EXCLUSIVE — a call starting exactly on the watermark second is never counted", async () => {
    await reserveGrant("sa1", CONN); // G lapses unclaimed, charged 300; its URL runs call Y
    const ySecs = secs(t0 + 14 * MIN);
    listed.set("conv_Y_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: ySecs, call_duration_secs: 300 });
    vi.setSystemTime(ySecs * 1000 + RIPE); // sweep whose toMs == Y's start (Y excluded: start >= toMs)
    exclusiveAfter = true; // ElevenLabs' "after" read as strictly-after
    await sweep();
    expect(mem.read(USAGE)?.watermarks).toMatchObject({ agent1: ySecs * 1000 });
    vi.setSystemTime(t0 + 60 * MIN);
    await sweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });

  it("W2: a call ElevenLabs lists only once it is done (late indexing) lands behind the watermark", async () => {
    await reserveGrant("sa1", CONN);
    const ySecs = secs(t0 + 1 * MIN);
    vi.setSystemTime(t0 + 10 * MIN); // Y started t0+1m, ended by t0+6m; not yet listed
    await sweep();
    listed.set("conv_Y_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: ySecs, call_duration_secs: 300 });
    vi.setSystemTime(t0 + 60 * MIN);
    await sweep();
    expect(await today()).toBeGreaterThanOrEqual(300);
  });

  it("W3: one permanently doubtful item stalls the watermark forever — N6-style call on a claimed grant's URL never counted", async () => {
    // Stall: a conversation stuck 'initiated' (signed URL opened, never initiated) from an attacker's grant.
    await reserveGrant("sa1", CONN);
    listed.set("conv_stuck_001", { agent_id: "agent1", status: "initiated", start_time_unix_secs: secs(t0 + 10_000) });
    // N6: G2 claimed with X (from G1's URL); G2's own URL runs Y, never reported.
    vi.setSystemTime(t0 + 14 * MIN);
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 14 * MIN + 1000);
    const g3 = await reserveGrant("sa1", CONN);
    const xSecs = secs(t0 + 14 * MIN + 2000);
    byId.set("conv_X_000001", { agent_id: "agent1", status: "in-progress", start_time_unix_secs: xSecs });
    expect(await markConnected({ subAccountId: "sa1", grantId: g3, conversationId: "conv_X_000001", sessionId: SESSION_ID, conn: CONN, retryDelayMs: 0 })).toBe(true);
    const ySecs = secs(t0 + 15 * MIN);
    listed.set("conv_X_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: xSecs, call_duration_secs: 300 });
    listed.set("conv_Y_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: ySecs, call_duration_secs: 300 });
    byId.set("conv_X_000001", { agent_id: "agent1", status: "done", start_time_unix_secs: xSecs, call_duration_secs: 300 });
    vi.setSystemTime(t0 + 25 * MIN);
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_X_000001", conn: CONN, maxCallSeconds: 300, sessionId: SESSION_ID });
    // Next UTC day: yesterday's provisional charges are gone with the day reset.
    for (let d = 1; d <= 3; d++) {
      vi.setSystemTime(t0 + d * 24 * 60 * MIN);
      await sweep();
    }
    const u = mem.read(USAGE) as { watermarks: Record<string, number>; settled: string[] };
    // Watermark still at the first grant; Y never in `settled` — it was never counted on any day.
    expect(u.settled).toContain("conv_Y_000001");
  });

  it("W4: /config-style repeated sweeps while stalled re-list the whole growing window every time", async () => {
    await reserveGrant("sa1", CONN);
    listed.set("conv_stuck_001", { agent_id: "agent1", status: "initiated", start_time_unix_secs: secs(t0 + 10_000) });
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(t0 + 10 * MIN + i * MIN);
      await sweep();
    }
    expect(mem.read(USAGE)?.watermarks).toMatchObject({ agent1: t0 - 30_000 });
    expect(listCalls).toBe(5); // informational: each sweep re-reads from the stuck watermark
  });
});
