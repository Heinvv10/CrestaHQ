import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeElevenLabsConversations } from "@/test/fake-elevenlabs-conversations";

/**
 * Web Voice minute accounting (WV-2) on the in-memory Firestore, whose
 * transactions re-run on contention like Firestore's. Only `fetch` is faked,
 * answering as ElevenLabs' conversation endpoints. Pinned: the cap and the
 * concurrency limit hold under parallel reservations, an unclaimed grant is
 * charged, a grant is claimed once and only by its own live call, a call is
 * counted once however many settles race, and the reply endpoint's
 * permission follows the reservation. Reconciliation: web-voice-reconcile.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const {
  WebVoiceLimitError,
  getWebVoiceUsage,
  markConnected,
  reserveGrant,
  settleConversation,
  sweepStalePending,
  voiceTurnAllowed,
  webVoiceCapReached,
} = await import("./web-voice-usage");

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const SESSION = `subAccounts/sa1/webChatSessions/${SESSION_ID}`;
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 60 };
const TODAY = () => new Date().toISOString().slice(0, 10);

let el: ReturnType<typeof fakeElevenLabsConversations>;
const warn = vi.fn();

beforeEach(() => {
  mem.clear();
  el = fakeElevenLabsConversations();
  vi.stubGlobal("fetch", el.fetchMock);
  vi.spyOn(console, "warn").mockImplementation(warn.mockClear());
  mem.seed(SESSION, { agencyId: "ag1", subAccountId: "sa1", messageCount: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const claim = (grantId: string, conversationId: string, sessionId = SESSION_ID) =>
  markConnected({ subAccountId: "sa1", grantId, conversationId, sessionId, conn: CONN, retryDelayMs: 0 });
const settle = (conversationId = "conv_000001", sessionId?: string) =>
  settleConversation({ subAccountId: "sa1", conversationId, conn: CONN, maxCallSeconds: 300, sessionId });
const usage = () => mem.read(USAGE) as Record<string, unknown> & { secondsToday: number };

/** A call ElevenLabs reports live on our agent, claimed by a fresh grant. */
async function connected(conversationId: string) {
  const grantId = await reserveGrant("sa1", CONN);
  el.live(conversationId);
  expect(await claim(grantId, conversationId)).toBe(true);
  el.state.byId.delete(conversationId);
  return grantId;
}

describe("reserveGrant", () => {
  it("never admits more than the concurrency limit, even when requests race", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => reserveGrant("sa1", CONN)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(Object.keys(usage().grants as object)).toHaveLength(3);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(WebVoiceLimitError);
    expect(refused.reason.reason).toBe("busy");
  });

  it("refuses a call that could overshoot today's cap, counting reservations at full length", async () => {
    // 60-minute cap, 5-minute calls: 51 counted minutes + one 5-minute reservation leave no room for another.
    mem.seed(USAGE, { day: TODAY(), secondsToday: 51 * 60 });
    await reserveGrant("sa1", CONN);
    await expect(reserveGrant("sa1", CONN)).rejects.toMatchObject({ reason: "daily_cap" });
  });

  it("starts a new UTC day from zero; a new day in the same month keeps the month's total", async () => {
    mem.seed(USAGE, { day: "2000-01-01", secondsToday: 99_999, month: "2000-01", secondsThisMonth: 99_999 });
    await reserveGrant("sa1", CONN);
    expect(usage()).toMatchObject({ secondsToday: 0, secondsThisMonth: 0 });
    const month = TODAY().slice(0, 7);
    mem.seed(USAGE, { day: `${month}-00`, secondsToday: 500, month, secondsThisMonth: 900 });
    await reserveGrant("sa1", CONN);
    expect(usage()).toMatchObject({ secondsToday: 0, secondsThisMonth: 900 });
  });
});

describe("a grant nobody claims (breaker A1)", () => {
  it("is charged its full reservation when it lapses, so unreported calls still hit the cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
    let admitted = 0;
    for (let i = 0; i < 40; i++) {
      try {
        await reserveGrant("sa1", CONN);
        admitted++;
      } catch {
        // refused by the cap
      }
      vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    }
    expect(admitted).toBe(12); // 60-minute cap / 5-minute calls
    // The refused reservations wrote nothing, so the last lapse is computed on read.
    expect((await getWebVoiceUsage("sa1")).secondsToday).toBe(12 * 300);
    expect(await webVoiceCapReached("sa1", CONN)).toBe(true);
  });

  it("frees its concurrency slot when it lapses, at the same moment it stops being claimable (B1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
    const first = await reserveGrant("sa1", CONN);
    for (let i = 0; i < 2; i++) await reserveGrant("sa1", CONN);
    await expect(reserveGrant("sa1", CONN)).rejects.toMatchObject({ reason: "busy" });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    await expect(reserveGrant("sa1", CONN)).resolves.toEqual(expect.any(String));
    el.live("conv_000001");
    expect(await claim(first, "conv_000001")).toBe(false);
  });
});

describe("markConnected", () => {
  it("claims a grant once; a replay or an unknown grant claims nothing", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    for (const id of ["conv_000001", "conv_000002", "conv_000003"]) el.live(id);
    expect(await claim(grantId, "conv_000001")).toBe(true);
    expect(await claim(grantId, "conv_000002")).toBe(false);
    el.state.lookups = [];
    expect(await claim("never_issued", "conv_000003")).toBe(false);
    expect(el.state.lookups).toEqual([]); // an unknown grant never costs an ElevenLabs lookup
    expect(usage().pending).toEqual({
      conv_000001: { sessionId: SESSION_ID, grantId, grantIssuedAtMs: expect.any(Number), startedAtMs: expect.any(Number) },
    });
    expect(usage().grants).toEqual({});
  });

  it.each<[string, (id: string) => void]>([
    ["ElevenLabs does not know it (a forged id)", () => undefined],
    ["it is finished (an old conversation re-used)", (id) => el.done(id, 5)],
    ["it failed", (id) => el.live(id, { status: "failed" })],
    ["it belongs to another agent", (id) => el.live(id, { agent_id: "agent_other" })],
    ["it started before the grant was issued (A2)", (id) => el.live(id, { start_time_unix_secs: Math.floor(Date.now() / 1000) - 3600 })],
    ["ElevenLabs gives no start time", (id) => el.live(id, { start_time_unix_secs: undefined })],
    ["every lookup fails", (id) => el.state.byId.set(id, { status: 500 })],
  ])("claims nothing when %s", async (_label, arrange) => {
    const grantId = await reserveGrant("sa1", CONN);
    arrange("conv_000001");
    expect(await claim(grantId, "conv_000001")).toBe(false);
    expect(usage().pending).toEqual({});
    expect(Object.keys(usage().grants as object)).toEqual([grantId]);
  });

  it("retries a lookup on a 5xx, three lookups at most; a 404 is final", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    el.fetchMock.mockImplementationOnce(async () => Response.json({ detail: "busy" }, { status: 503 }));
    el.live("conv_000001");
    expect(await claim(grantId, "conv_000001")).toBe(true);

    const flaky = await reserveGrant("sa1", CONN);
    el.state.byId.set("conv_000002", { status: 500 });
    el.state.lookups = [];
    expect(await claim(flaky, "conv_000002")).toBe(false);
    expect(el.state.lookups).toEqual(["conv_000002", "conv_000002", "conv_000002"]);

    const unknown = await reserveGrant("sa1", CONN);
    el.state.lookups = [];
    expect(await claim(unknown, "conv_000003")).toBe(false);
    expect(el.state.lookups).toEqual(["conv_000003"]);
  });

  it("takes one conversation id per grant: a second id is refused without a lookup", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    expect(await claim(grantId, "conv_forged1")).toBe(false); // 404
    el.live("conv_000001");
    el.state.lookups = [];
    expect(await claim(grantId, "conv_000001")).toBe(false);
    expect(el.state.lookups).toEqual([]);
    // The same id again may be resent (the event route limits how often).
    el.live("conv_forged1");
    expect(await claim(grantId, "conv_forged1")).toBe(true);
  });

  it("a grant that lapses while its lookup is in flight is not claimed (it was already charged)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
    const grantId = await reserveGrant("sa1", CONN);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 - 500);
    el.live("conv_000001");
    const real = el.fetchMock.getMockImplementation()!;
    el.fetchMock.mockImplementationOnce(async (input) => {
      vi.setSystemTime(Date.now() + 1000); // the lookup is slow: the grant lapses meanwhile
      return real(input);
    });
    expect(await claim(grantId, "conv_000001")).toBe(false);
    expect(usage().pending).toEqual({});
  });

  it("one grant claims one conversation, even when two claims race", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    el.live("conv_000001");
    el.live("conv_000002");
    const results = await Promise.all([claim(grantId, "conv_000001"), claim(grantId, "conv_000002")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(Object.keys(usage().pending as object)).toHaveLength(1);
  });

  it("re-checks concurrency inside its transaction: refuses when pending alone is already full", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    const doc = usage();
    const p = { sessionId: "s", grantId: "g", grantIssuedAtMs: Date.now(), startedAtMs: Date.now() };
    mem.seed(USAGE, { ...doc, pending: { conv_a00001: p, conv_b00001: p, conv_c00001: p } });
    el.live("conv_000001");
    expect(await claim(grantId, "conv_000001")).toBe(false);
  });
});

describe("conversation ids that name Object.prototype members", () => {
  it.each(["__proto__", "constructor", "hasOwnProperty"])("%s can neither be claimed nor settled into the counters", async (id) => {
    const grantId = await reserveGrant("sa1", CONN);
    el.live(id);
    expect(await claim(grantId, id)).toBe(false);
    el.state.lookups = [];
    for (let i = 0; i < 3; i++) await settle(id);
    expect(usage().secondsToday).toBe(0);
    expect(el.state.lookups).toEqual([]);
  });
});

describe("voiceTurnAllowed", () => {
  const allowed = (grantId: string, sessionId = SESSION_ID) =>
    voiceTurnAllowed({ subAccountId: "sa1", sessionId, grantId });

  it("allows a live grant, refuses it once it lapses unclaimed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
    const grantId = await reserveGrant("sa1", CONN);
    expect(await allowed(grantId)).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    expect(await allowed(grantId)).toBe(false);
  });

  it("allows a claimed grant for its own session until the call is settled", async () => {
    const grantId = await connected("conv_000001");
    expect(await allowed(grantId)).toBe(true);
    expect(await allowed(grantId, "sess_bbbbbbbbbbbbbbbb")).toBe(false);
    expect(await allowed("never_issued")).toBe(false);
    el.done("conv_000001", 42);
    await settle();
    expect(await allowed(grantId)).toBe(false);
  });
});

describe("settleConversation", () => {
  it("counts ElevenLabs' duration exactly once, on the usage doc and the session, however many settles race", async () => {
    await connected("conv_000001");
    el.done("conv_000001", 42.4);
    await Promise.all([settle(), settle(), settle()]);
    await settle();
    expect(usage()).toMatchObject({ secondsToday: 42, secondsThisMonth: 42, pending: {}, settled: ["conv_000001"] });
    expect(mem.read(SESSION)?.voiceSeconds).toBe(42);
  });

  it("keeps a live call pending", async () => {
    await connected("conv_000001");
    el.live("conv_000001");
    await settle();
    expect(Object.keys(usage().pending as object)).toEqual(["conv_000001"]);
    expect(usage().secondsToday).toBe(0);
  });

  it.each<[string, () => void]>([
    ["ElevenLabs does not know the id (404)", () => undefined],
    ["the conversation belongs to another agent", () => el.done("conv_000001", 1, { agent_id: "agent_other" })],
    ["the conversation started before its grant (A2)", () =>
      el.done("conv_000001", 5, { start_time_unix_secs: Math.floor(Date.now() / 1000) - 3600 })],
    ["ElevenLabs reports no start time", () => el.done("conv_000001", 5, { start_time_unix_secs: undefined })],
  ])("counts the full reservation when %s", async (_label, arrange) => {
    await connected("conv_000001");
    arrange();
    await settle();
    expect(usage()).toMatchObject({ secondsToday: 300, pending: {} });
  });

  it("a negative duration from ElevenLabs never lowers the counters", async () => {
    mem.seed(USAGE, { day: TODAY(), secondsToday: 100 });
    await connected("conv_000001");
    el.done("conv_000001", -100);
    await settle();
    expect(usage().secondsToday).toBeGreaterThanOrEqual(100);
  });

  it("a session token settles only its own session's call", async () => {
    await connected("conv_000001");
    el.done("conv_000001", 42);
    await settle("conv_000001", "sess_bbbbbbbbbbbbbbbb");
    expect(Object.keys(usage().pending as object)).toEqual(["conv_000001"]);
    await settle("conv_000001", SESSION_ID);
    expect(usage()).toMatchObject({ secondsToday: 42, pending: {} });
  });

  it("keeps the call pending on a transient lookup failure and logs only the message", async () => {
    await connected("conv_000001");
    el.state.byId.set("conv_000001", { status: 500 });
    await settle();
    expect(Object.keys(usage().pending as object)).toEqual(["conv_000001"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duration lookup failed"), "boom");
  });

  it("ignores an id that is not pending without asking ElevenLabs", async () => {
    await settle("conv_unknown");
    expect(el.state.lookups).toEqual([]);
    expect(mem.read(USAGE)).toBeUndefined();
  });
});

describe("sweepStalePending and the widget cap", () => {
  it("settles finished calls older than 15 seconds, leaving fresh ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)); // days are UTC: never cross midnight mid-test
    await connected("conv_old0001");
    vi.setSystemTime(Date.now() + 20_000);
    await connected("conv_new0001");
    el.done("conv_old0001", 60, { start_time_unix_secs: Math.floor(Date.now() / 1000) - 20 });
    el.done("conv_new0001", 5);
    el.state.lookups = [];
    await sweepStalePending({ subAccountId: "sa1", conn: CONN });
    expect(el.state.lookups).toEqual(["conv_old0001"]);
    expect(Object.keys(usage().pending as object)).toEqual(["conv_new0001"]);
  });

  it("hides the mic only on counted seconds", async () => {
    expect(await webVoiceCapReached("sa1", CONN)).toBe(false);
    mem.seed(USAGE, { day: TODAY(), secondsToday: 56 * 60 });
    expect(await webVoiceCapReached("sa1", CONN)).toBe(true);
  });
});
