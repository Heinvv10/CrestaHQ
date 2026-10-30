import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * maybeRespondWithAi, WhatsApp channel, through the REAL send dispatcher and
 * sender resolution down to the rail clients (which are faked — nothing is
 * sent). Covers:
 *   - the bot-to-bot reply-loop guard, and
 *   - the reply leaving on the rail the customer wrote in on, not the default.
 */

interface Row {
  direction: string;
  aiGenerated?: boolean;
  body?: string;
  createdAtMs: number;
}

const s = vi.hoisted(() => ({
  thread: [] as Row[],
  controls: {
    botMode: "auto",
    botPausedUntilMs: null as number | null,
    loopResetAtMs: null as number | null,
  },
  threadReadThrows: false,
  pauseThrows: false,
  /** The conversation doc's stored aiLoopPausedAt from a prior trip, if any. */
  priorLoopPausedAtMs: null as number | null,
  escalations: [] as string[],
  loopEmails: [] as Array<{ to: string; subject: string }>,
  loopPushes: [] as Array<{ subAccountId: string; agencyId: string; title: string; body: string; url: string }>,
  twilioSends: 0,
  conversationUpdates: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  llmCalls: 0,
  cloudSends: 0,
  bridgeSends: 0,
  /** Route callAi through the REAL OpenRouter client (fetch is stubbed). */
  realLlm: false,
  docSets: [] as Array<{ path: string; data: Record<string, unknown> }>,
}));

const fakeDb = {
  doc: (path: string) => ({
    set: async (data: Record<string, unknown>) => {
      s.docSets.push({ path, data });
    },
  }),
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({
        data: () =>
          name === "conversations" && s.priorLoopPausedAtMs !== null
            ? { aiLoopPausedAt: { toMillis: () => s.priorLoopPausedAtMs } }
            : {},
      }),
      update: async (data: Record<string, unknown>) => {
        if (name === "conversations" && s.pauseThrows) throw new Error("write failed");
        if (name === "conversations") {
          s.conversationUpdates.push({ id, ...data });
          const at = data.aiLoopPausedAt;
          if (at instanceof Date) s.priorLoopPausedAtMs = at.getTime();
        }
      },
      collection: (sub: string) => ({
        add: async (data: Record<string, unknown>) => {
          if (sub === "activities") s.activities.push(data);
        },
        doc: () => ({ set: async () => {} }),
        orderBy: () => ({
          limit: (n: number) => ({
            get: async () => {
              // Only the loop guard's scan (>50 rows; history reads cap at 50),
              // so the test isolates the guard's fail-soft path.
              if (s.threadReadThrows && n > 50) throw new Error("read failed");
              return {
              docs: [...s.thread]
                .sort((a, b) => b.createdAtMs - a.createdAtMs)
                .slice(0, n)
                .map((r) => ({
                  data: () => ({
                    direction: r.direction,
                    aiGenerated: r.aiGenerated,
                    body: r.body ?? "x",
                    createdAt: { toMillis: () => r.createdAtMs },
                  }),
                })),
              };
            },
          }),
        }),
      }),
    }),
  }),
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  PAUSE_WINDOW_MS: 12 * 60 * 60 * 1000,
  getConversationControls: async () => s.controls,
  setConversationDraft: async () => {},
  upsertConversationForMessage: async () => {},
}));
vi.mock("@/lib/comms/ai/openrouter", async (orig) => {
  const real = await orig<typeof import("./openrouter")>();
  return {
    ...real,
    callAi: async (opts: Parameters<typeof real.callAi>[0]) => {
      s.llmCalls++;
      if (s.realLlm) return real.callAi(opts);
      return { text: "reply", model: "m", totalTokens: 10, promptTokens: 5, completionTokens: 5 };
    },
  };
});
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/comms/ai/agent", () => ({ incrementChannelTokens: async () => {} }));
vi.mock("@/lib/comms/ai/context", () => ({ buildContactContextBlock: async () => null }));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "sys" }));
vi.mock("@/lib/comms/ai/escalation", () => ({
  matchEscalationKeyword: () => null,
  sendEscalationNotification: async (p: { triggeredKeyword: string }) => {
    s.escalations.push(p.triggeredKeyword);
    return null;
  },
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "bot@biz.test",
  sendEmail: async (e: { to: string; subject: string }) => {
    s.loopEmails.push(e);
    return { id: "e1" };
  },
}));
vi.mock("@/lib/push/send", () => ({
  sendPushForEvent: async (e: {
    subAccountId: string;
    agencyId: string;
    title: string;
    body: string;
    url: string;
  }) => {
    s.loopPushes.push(e);
  },
}));
vi.mock("@/lib/push/events", () => ({
  contactTerritoryId: async () => undefined,
}));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => true }));
vi.mock("@/lib/comms/meta", () => ({ sendMetaMessage: async () => "mid" }));
vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: async () => ({ sid: "sms", from: "+1" }),
  sendWhatsappForSubAccount: async () => {
    s.twilioSends++;
    return { sid: "tw-1", from: "whatsapp:+27110000003" };
  },
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({ phoneNumberId: "pn", wabaId: "w", accessToken: "t" }),
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: async () => ({ baseUrl: "http://bridge", apiKey: "k" }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-client", () => ({
  sendWhatsappCloud: async () => {
    s.cloudSends++;
    return { ok: true, messageId: "cloud-1" };
  },
}));
vi.mock("@/lib/comms/whatsapp/bridge-client", () => ({
  sendWhatsappBridge: async () => {
    s.bridgeSends++;
    return { ok: true, messageId: "bridge-1" };
  },
}));

import { maybeRespondWithAi } from "./respond";
import { AI_LOOP_HARD_CAP, AI_LOOP_PAUSE_MS } from "./loop-guard";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { ResolvedAiAgent } from "@/types/ai";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";

const agent = {
  effective: {
    enabled: true,
    systemPrompt: "be nice",
    businessName: "Biz",
    hoursStart: 0,
    hoursEnd: 24,
    timezone: "Africa/Johannesburg",
    escalationKeywords: [],
    escalationNotifyEmail: "ops@biz.test",
    contextMessageCount: 10,
    modelOverride: null,
    websiteKb: null,
  },
} as unknown as ResolvedAiAgent;

/** Default sender is the Cloud number; a bridge number is registered too. */
const subAccount = {
  agencyId: "ag",
  name: "Biz",
  whatsappProvider: "cloud",
  whatsappSenders: [
    { id: "s-cloud", label: "Cloud", provider: "cloud", phoneNumber: "+27110000001", isDefault: true },
    { id: "s-bridge", label: "Bridge", provider: "bridge", phoneNumber: "+27110000002" },
    { id: "s-twilio", label: "Twilio", provider: "twilio", phoneNumber: "+27110000003" },
  ],
} as unknown as SubAccountDoc;

function respond(inboundProvider?: WhatsAppProviderId, withAgent: ResolvedAiAgent = agent) {
  return maybeRespondWithAi({
    subAccountId: "sa",
    subAccount,
    agent: withAgent,
    channelId: "whatsapp",
    contact: { id: "c1", name: "Cust" } as Contact,
    incomingMessage: "hello",
    replyTo: "+27820000000",
    inboundProvider,
  });
}

/**
 * `n` AI replies, each answered `gapMs` later by an inbound, ending with the
 * current inbound (already written by the webhook, as in production) at ~now.
 */
function seedExchanges(n: number, gapMs: number, body = (i: number) => `msg ${i}`) {
  const now = Date.now();
  let at = now - n * (gapMs + 1_000);
  s.thread.push({ direction: "inbound", body: body(-1), createdAtMs: at - 1_000 });
  for (let i = 0; i < n; i++) {
    s.thread.push({ direction: "outbound", aiGenerated: true, createdAtMs: at });
    at += gapMs;
    s.thread.push({ direction: "inbound", body: body(i), createdAtMs: Math.min(at, now) });
    at += 1_000;
  }
}

beforeEach(() => {
  s.thread = [];
  s.controls = { botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null };
  s.threadReadThrows = false;
  s.pauseThrows = false;
  s.priorLoopPausedAtMs = null;
  s.escalations = [];
  s.loopEmails = [];
  s.loopPushes = [];
  s.conversationUpdates = [];
  s.activities = [];
  s.llmCalls = 0;
  s.cloudSends = 0;
  s.bridgeSends = 0;
  s.twilioSends = 0;
  s.realLlm = false;
  s.docSets = [];
});

const AUTO_REPLY = "Thanks for your message! We are closed right now and will reply soon."; // 60+ chars

describe("AI reply-loop guard", () => {
  it('never pauses on short repeats — "yes" x3', async () => {
    seedExchanges(2, 20_000, () => "yes");
    s.thread[0].body = "Yes";
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it("never pauses a fast fragment typer (6 replies within seconds)", async () => {
    seedExchanges(6, 2_000);
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it("pauses when the same long auto-reply arrives 3 times in a row", async () => {
    seedExchanges(2, 2_000, () => AUTO_REPLY);
    s.thread[0].body = `  ${AUTO_REPLY.toUpperCase()} `; // normalised equal
    const out = await respond("cloud");
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.llmCalls).toBe(0);
    expect(s.cloudSends + s.bridgeSends).toBe(0);
    const pause = s.conversationUpdates[0];
    expect(pause).toMatchObject({ id: "c1" });
    // One hour — not the 12h a human takeover gets.
    expect(AI_LOOP_PAUSE_MS).toBe(60 * 60 * 1000);
    const until = (pause.botPausedUntil as Date).getTime();
    expect(until).toBeGreaterThan(Date.now() + 60 * 60 * 1000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(s.loopEmails).toEqual([
      expect.objectContaining({
        to: "ops@biz.test",
        subject: "AI auto-reply loop suspected — bot paused for 1h on Cust",
      }),
    ]);
    expect(s.loopPushes).toEqual([
      expect.objectContaining({
        subAccountId: "sa",
        title: "AI bot paused — reply loop",
      }),
    ]);
    expect(s.escalations).toEqual([]); // not the keyword-escalation template
    expect(s.activities.at(-1)).toMatchObject({
      type: "ai_skipped",
      meta: { reason: "reply_loop", loop: "repeated_text", paused: true },
    });
  });

  it("the same text twice is not enough", async () => {
    seedExchanges(1, 2_000, () => AUTO_REPLY);
    expect((await respond("cloud")).kind).toBe("replied");
  });

  it(`hard cap: pauses at ${AI_LOOP_HARD_CAP + 1} AI replies in 10 min`, async () => {
    seedExchanges(AI_LOOP_HARD_CAP - 1, 10_000);
    expect((await respond("cloud")).kind).toBe("replied");
    s.thread = [];
    seedExchanges(AI_LOOP_HARD_CAP + 1, 10_000);
    expect(await respond("cloud")).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.activities.at(-1)).toMatchObject({ meta: { loop: "volume_cap" } });
  });

  it("a resume sticks: the next message after the reset marker gets a reply", async () => {
    seedExchanges(4, 2_000, () => AUTO_REPLY);
    const last = Math.max(...s.thread.map((r) => r.createdAtMs));
    s.controls.loopResetAtMs = last - 500; // paused, then resumed, before the newest inbound
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it("fails soft on a thread read error — the customer still gets a reply", async () => {
    s.threadReadThrows = true;
    expect((await respond("cloud")).kind).toBe("replied");
  });

  it("does not claim the bot is paused when the pause write fails", async () => {
    seedExchanges(2, 2_000, () => AUTO_REPLY);
    s.thread[0].body = AUTO_REPLY;
    s.pauseThrows = true;
    expect((await respond("cloud")).kind).toBe("skipped");
    const act = s.activities.at(-1) as { content: string; meta: { paused: boolean } };
    expect(act.meta.paused).toBe(false);
    expect(act.content).not.toContain("Bot paused");
    expect(s.loopEmails[0].subject).toContain("pausing the bot FAILED");
  });

  it("trips on an auto-reply that varies only by ticket number", async () => {
    const varying = (i: number) =>
      `We're away right now — ticket #482${i}, we'll reply once we're back.`;
    seedExchanges(2, 2_000, varying);
    s.thread[0].body = varying(9);
    const out = await respond("cloud");
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.activities.at(-1)).toMatchObject({ meta: { loop: "repeated_text" } });
  });

  it("a human sending short numeric texts does not trip", async () => {
    const orders = ["order 123", "order 456", "order 789"];
    seedExchanges(2, 20_000, (i) => orders[i + 1]);
    s.thread[0].body = orders[0];
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it("a second loop trip within 24h turns the bot off instead of re-pausing", async () => {
    s.priorLoopPausedAtMs = Date.now() - 1_000; // an earlier trip, well within 24h
    seedExchanges(2, 2_000, () => AUTO_REPLY);
    s.thread[0].body = AUTO_REPLY;
    const out = await respond("cloud");
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.conversationUpdates.at(-1)).toMatchObject({
      botMode: "off",
      botPausedUntil: null,
    });
    expect(s.loopEmails.at(-1)).toEqual(
      expect.objectContaining({ subject: "AI auto-reply loop suspected — bot turned OFF on Cust" }),
    );
    expect(s.loopPushes.at(-1)).toEqual(
      expect.objectContaining({ title: "AI bot turned OFF — reply loop" }),
    );
    expect(s.activities.at(-1)).toMatchObject({
      meta: { reason: "reply_loop", paused: true, turnedOff: true },
    });
  });

  it("pushes staff even when no escalationNotifyEmail is configured (email would otherwise be the only alert)", async () => {
    const noEmailAgent = {
      effective: { ...agent.effective, escalationNotifyEmail: "" },
    } as unknown as ResolvedAiAgent;
    seedExchanges(2, 2_000, () => AUTO_REPLY);
    s.thread[0].body = AUTO_REPLY;
    const out = await maybeRespondWithAi({
      subAccountId: "sa",
      subAccount,
      agent: noEmailAgent,
      channelId: "whatsapp",
      contact: { id: "c1", name: "Cust" } as Contact,
      incomingMessage: "hello",
      replyTo: "+27820000000",
      inboundProvider: "cloud",
    });
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.loopEmails).toEqual([]);
    expect(s.loopPushes).toEqual([
      expect.objectContaining({ subAccountId: "sa", title: "AI bot paused — reply loop" }),
    ]);
  });

  it("resuming after a turn-off answers normally again", async () => {
    s.priorLoopPausedAtMs = Date.now() - 1_000;
    seedExchanges(2, 2_000, () => AUTO_REPLY);
    s.thread[0].body = AUTO_REPLY;
    expect(await respond("cloud")).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.conversationUpdates.at(-1)).toMatchObject({ botMode: "off" });

    // Operator turns the bot back on for this conversation.
    s.controls.botMode = "auto";
    s.controls.loopResetAtMs = s.priorLoopPausedAtMs;
    s.thread = [];
    seedExchanges(1, 2_000, () => "a normal one-off follow-up message");
    expect((await respond("cloud")).kind).toBe("replied");
  });
});

describe("AI reply rail", () => {
  it("replies on the rail the inbound arrived on, not the default sender", async () => {
    const out = await respond("bridge");
    expect(out.kind).toBe("replied");
    expect(s.bridgeSends).toBe(1);
    expect(s.cloudSends).toBe(0);
  });

  it("uses the default sender when the inbound rail is unknown", async () => {
    await respond();
    expect(s.cloudSends).toBe(1);
    expect(s.bridgeSends).toBe(0);
  });

  it("replies on Twilio when the inbound arrived on Twilio", async () => {
    await respond("twilio");
    expect(s.twilioSends).toBe(1);
    expect(s.cloudSends + s.bridgeSends).toBe(0);
  });
});

describe("model refused by OpenRouter (live reply seam)", () => {
  it("retries once on the app default, still replies, and flags the channel", async () => {
    s.realLlm = true;
    process.env.OPENROUTER_API_KEY = "sk-test";
    delete process.env.AI_REPLIES_DEFAULT_MODEL;
    const models: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      models.push(model);
      if (model === "gone/model") return new Response('{"error":{"message":"not found"}}', { status: 404 });
      return Response.json({ choices: [{ message: { content: "hi there" } }], usage: { total_tokens: 3 }, model });
    }));
    try {
      const withOverride = { effective: { ...agent.effective, modelOverride: "gone/model" } } as unknown as ResolvedAiAgent;
      expect((await respond("cloud", withOverride)).kind).toBe("replied");
      expect(models).toEqual(["gone/model", "anthropic/claude-haiku-4-5"]);
      await vi.waitFor(() =>
        expect(s.docSets).toContainEqual({
          path: "subAccounts/sa/aiAgent/whatsapp",
          data: { modelRejected: { model: "gone/model", at: expect.any(Number) } },
        }),
        { timeout: 10_000 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
