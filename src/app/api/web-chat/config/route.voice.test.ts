import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `voiceEnabled` on /api/web-chat/config (WV-2): the origin-checked request
 * that hands the widget its voice token. Real route, gates, service, usage
 * and tokens on the in-memory Firestore; only the channel config is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () => ({
    enabled: true,
    webChat: { allowedDomains: ["shop.example"], welcomeMessage: "Hello", accentColor: "#0ea5e9", position: "right" },
  }),
}));

const { mem } = await import("@/test/gbp-sync-store");
const { flushAfterResponse } = await import("@/lib/server/after-response");
const { fakeElevenLabsConversations } = await import("@/test/fake-elevenlabs-conversations");
const { GET } = await import("./route");
const { verifyWidgetToken } = await import("@/lib/web-voice/tokens");

const USAGE = "subAccounts/sa1/private/webVoiceUsage";
const SUB = { agencyId: "ag1", webVoiceEnabledByAgency: true, webVoiceMeta: { ready: true, enabled: true } };

const config = async (origin = "https://shop.example") =>
  (await (await GET(new Request("https://app.test/api/web-chat/config?sa=sa1", { headers: { origin } }))).json()) as Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-at-least-16-chars");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mem.seed("subAccounts/sa1", SUB);
  mem.seed("subAccounts/sa1/private/webVoiceConnection", {
    apiKey: "el_key", agentId: "agent1", endpointSecret: "secret_xxxxxxxxxxxxxxxx", maxCallSeconds: 300, dailyMinuteCap: 60,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voiceEnabled on the widget config", () => {
  it("is on, with a widget token for this sub-account, when everything allows it", async () => {
    const out = await config();
    expect(out).toMatchObject({ enabled: true, voiceEnabled: true });
    expect(verifyWidgetToken(out.voiceToken, "sa1")).toBe(true);
  });

  it.each([
    ["the Web Voice gate is off", { ...SUB, webVoiceEnabledByAgency: false }],
    ["the agent is not ready", { ...SUB, webVoiceMeta: { ready: false, enabled: true } }],
    ["the operator switched voice off", { ...SUB, webVoiceMeta: { ready: true, enabled: false } }],
  ])("is off, with no token, when %s", async (_label, sub) => {
    mem.seed("subAccounts/sa1", sub);
    const out = await config();
    expect(out).toMatchObject({ enabled: true, voiceEnabled: false });
    expect(out).not.toHaveProperty("voiceToken");
  });

  it("is off when no agent is provisioned, and once today's cap is reached", async () => {
    mem.seed("subAccounts/sa1/private/webVoiceConnection", { apiKey: "k", agentId: null, endpointSecret: "secret_xxxxxxxxxxxxxxxx" });
    expect(await config()).toMatchObject({ voiceEnabled: false });
    mem.seed("subAccounts/sa1/private/webVoiceConnection", {
      apiKey: "el_key", agentId: "agent1", endpointSecret: "secret_xxxxxxxxxxxxxxxx", maxCallSeconds: 300, dailyMinuteCap: 60,
    });
    mem.seed(USAGE, { day: new Date().toISOString().slice(0, 10), secondsToday: 56 * 60 });
    expect(await config()).toMatchObject({ voiceEnabled: false });
  });

  it("carries no voice fields at all for a disallowed origin or with Web Chat gated off", async () => {
    expect(await config("https://evil.example")).toEqual({ enabled: false, reason: expect.any(String) });
    mem.seed("subAccounts/sa1", { ...SUB, webChatEnabledByAgency: false });
    expect(await config()).toEqual({ enabled: false });
  });

  it("when the cap looks reached, sweeps usage after the response (once a minute), so abandoned starts' charges come back", async () => {
    // An earlier test here already used this minute's sweep for sa1.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const el = fakeElevenLabsConversations();
    vi.stubGlobal("fetch", el.fetchMock);
    const issuedAtMs = Date.now() - 25 * 60 * 1000;
    const day = new Date().toISOString().slice(0, 10);
    mem.seed(USAGE, {
      day,
      month: day.slice(0, 7),
      secondsToday: 3360,
      secondsThisMonth: 3360,
      lapsed: { g1: { issuedAtMs, day, month: day.slice(0, 7), chargedSeconds: 3360, agentId: "agent1" } },
      watermarks: { agent1: issuedAtMs - 30_000 },
    });
    const seed = mem.read(USAGE)!;
    expect(await config()).toMatchObject({ voiceEnabled: false });
    await flushAfterResponse();
    expect(el.state.listCalls).toHaveLength(1);
    expect(await config()).toMatchObject({ voiceEnabled: true });
    // Full again within the minute: no second sweep until it has passed.
    mem.seed(USAGE, seed);
    expect(await config()).toMatchObject({ voiceEnabled: false });
    await flushAfterResponse();
    expect(el.state.listCalls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await config()).toMatchObject({ voiceEnabled: false });
    await flushAfterResponse();
    expect(el.state.listCalls).toHaveLength(2);
    vi.useRealTimers();
  });
});
