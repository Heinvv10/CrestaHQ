import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeElevenLabsConversations } from "@/test/fake-elevenlabs-conversations";

/**
 * ElevenLabs' conversation list as the source of truth for Web Voice minutes
 * (WV-2, PR #418 round 2). Every call of the agent that no claim covers is
 * counted at its real duration behind a watermark; a lapsed grant's
 * provisional charge is refunded once its signed URL has expired behind it;
 * any doubt about the list changes nothing. Real accounting on the in-memory
 * Firestore; `fetch` answers as ElevenLabs.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, markConnected, reserveGrant, settleConversation, sweepStalePending } = await import(
  "./web-voice-usage"
);

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 600 };
const MIN = 60 * 1000;
/** Signed URL (15 min) + skew (30 s) behind a watermark that trails now by maxCall + 2 min. */
const REFUNDABLE_MS = 15 * MIN + 30_000 + 300_000 + 2 * MIN + 1000;

let el: ReturnType<typeof fakeElevenLabsConversations>;
let t0: number;

const secs = (ms: number) => Math.floor(ms / 1000);
const sweep = (conn = CONN) => sweepStalePending({ subAccountId: "sa1", conn });
const today = async () => (await getWebVoiceUsage("sa1")).secondsToday;
const doc = () => mem.read(USAGE) as Record<string, unknown>;
const mark = (agentId = "agent1") => (doc().watermarks as Record<string, number>)[agentId];
/** A finished call on our agent, started `offsetMs` after t0. */
const call = (id: string, offsetMs: number, duration: number, over: Record<string, unknown> = {}) =>
  el.state.listed.set(id, { agent_id: "agent1", status: "done", start_time_unix_secs: secs(t0 + offsetMs), call_duration_secs: duration, ...over });
const claim = (grantId: string, id: string) =>
  markConnected({ subAccountId: "sa1", grantId, conversationId: id, sessionId: SESSION_ID, conn: CONN, retryDelayMs: 0 });

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

describe("the provisional charge on a lapsed grant", () => {
  it("is refunded once its signed URL has expired behind the watermark, not before", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + REFUNDABLE_MS - 60_000);
    await sweep();
    expect(await today()).toBe(300);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep();
    expect(await today()).toBe(0);
    expect(doc().lapsed).toEqual({});
  });

  it("is refunded only from the day it was charged to", async () => {
    await reserveGrant("sa1", CONN);
    const d = doc();
    mem.seed(USAGE, {
      ...d,
      secondsToday: 300,
      lapsed: { g_old: { issuedAtMs: t0, day: "2000-01-01", month: "2000-01", chargedSeconds: 300, agentId: "agent1" } },
      grants: {},
    });
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep();
    expect(await today()).toBe(300);
    expect(doc().lapsed).toEqual({});
  });
});

describe("counting every call from the list", () => {
  it("counts a call nobody reported at its real duration, once, even when sweeps race", async () => {
    await reserveGrant("sa1", CONN);
    call("conv_unrep01", 30_000, 42);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await Promise.all([sweep(), sweep()]);
    await sweep();
    expect(await today()).toBe(42);
  });

  it("counts a second call run alongside a claimed one (another grant's URL, or the claimed call's token)", async () => {
    const g = await reserveGrant("sa1", CONN);
    el.live("conv_claimed1");
    expect(await claim(g, "conv_claimed1")).toBe(true);
    el.done("conv_claimed1", 300);
    vi.setSystemTime(t0 + 10 * MIN);
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_claimed1", conn: CONN, maxCallSeconds: 300 });
    call("conv_claimed1", 0, 300);
    call("conv_alongs1", 20_000, 250);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep();
    expect(await today()).toBe(550);
  });

  it("leaves a claimed call that is still pending (even if running) to its own settle", async () => {
    const g = await reserveGrant("sa1", CONN);
    el.live("conv_pending1");
    expect(await claim(g, "conv_pending1")).toBe(true);
    call("conv_pending1", 0, 0, { status: "in-progress", call_duration_secs: undefined });
    vi.setSystemTime(t0 + 8 * MIN);
    el.state.byId.delete("conv_pending1"); // settle's lookup fails: stays pending
    el.state.byId.set("conv_pending1", { status: 500 });
    await sweep();
    expect(mark()).toBeGreaterThan(t0);
    expect(await today()).toBe(0);
  });

  it("ignores other agents' calls, whatever the list returns", async () => {
    await reserveGrant("sa1", CONN);
    el.state.listIgnoresAgent = true;
    call("conv_other01", 30_000, 99, { agent_id: "agent_other" });
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep();
    expect(await today()).toBe(0);
  });

  it("advances the watermark, and re-reads only the 10-minute overlap behind it", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 30 * MIN);
    await sweep();
    const m = mark();
    expect(m).toBe(Math.floor((t0 + 30 * MIN - 420_000) / 1000) * 1000);
    el.state.listIgnoresStart = true; // our side bounds the range, whatever the API does
    call("conv_tooold1", m - t0 - 10 * MIN - 1000, 10); // behind the overlap: never re-read
    call("conv_overlap", m - t0 - 10 * MIN, 20); // listed late, inside the overlap
    call("conv_atmark1", m - t0, 40);
    vi.setSystemTime(t0 + 40 * MIN);
    await sweep();
    expect(await today()).toBe(60);
    expect(el.state.listCalls.at(-1)).toContain(`call_start_after_unix=${(m - 10 * MIN) / 1000}`);
  });

  it("the overlap never counts a call twice", async () => {
    await reserveGrant("sa1", CONN);
    call("conv_once001", REFUNDABLE_MS - 10 * MIN, 42); // re-read by every later sweep's overlap
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(t0 + REFUNDABLE_MS + i * 2 * MIN);
      await sweep();
    }
    expect(await today()).toBe(42);
  });

  it("counts a call on the watermark's boundary second, even if the API reads 'after' as strictly after", async () => {
    await reserveGrant("sa1", CONN);
    const ySecs = secs(t0 + 14 * MIN);
    call("conv_bound01", ySecs * 1000 - t0, 300);
    vi.setSystemTime(ySecs * 1000 + 420_000);
    await sweep();
    expect(mark()).toBe(ySecs * 1000);
    vi.setSystemTime(t0 + 60 * MIN);
    await sweep();
    expect(await today()).toBe(300);
  });

  it("a slow sweep that lost the race never moves the watermark back", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 10 * MIN);
    // Hold the first sweep's list call until a later sweep has finished.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const real = el.fetchMock.getMockImplementation()!;
    el.fetchMock.mockImplementationOnce(async (input) => {
      await held;
      return real(input);
    });
    const slow = sweep();
    await vi.waitFor(() => expect(el.state.listCalls.length + el.fetchMock.mock.calls.length).toBeGreaterThan(0));
    vi.setSystemTime(t0 + 20 * MIN);
    await sweep();
    const ahead = mark();
    release();
    await slow;
    expect(mark()).toBe(ahead);
  });

  it("is not blocked by a call that started after the range (still running)", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    call("conv_justnow", REFUNDABLE_MS - 60_000, 0, { status: "in-progress" });
    await sweep();
    expect(await today()).toBe(0);
  });

  it("does not list before any grant exists, nor before the watermark can move", async () => {
    await sweep();
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 6 * MIN); // now − (maxCall + 2 min) is still before the mark
    await sweep();
    expect(el.state.listCalls).toEqual([]);
  });
});

describe("any doubt about the list changes nothing", () => {
  it.each<[string, () => void]>([
    ["the list fails", () => void (el.state.listStatus = 500)],
    ["the list says there is more but gives no cursor", () => void (el.state.listTruncated = true)],
    // The list reports a running call's duration as 0 (contract test), so status alone must block.
    ["a call in range is still running and not pending", () => call("conv_running", 30_000, 0, { status: "in-progress" })],
    ["a call in range has no duration", () => call("conv_nodur01", 30_000, 0, { call_duration_secs: undefined })],
  ])("%s", async (_label, arrange) => {
    await reserveGrant("sa1", CONN);
    call("conv_counted", 10_000, 42);
    arrange();
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep();
    expect(await today()).toBe(300);
    expect(mark()).toBe(t0 - 30_000);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no conversations array", { has_more: false }],
    ["an item with no start time", { conversations: [{ conversation_id: "conv_nostart", agent_id: "agent1", status: "done", call_duration_secs: 9 }] }],
    ["an item with no agent id", { conversations: [{ conversation_id: "conv_noagent", status: "done", start_time_unix_secs: 0, call_duration_secs: 9 }] }],
    ["an item with no usable id", { conversations: [{ conversation_id: "conv:x.1", agent_id: "agent1", status: "done", start_time_unix_secs: 0, call_duration_secs: 9 }] }],
  ])("the list has %s (a complete, last page otherwise)", async (_label, page) => {
    const body: Record<string, unknown> = { has_more: false, next_cursor: null, ...page };
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    const items = (body.conversations as Array<Record<string, unknown>> | undefined)?.map((c) =>
      "start_time_unix_secs" in c ? { ...c, start_time_unix_secs: secs(t0 + 30_000) } : c,
    );
    el.fetchMock.mockImplementation(async () => Response.json(items ? { ...body, conversations: items } : body));
    await sweep();
    expect(await today()).toBe(300);
    expect(mark()).toBe(t0 - 30_000);
  });
});

describe("a doubtful item cannot stall metering forever", () => {
  it("records the stall, and logs an error on every blocked sweep past 2 hours", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reserveGrant("sa1", CONN);
    el.state.listIgnoresStart = true; // the API returns an item with no start time
    el.state.listed.set("conv_nostart", { agent_id: "agent1", status: "done", call_duration_secs: 9 });
    vi.setSystemTime(t0 + 30 * MIN);
    await sweep();
    expect(doc()).toMatchObject({ reconcileStalledSinceMs: t0 + 30 * MIN, reconcileStalledSweeps: 1 });
    expect(error).not.toHaveBeenCalled();
    vi.setSystemTime(t0 + 30 * MIN + 2 * 60 * MIN + 1000);
    await sweep();
    expect(doc()).toMatchObject({ reconcileStalledSinceMs: t0 + 30 * MIN, reconcileStalledSweeps: 2 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("blocked 2 sweep(s)"));
    expect(mark()).toBe(t0 - 30_000); // no start time: never forced
  });

  it("counts an item doubtful for over an hour at maxCallSeconds, proceeds, and clears the stall", async () => {
    await reserveGrant("sa1", CONN);
    call("conv_stuck01", 10_000, 0, { status: "initiated", call_duration_secs: undefined });
    call("conv_real001", 20_000, 42);
    vi.setSystemTime(t0 + 30 * MIN);
    await sweep();
    expect(doc()).toMatchObject({ reconcileStalledSweeps: 1 });
    // The stuck item started over an hour before the range's end: give up on it.
    vi.setSystemTime(t0 + 10_000 + 7 * MIN + 60 * MIN + 2000);
    await sweep();
    expect(await today()).toBe(300 + 42); // stuck in full, the real call at its duration; grant refunded
    expect(doc()).toMatchObject({ reconcileStalledSinceMs: null, reconcileStalledSweeps: 0 });
    vi.setSystemTime(t0 + 2 * 60 * MIN);
    await sweep();
    expect(await today()).toBe(342);
  });
});

describe("a re-keyed connection (new agent)", () => {
  it("never refunds the old agent's lapsed grants, and starts the new agent's watermark at its first grant", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 5 * MIN);
    const next = { ...CONN, agentId: "agent2" };
    await reserveGrant("sa1", next);
    expect(doc().watermarks).toEqual({ agent1: t0 - 30_000, agent2: t0 + 5 * MIN - 30_000 });
    vi.setSystemTime(t0 + 5 * MIN + REFUNDABLE_MS);
    await sweep(next);
    expect(await today()).toBe(300); // agent1's charge stands; agent2's grant refunded
    expect(doc().lapsed).toEqual({});
  });

  it("A→B→A keeps A's own watermark, so A's calls during B are still counted", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + 5 * MIN);
    await reserveGrant("sa1", { ...CONN, agentId: "agent2" });
    call("conv_a_tail1", 8 * MIN, 120); // a call on agent1 after the switch
    vi.setSystemTime(t0 + 10 * MIN);
    await reserveGrant("sa1", CONN); // back to agent1
    expect(mark("agent1")).toBe(t0 - 30_000);
    vi.setSystemTime(t0 + 10 * MIN + REFUNDABLE_MS);
    await sweep();
    expect(el.state.listCalls[0]).toContain("agent_id=agent1");
    expect(await today()).toBe(300 + 120); // agent2's lapsed charge stands; agent1's grants refunded, its tail counted
  });

  it("a sweep for an agent the watermark is not for (re-keyed, no new grant yet) lists nothing and keeps every charge", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + REFUNDABLE_MS);
    await sweep({ ...CONN, agentId: "agent2" });
    expect(el.state.listCalls).toEqual([]);
    expect(await today()).toBe(300);
  });
});
