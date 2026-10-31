import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeElevenLabsConversations } from "@/test/fake-elevenlabs-conversations";

/**
 * PR #418 breaker repro, ported against the fixed API (markConnected now
 * takes the connection and verifies the call on ElevenLabs). Each case is
 * the attack as the breaker wrote it; the expectations are the fail-closed
 * outcomes it asked for.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { getWebVoiceUsage, markConnected, reserveGrant, settleConversation, sweepStalePending, voiceTurnAllowed } =
  await import("./web-voice-usage");

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 60 };
let el: ReturnType<typeof fakeElevenLabsConversations>;

const claim = (grantId: string, conversationId: string) =>
  markConnected({ subAccountId: "sa1", grantId, conversationId, sessionId: SESSION_ID, conn: CONN, retryDelayMs: 0 });

beforeEach(() => {
  mem.clear();
  el = fakeElevenLabsConversations();
  vi.stubGlobal("fetch", el.fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("BREAKER: daily minute cap", () => {
  it("A1: calls whose 'connected' ping is never sent still hit the cap", async () => {
    let admitted = 0;
    for (let i = 0; i < 40; i++) {
      try {
        await reserveGrant("sa1", CONN);
        admitted++;
      } catch {
        // refused
      }
      vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1); // grant lapses (and is charged)
    }
    expect(admitted).toBeLessThanOrEqual(12);
  });

  it("A2: an OLD, short conversation cannot be claimed for a fresh grant", async () => {
    const oldStart = Math.floor(Date.now() / 1000) - 3600;
    el.done("conv_old_short", 5, { start_time_unix_secs: oldStart });
    const grantId = await reserveGrant("sa1", CONN);
    expect(await claim(grantId, "conv_old_short")).toBe(false);
    // Nor an old one that is somehow still live.
    el.live("conv_old_live1", { start_time_unix_secs: oldStart });
    expect(await claim(grantId, "conv_old_live1")).toBe(false);
  });

  it("A2: a pending call that turns out to have started before its grant is counted at the full reservation", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    el.live("conv_sub_0001");
    expect(await claim(grantId, "conv_sub_0001")).toBe(true);
    el.done("conv_sub_0001", 5, { start_time_unix_secs: Math.floor(Date.now() / 1000) - 3600 });
    vi.setSystemTime(Date.now() + 300 * 1000);
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_sub_0001", conn: CONN, maxCallSeconds: 300 });
    expect(mem.read(USAGE)?.secondsToday).toBe(300);
  });
});

describe("BREAKER: concurrency", () => {
  it("B1: grants past the live window cannot be claimed, so pending never exceeds the limit", async () => {
    const grants: string[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) {
        try {
          grants.push(await reserveGrant("sa1", { ...CONN, dailyMinuteCap: 1440 }));
        } catch {
          // refused
        }
      }
      vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    }
    let claimed = 0;
    for (const [i, grantId] of grants.entries()) {
      el.live(`conv_${i}_aaaaaa`);
      if (await claim(grantId, `conv_${i}_aaaaaa`)) claimed++;
    }
    expect(claimed).toBeLessThanOrEqual(3);
  });

  it("B2: a forged id is never pending, so it holds no AI replies open", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    expect(await claim(grantId, "conv_forged_000")).toBe(false);
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    expect(await voiceTurnAllowed({ subAccountId: "sa1", sessionId: SESSION_ID, grantId })).toBe(false);
    await sweepStalePending({ subAccountId: "sa1", conn: CONN });
    // The lapsed grant was charged; nothing is ripe for a refund until ~22 min after issue —
    // here it is (59 min), and ElevenLabs shows no call for it, so it is refunded.
    expect((await getWebVoiceUsage("sa1")).secondsToday).toBe(0);
  });
});
