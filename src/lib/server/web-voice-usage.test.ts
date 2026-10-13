import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Web Voice minute accounting (WV-2) on the in-memory Firestore, whose
 * transactions re-run on contention like Firestore's. Only `fetch` is faked,
 * answering as ElevenLabs' conversation lookup. Pinned: the cap and the
 * concurrency limit hold under parallel reservations, a grant is claimed
 * once, a call is counted once however many settles race, and the reply
 * endpoint's permission follows the reservation.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const {
  WebVoiceLimitError,
  markConnected,
  reserveGrant,
  settleConversation,
  sweepStalePending,
  voiceTurnAllowed,
  webVoiceCapReached,
} = await import("./web-voice-usage");

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SESSION = "subAccounts/sa1/webChatSessions/sess_aaaaaaaaaaaaaaaa";
const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const CONN = { apiKey: "el_key", agentId: "agent1", maxCallSeconds: 300, dailyMinuteCap: 60 };
const EL = "https://api.elevenlabs.io/v1/convai/conversations/";

type Conv = { status: number; body?: Record<string, unknown> };
let conversations: Map<string, Conv>;
let lookups: string[];
const warn = vi.fn();

beforeEach(() => {
  mem.clear();
  conversations = new Map();
  lookups = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.startsWith(EL)) throw new Error(`unexpected fetch ${url}`);
      const id = url.slice(EL.length);
      lookups.push(id);
      const c = conversations.get(id) ?? { status: 404, body: { detail: "Conversation not found" } };
      return new Response(JSON.stringify(c.body ?? {}), { status: c.status });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(warn.mockClear());
  mem.seed(SESSION, { agencyId: "ag1", subAccountId: "sa1", messageCount: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const done = (secs: number, agentId = "agent1"): Conv => ({
  status: 200,
  body: { agent_id: agentId, status: "done", metadata: { call_duration_secs: secs } },
});

async function connected(conversationId: string) {
  const grantId = await reserveGrant("sa1", CONN);
  expect(await markConnected({ subAccountId: "sa1", grantId, conversationId, sessionId: SESSION_ID })).toBe(true);
  return grantId;
}

describe("reserveGrant", () => {
  it("never admits more than the concurrency limit, even when requests race", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => reserveGrant("sa1", CONN)));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(3);
    expect(Object.keys(mem.read(USAGE)?.grants as object)).toHaveLength(3);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(WebVoiceLimitError);
    expect(refused.reason.reason).toBe("busy");
  });

  it("refuses a call that could overshoot today's cap, counting reservations at full length", async () => {
    // 60-minute cap, 5-minute calls: 51 settled minutes + one 5-minute reservation leave no room for another.
    mem.seed(USAGE, { day: new Date().toISOString().slice(0, 10), secondsToday: 51 * 60, pending: {}, grants: {}, settled: [] });
    await reserveGrant("sa1", CONN);
    await expect(reserveGrant("sa1", CONN)).rejects.toMatchObject({ reason: "daily_cap" });
  });

  it("starts a new UTC day from zero", async () => {
    mem.seed(USAGE, { day: "2000-01-01", secondsToday: 99_999, month: "2000-01", secondsThisMonth: 99_999 });
    await reserveGrant("sa1", CONN);
    expect(mem.read(USAGE)).toMatchObject({ secondsToday: 0, secondsThisMonth: 0 });
  });

  it("frees the concurrency slot of a grant nobody claimed after two minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 3; i++) await reserveGrant("sa1", CONN);
    await expect(reserveGrant("sa1", CONN)).rejects.toMatchObject({ reason: "busy" });
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
    await expect(reserveGrant("sa1", CONN)).resolves.toEqual(expect.any(String));
  });
});

describe("markConnected", () => {
  it("claims a grant once; a replay or an unknown grant claims nothing", async () => {
    const grantId = await reserveGrant("sa1", CONN);
    const claim = (conversationId: string, g = grantId) =>
      markConnected({ subAccountId: "sa1", grantId: g, conversationId, sessionId: SESSION_ID });
    expect(await claim("conv_000001")).toBe(true);
    expect(await claim("conv_000002")).toBe(false);
    expect(await claim("conv_000003", "never_issued")).toBe(false);
    expect(mem.read(USAGE)?.pending).toEqual({
      conv_000001: { sessionId: SESSION_ID, grantId, startedAtMs: expect.any(Number) },
    });
    expect(mem.read(USAGE)?.grants).toEqual({});
  });
});

describe("voiceTurnAllowed", () => {
  const allowed = (grantId: string, sessionId = SESSION_ID) =>
    voiceTurnAllowed({ subAccountId: "sa1", sessionId, grantId });

  it("allows a live grant, refuses it once it lapses unclaimed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    conversations.set("conv_000001", done(42));
    await settleConversation({ subAccountId: "sa1", conversationId: "conv_000001", conn: CONN, maxCallSeconds: 300 });
    expect(await allowed(grantId)).toBe(false);
  });
});

describe("settleConversation", () => {
  const settle = (conversationId = "conv_000001") =>
    settleConversation({ subAccountId: "sa1", conversationId, conn: CONN, maxCallSeconds: 300 });

  it("counts ElevenLabs' duration exactly once, on the usage doc and the session, however many settles race", async () => {
    await connected("conv_000001");
    conversations.set("conv_000001", done(42.4));
    await Promise.all([settle(), settle(), settle()]);
    await settle();
    expect(mem.read(USAGE)).toMatchObject({ secondsToday: 42, secondsThisMonth: 42, pending: {}, settled: ["conv_000001"] });
    expect(mem.read(SESSION)?.voiceSeconds).toBe(42);
  });

  it("keeps a live call pending", async () => {
    await connected("conv_000001");
    conversations.set("conv_000001", { status: 200, body: { agent_id: "agent1", status: "in-progress" } });
    await settle();
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_000001"]);
    expect(mem.read(USAGE)?.secondsToday).toBe(0);
  });

  it.each([
    ["ElevenLabs does not know the id (404)", undefined],
    ["the conversation belongs to another agent", done(1, "agent_other")],
  ])("counts the full reservation when %s", async (_label, conv) => {
    await connected("conv_000001");
    if (conv) conversations.set("conv_000001", conv);
    await settle();
    expect(mem.read(USAGE)).toMatchObject({ secondsToday: 300, pending: {} });
  });

  it("keeps the call pending on a transient lookup failure and logs only the message", async () => {
    await connected("conv_000001");
    conversations.set("conv_000001", { status: 500, body: { detail: "boom" } });
    await settle();
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_000001"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duration lookup failed"), "boom");
  });

  it("ignores an id that is not pending without asking ElevenLabs", async () => {
    await settle("conv_unknown");
    expect(lookups).toEqual([]);
    expect(mem.read(USAGE)).toBeUndefined();
  });
});

describe("sweepStalePending and the widget cap", () => {
  it("settles finished calls older than 15 seconds, leaving fresh ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connected("conv_old0001");
    vi.setSystemTime(Date.now() + 20_000);
    await connected("conv_new0001");
    conversations.set("conv_old0001", done(60));
    conversations.set("conv_new0001", done(5));
    await sweepStalePending({ subAccountId: "sa1", conn: CONN });
    expect(lookups).toEqual(["conv_old0001"]);
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_new0001"]);
  });

  it("hides the mic only on settled seconds", async () => {
    expect(await webVoiceCapReached("sa1", CONN)).toBe(false);
    mem.seed(USAGE, { day: new Date().toISOString().slice(0, 10), secondsToday: 56 * 60 });
    expect(await webVoiceCapReached("sa1", CONN)).toBe(true);
  });
});
