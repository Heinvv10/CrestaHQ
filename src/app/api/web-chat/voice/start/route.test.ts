import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/web-chat/voice/start and /voice/event (WV-2) through the REAL routes,
 * tokens, usage accounting, session store and ElevenLabs client, on the
 * in-memory Firestore. Faked: `fetch` (answering as ElevenLabs), the agent
 * config, business hours, the conversation's AI controls and the AI quota.
 */

const state = vi.hoisted(() => ({
  channelEnabled: true,
  withinHours: true,
  botMode: "auto" as string,
  quotaAllowed: true,
}));

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () => ({ enabled: state.channelEnabled, webChat: {} }),
  resolveAgent: async () => ({ effective: { hoursStart: "08:00", hoursEnd: "17:00", timezone: "UTC" } }),
}));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => state.withinHours }));
vi.mock("@/lib/server/conversations-service", () => ({
  getConversationControls: async () => ({ botMode: state.botMode, botPausedUntilMs: null, loopResetAtMs: null }),
}));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: state.quotaAllowed }) }));

const { mem } = await import("@/test/gbp-sync-store");
const { POST: start } = await import("./route");
const { POST: event } = await import("../event/route");
const { issueSessionToken, issueWidgetToken, verifySessionToken } = await import("@/lib/web-voice/tokens");

const SESSION_ID = "sess_aaaaaaaaaaaaaaaa";
const SESSION = `subAccounts/sa1/webChatSessions/${SESSION_ID}`;
const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const EL = "https://api.elevenlabs.io";
const CONN = {
  apiKey: "el_key_sa1", agentId: "agent1", endpointSecret: "secret_sa1_xxxxxxxxxxxx", rev: "r1",
  maxCallSeconds: 300, dailyMinuteCap: 60, greeting: "Hi there, how can I help?",
};

let elCalls: string[];
let durations: Map<string, number>;
/** Conversations ElevenLabs reports live on agent1 (until a duration is set). */
let liveConvs: Set<string>;

const post = (handler: (r: Request) => Promise<Response>, body: unknown, ip = "203.0.113.1") =>
  handler(new Request("https://app.test/api/web-chat/voice/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "https://shop.example" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
let ipSeq = 0;
/** A fresh IP per call, so the in-memory per-IP start limit stays out of the way. */
const startBody = (over: Record<string, unknown> = {}) => ({
  sa: "sa1", sessionId: SESSION_ID, voiceToken: issueWidgetToken("sa1"), pageUrl: "https://shop.example/", ...over,
});
const tryStart = async (over: Record<string, unknown> = {}) => {
  const res = await post(start, startBody(over), `198.51.100.${++ipSeq}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  mem.clear();
  Object.assign(state, { channelEnabled: true, withinHours: true, botMode: "auto", quotaAllowed: true });
  elCalls = [];
  durations = new Map();
  liveConvs = new Set(["conv_000001"]);
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-at-least-16-chars");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const key = (init?.headers as Record<string, string>)?.["xi-api-key"];
      elCalls.push(`${url.slice(EL.length)} key=${key}`);
      if (url.startsWith(`${EL}/v1/convai/conversation/get-signed-url?agent_id=agent1`)) {
        return Response.json({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?token=signed" });
      }
      const m = /\/v1\/convai\/conversations\/([^/?]+)$/.exec(url);
      const start_time_unix_secs = Math.floor(Date.now() / 1000);
      if (m && durations.has(m[1])) {
        return Response.json({
          agent_id: "agent1", status: "done", metadata: { call_duration_secs: durations.get(m[1]), start_time_unix_secs },
        });
      }
      if (m && liveConvs.has(m[1])) {
        return Response.json({ agent_id: "agent1", status: "in-progress", metadata: { start_time_unix_secs } });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mem.seed("subAccounts/sa1", { agencyId: "ag1", webVoiceEnabledByAgency: true, webVoiceMeta: { ready: true, enabled: true } });
  mem.seed("subAccounts/sa1/private/webVoiceConnection", CONN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/voice/start", () => {
  it("reserves a grant, creates the session and mints a signed URL on the client's own key", async () => {
    const out = await tryStart();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ signedUrl: expect.stringMatching(/^wss:/), maxCallSeconds: 300 });
    const claims = verifySessionToken(out.body.token);
    expect(claims).toMatchObject({ subAccountId: "sa1", sessionId: SESSION_ID });
    expect(Object.keys(mem.read(USAGE)?.grants as object)).toEqual([claims!.grantId]);
    expect(mem.read(SESSION)).toMatchObject({ agencyId: "ag1", pageUrl: "https://shop.example/" });
    expect(elCalls).toEqual(["/v1/convai/conversation/get-signed-url?agent_id=agent1 key=el_key_sa1"]);
  });

  it.each([
    ["the Web Voice gate is off", { webVoiceEnabledByAgency: false }],
    ["the Web Chat gate is off", { webChatEnabledByAgency: false }],
    ["the agent is not ready", { webVoiceMeta: { ready: false, enabled: true } }],
    ["the operator switched voice off", { webVoiceMeta: { ready: true, enabled: false } }],
  ])("is 403 voiceEnabled:false when %s, reserving nothing", async (_label, patch) => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), ...patch });
    expect(await tryStart()).toEqual({ status: 403, body: { error: expect.any(String), voiceEnabled: false } });
    expect(mem.read(USAGE)).toBeUndefined();
    expect(elCalls).toEqual([]);
  });

  it.each([
    ["no widget token", { voiceToken: undefined }],
    ["another sub-account's widget token", { voiceToken: issueWidgetToken("sa2") }],
    ["a forged widget token", { voiceToken: `w1.sa1.${Date.now() + 60_000}.forged` }],
  ])("is 403 voiceEnabled:false with %s", async (_label, over) => {
    expect(await tryStart(over)).toMatchObject({ status: 403, body: { voiceEnabled: false } });
    expect(mem.read(USAGE)).toBeUndefined();
  });

  it("refuses an id that is not a doc id and an invalid session id", async () => {
    expect((await tryStart({ sa: "__sa1__", voiceToken: issueWidgetToken("__sa1__") })).status).toBe(400);
    expect((await tryStart({ sessionId: "short" })).status).toBe(400);
  });

  it("refuses an over-long body", async () => {
    const res = await post(start, startBody({ pageUrl: "x".repeat(9000) }));
    expect(res.status).toBe(413);
  });

  it("keeps the mic but refuses while a human holds the chat or outside hours", async () => {
    state.botMode = "off";
    expect(await tryStart()).toMatchObject({ status: 409, body: { voiceEnabled: true } });
    state.botMode = "auto";
    state.withinHours = false;
    expect(await tryStart()).toMatchObject({ status: 409, body: { voiceEnabled: true } });
    expect(mem.read(USAGE)).toBeUndefined();
  });

  it("hides the mic when the workspace's AI-token quota is used up", async () => {
    state.quotaAllowed = false;
    expect(await tryStart()).toMatchObject({ status: 429, body: { voiceEnabled: false } });
    expect(mem.read(USAGE)).toBeUndefined();
  });

  it("admits at most the concurrency limit of parallel starts", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => tryStart()));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(Object.keys(mem.read(USAGE)?.grants as object)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429).every((r) => r.body.voiceEnabled === true)).toBe(true);
  });

  it("hides the mic once today's cap is reached", async () => {
    mem.seed(USAGE, { day: new Date().toISOString().slice(0, 10), secondsToday: 56 * 60 });
    expect(await tryStart()).toMatchObject({ status: 429, body: { voiceEnabled: false } });
  });

  it("limits starts per IP (counted after the widget token, before any Firestore read)", async () => {
    for (let i = 0; i < 12; i++) await post(start, startBody(), "192.0.2.77");
    const res = await post(start, startBody(), "192.0.2.77");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await res.json()) as { error: string }).error).toMatch(/Too many voice requests/);
  });
});

describe("/voice/event", () => {
  async function started() {
    const out = await tryStart();
    expect(out.status).toBe(200);
    return out.body.token as string;
  }

  it("connected claims the grant once and writes the greeting once, as a voice turn", async () => {
    const token = await started();
    for (let i = 0; i < 2; i++) {
      const res = await post(event, { token, type: "connected", conversationId: "conv_000001" });
      expect(res.status).toBe(200);
      // A resend after the claim is told it holds (the widget stops resending).
      expect(await res.json()).toEqual({ ok: true, claimed: true });
    }
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_000001"]);
    const msgs = mem.list(`${SESSION}/messages`);
    expect(msgs.map((m) => [m.direction, m.body, m.via, m.aiGenerated])).toEqual([
      ["outbound", CONN.greeting, "voice", true],
    ]);
  });

  it("connected with a conversation ElevenLabs does not report live on this agent claims nothing and writes no greeting", async () => {
    const token = await started();
    // ElevenLabs answers 404: one lookup, no retry.
    const forged = await post(event, { token, type: "connected", conversationId: "conv_forged1" });
    expect([forged.status, await forged.json()]).toEqual([200, { ok: true, claimed: false }]);
    // Another session's token never learns that someone else's call is claimed.
    const owner = await tryStart();
    const owned = await post(event, { token: owner.body.token, type: "connected", conversationId: "conv_000001" });
    expect(await owned.json()).toEqual({ ok: true, claimed: true });
    const other = await tryStart({ sessionId: "sess_cccccccccccccccc" });
    const peek = await post(event, { token: other.body.token, type: "connected", conversationId: "conv_000001" });
    expect(await peek.json()).toEqual({ ok: true, claimed: false });
    // Nor does another start from the owner's own session (a different grant).
    const sameSession = await post(event, { token, type: "connected", conversationId: "conv_000001" });
    expect(await sameSession.json()).toEqual({ ok: true, claimed: false });
    for (const conversationId of ["__proto__", "constructor"]) {
      expect((await post(event, { token, type: "connected", conversationId })).status).toBe(400);
    }
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_000001"]); // the owner's only
    expect(mem.list(`${SESSION}/messages`)).toHaveLength(1); // the owner's greeting only
  });

  it("ended from another session's token settles nothing", async () => {
    const token = await started();
    await post(event, { token, type: "connected", conversationId: "conv_000001" });
    durations.set("conv_000001", 95);
    const other = await tryStart({ sessionId: "sess_bbbbbbbbbbbbbbbb" });
    await post(event, { token: other.body.token, type: "ended", conversationId: "conv_000001" });
    expect(Object.keys(mem.read(USAGE)?.pending as object)).toEqual(["conv_000001"]);
    await post(event, { token, type: "ended", conversationId: "conv_000001" });
    expect(mem.read(USAGE)?.pending).toEqual({});
  });

  it("an ended ping for an id that is not pending, or names an Object.prototype member, counts nothing", async () => {
    const token = await started();
    for (const conversationId of ["__proto__", "constructor", "hasOwnProperty", "conv_never01"]) {
      for (let i = 0; i < 2; i++) await post(event, { token, type: "ended", conversationId });
    }
    expect(mem.read(USAGE)?.secondsToday).toBe(0);
  });

  it("limits events per grant: a token's call gets a handful, then 429", async () => {
    const token = await started();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await post(event, { token, type: "ended", conversationId: "conv_none01" }, "198.18.0.1")).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("limits events per IP across grants", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const token = issueSessionToken({ subAccountId: "sa1", sessionId: SESSION_ID, grantId: `grant_ip_${i}` });
      statuses.push((await post(event, { token, type: "ended", conversationId: "conv_none01" }, "198.18.0.2")).status);
    }
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it("ended (sent as a text/plain beacon) settles the duration ElevenLabs reports, once", async () => {
    const token = await started();
    await post(event, { token, type: "connected", conversationId: "conv_000001" });
    durations.set("conv_000001", 95);
    const beacon = JSON.stringify({ token, type: "ended", conversationId: "conv_000001" });
    for (let i = 0; i < 2; i++) await post(event, beacon);
    expect(mem.read(USAGE)).toMatchObject({ secondsToday: 95, pending: {}, settled: ["conv_000001"] });
    expect(mem.read(SESSION)?.voiceSeconds).toBe(95);
  });

  it("refuses a bad token, a bad conversation id and an unknown type, touching nothing", async () => {
    const token = await started();
    const before = mem.read(USAGE);
    for (const body of [
      { token: "s1.sa1.x.y.1.z", type: "connected", conversationId: "conv_000001" },
      { token, type: "connected", conversationId: "../x" },
      { token, type: "other", conversationId: "conv_000001" },
    ]) {
      expect((await post(event, body)).status).toBe(400);
    }
    expect(mem.read(USAGE)).toEqual(before);
  });
});
