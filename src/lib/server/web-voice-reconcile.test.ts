import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeElevenLabsConversations } from "@/test/fake-elevenlabs-conversations";

/**
 * Reconciling lapsed grants against ElevenLabs' conversation list (WV-2,
 * breaker A1). A grant nobody claimed was charged its full reservation; once
 * any call it could have started has ended, the charge becomes the real
 * duration of the call ElevenLabs shows for it, or is refunded when there is
 * none. Real accounting on the in-memory Firestore; `fetch` answers as
 * ElevenLabs.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, markConnected, reserveGrant, settleConversation, sweepStalePending } = await import(
  "./web-voice-usage"
);

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 600 };
/** Past this, every call a grant's signed URL could have started has ended. */
const RIPE_MS = 15 * 60 * 1000 + 300 * 1000 + 2 * 60 * 1000 + 1000;

let el: ReturnType<typeof fakeElevenLabsConversations>;
let t0: number;

const secs = (ms: number) => Math.floor(ms / 1000);
const sweep = () => sweepStalePending({ subAccountId: "sa1", conn: CONN });
const today = async () => (await getWebVoiceUsage("sa1")).secondsToday;
const lapsed = () => Object.keys((mem.read(USAGE)?.lapsed ?? {}) as object);
/** A finished call on our agent, started `offsetMs` after t0. */
const call = (id: string, offsetMs: number, duration: number, over: Record<string, unknown> = {}) =>
  el.state.listed.set(id, { agent_id: "agent1", status: "done", start_time_unix_secs: secs(t0 + offsetMs), call_duration_secs: duration, ...over });

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

/** Reserve `n` grants at t0 (+1 s apart), let them lapse, then ripen. */
async function lapsedGrants(n: number) {
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(t0 + i * 1000);
    await reserveGrant("sa1", CONN);
  }
  vi.setSystemTime(t0 + RIPE_MS + n * 1000);
}

describe("reconcileLapsedGrants", () => {
  it("refunds a lapsed grant ElevenLabs shows no call for", async () => {
    await lapsedGrants(1);
    expect(await today()).toBe(300);
    await sweep();
    expect(await today()).toBe(0);
    expect(lapsed()).toEqual([]);
  });

  it("swaps the charge for the real duration of the unreported call, and counts it once", async () => {
    await lapsedGrants(1);
    call("conv_unrep01", 30_000, 42);
    await Promise.all([sweep(), sweep()]);
    await sweep();
    expect(await today()).toBe(42);
    expect(mem.read(USAGE)?.settled).toEqual(["conv_unrep01"]);
  });

  it("matches calls to grants earliest first, refunds the grant left over", async () => {
    await lapsedGrants(2);
    call("conv_unrep01", 30_000, 42);
    await sweep();
    expect(await today()).toBe(42);
    expect(lapsed()).toEqual([]);
  });

  it("counts a call no lapsed grant can absorb (run alongside another) at its real duration", async () => {
    await lapsedGrants(1);
    call("conv_unrep01", 10_000, 40);
    call("conv_unrep02", 20_000, 60);
    await sweep();
    expect(await today()).toBe(100);
  });

  it("leaves out calls a claim already counted", async () => {
    vi.setSystemTime(t0);
    const claimed = await reserveGrant("sa1", CONN);
    el.live("conv_claimed1");
    expect(
      await markConnected({ subAccountId: "sa1", grantId: claimed, conversationId: "conv_claimed1", sessionId: "sess_aaaaaaaaaaaaaaaa", conn: CONN, retryDelayMs: 0 }),
    ).toBe(true);
    el.done("conv_claimed1", 50);
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_claimed1", conn: CONN, maxCallSeconds: 300 });
    vi.setSystemTime(t0 + 1000);
    await reserveGrant("sa1", CONN); // lapses unclaimed
    call("conv_claimed1", 0, 50);
    vi.setSystemTime(t0 + RIPE_MS + 1000);
    await sweep();
    expect(await today()).toBe(50);
  });

  it("ignores other agents' calls and calls outside the grants' signed-URL window", async () => {
    await lapsedGrants(1);
    call("conv_other01", 30_000, 99, { agent_id: "agent_other" });
    call("conv_late001", 16 * 60 * 1000, 99);
    await sweep();
    expect(await today()).toBe(0);
  });

  it.each<[string, () => void]>([
    ["the list fails", () => void (el.state.listStatus = 500)],
    ["the list is longer than it returned", () => void (el.state.listTruncated = true)],
    ["a call in the window is still running", () => call("conv_running", 30_000, 0, { status: "in-progress" })],
    ["a call in the window has no duration yet", () => call("conv_nodur01", 30_000, 0, { call_duration_secs: undefined })],
  ])("keeps every charge when %s", async (_label, arrange) => {
    await lapsedGrants(1);
    arrange();
    await sweep();
    expect(await today()).toBe(300);
    expect(mem.read(USAGE)?.settled ?? []).toEqual([]);
  });

  it("does not ask ElevenLabs before the grant is ripe", async () => {
    await reserveGrant("sa1", CONN);
    vi.setSystemTime(t0 + RIPE_MS - 60_000);
    await sweep();
    expect(el.state.listCalls).toEqual([]);
    expect(await today()).toBe(300);
  });

  it("refunds only from the day the charge went into", async () => {
    mem.seed(USAGE, {
      day: new Date(t0).toISOString().slice(0, 10),
      secondsToday: 300,
      month: new Date(t0).toISOString().slice(0, 7),
      secondsThisMonth: 300,
      lapsed: { g_yesterday: { issuedAtMs: t0 - RIPE_MS, day: "2000-01-01", month: "2000-01", chargedSeconds: 300 } },
    });
    await sweep();
    expect(await today()).toBe(300);
    expect(lapsed()).toEqual([]);
  });
});
