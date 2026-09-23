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
  escalations: [] as string[],
  twilioSends: 0,
  conversationUpdates: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  llmCalls: 0,
  cloudSends: 0,
  bridgeSends: 0,
}));

const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => {
        if (name === "conversations" && s.pauseThrows) throw new Error("write failed");
        if (name === "conversations") s.conversationUpdates.push({ id, ...data });
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
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async () => {
    s.llmCalls++;
    return { text: "reply", model: "m", totalTokens: 10, promptTokens: 5, completionTokens: 5 };
  },
}));
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
import { AI_LOOP_FAST_EXCHANGES, AI_LOOP_HARD_CAP, AI_LOOP_PAUSE_MS } from "./loop-guard";
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

function respond(inboundProvider?: WhatsAppProviderId) {
  return maybeRespondWithAi({
    subAccountId: "sa",
    subAccount,
    agent,
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
  s.escalations = [];
  s.conversationUpdates = [];
  s.activities = [];
  s.llmCalls = 0;
  s.cloudSends = 0;
  s.bridgeSends = 0;
  s.twilioSends = 0;
});

describe("AI reply-loop guard", () => {
  it("never pauses a human-paced conversation (5 quick Q/A turns in 10 min)", async () => {
    seedExchanges(5, 45_000);
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it(`pauses instant auto-responder ping-pong after ${AI_LOOP_FAST_EXCHANGES} exchanges`, async () => {
    seedExchanges(AI_LOOP_FAST_EXCHANGES - 1, 2_000);
    expect((await respond("cloud")).kind).toBe("replied");

    s.thread = [];
    seedExchanges(AI_LOOP_FAST_EXCHANGES, 2_000);
    const out = await respond("cloud");
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.llmCalls).toBe(1); // only the earlier, un-tripped turn
    expect(s.cloudSends).toBe(1);
    const pause = s.conversationUpdates[0];
    expect(pause).toMatchObject({ id: "c1" });
    const until = (pause.botPausedUntil as Date).getTime();
    // One hour — not the 12h a human takeover gets.
    expect(AI_LOOP_PAUSE_MS).toBe(60 * 60 * 1000);
    expect(until).toBeGreaterThan(Date.now() + 60 * 60 * 1000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(s.escalations).toEqual(["auto-reply loop"]);
    expect(s.activities.at(-1)).toMatchObject({
      type: "ai_skipped",
      meta: { reason: "reply_loop", loop: "auto_responder", paused: true },
    });
  });

  it("pauses when the same text arrives 3 times in a row", async () => {
    seedExchanges(2, 60_000, () => "  Thanks for your message!  We'll reply SOON ");
    s.thread[2].body = "thanks for your message! we'll reply soon";
    expect(await respond("cloud")).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.activities.at(-1)).toMatchObject({ meta: { loop: "repeated_text" } });
  });

  it(`hard cap: pauses at ${AI_LOOP_HARD_CAP} AI replies in 10 min even at a human pace`, async () => {
    seedExchanges(AI_LOOP_HARD_CAP - 1, 10_000);
    expect((await respond("cloud")).kind).toBe("replied");
    s.thread = [];
    seedExchanges(AI_LOOP_HARD_CAP, 10_000);
    expect(await respond("cloud")).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.activities.at(-1)).toMatchObject({ meta: { loop: "volume_cap" } });
  });

  it("a resume sticks: the next message after the reset marker gets a reply", async () => {
    seedExchanges(AI_LOOP_FAST_EXCHANGES + 2, 2_000);
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
    seedExchanges(AI_LOOP_FAST_EXCHANGES, 2_000);
    s.pauseThrows = true;
    expect((await respond("cloud")).kind).toBe("skipped");
    const act = s.activities.at(-1) as { content: string; meta: { paused: boolean } };
    expect(act.meta.paused).toBe(false);
    expect(act.content).not.toContain("Bot paused");
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
