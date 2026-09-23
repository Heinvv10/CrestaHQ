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
  createdAtMs: number;
}

const s = vi.hoisted(() => ({
  thread: [] as Row[],
  controls: {
    botMode: "auto",
    botPausedUntilMs: null as number | null,
    lastHumanReplyAtMs: null as number | null,
  },
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
        if (name === "conversations") s.conversationUpdates.push({ id, ...data });
      },
      collection: (sub: string) => ({
        add: async (data: Record<string, unknown>) => {
          if (sub === "activities") s.activities.push(data);
        },
        doc: () => ({ set: async () => {} }),
        orderBy: () => ({
          limit: (n: number) => ({
            get: async () => ({
              docs: [...s.thread]
                .sort((a, b) => b.createdAtMs - a.createdAtMs)
                .slice(0, n)
                .map((r) => ({
                  data: () => ({
                    direction: r.direction,
                    aiGenerated: r.aiGenerated,
                    body: "x",
                    createdAt: { toMillis: () => r.createdAtMs },
                  }),
                })),
            }),
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
  sendEscalationNotification: async () => {},
}));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => true }));
vi.mock("@/lib/comms/meta", () => ({ sendMetaMessage: async () => "mid" }));
vi.mock("@/lib/comms/twilio", () => ({
  sendSmsForSubAccount: async () => ({ sid: "sms", from: "+1" }),
  sendWhatsappForSubAccount: async () => {
    throw new Error("twilio rail not expected in this test");
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
import { AI_LOOP_MAX_REPLIES, AI_LOOP_WINDOW_MS } from "./loop-guard";
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
    escalationNotifyEmail: null,
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

/** `n` inbound/AI-reply pairs, one per minute, ending `endAgoMs` ago. */
function seedLoop(n: number, endAgoMs = 0) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const at = now - endAgoMs - (n - i) * 60_000;
    s.thread.push({ direction: "inbound", createdAtMs: at });
    s.thread.push({ direction: "outbound", aiGenerated: true, createdAtMs: at + 1_000 });
  }
}

beforeEach(() => {
  s.thread = [];
  s.controls = { botMode: "auto", botPausedUntilMs: null, lastHumanReplyAtMs: null };
  s.conversationUpdates = [];
  s.activities = [];
  s.llmCalls = 0;
  s.cloudSends = 0;
  s.bridgeSends = 0;
});

describe("AI reply-loop guard", () => {
  it(`stops after ${AI_LOOP_MAX_REPLIES} AI replies in the window with no human reply, and pauses the bot`, async () => {
    seedLoop(AI_LOOP_MAX_REPLIES);
    const out = await respond("cloud");
    expect(out).toEqual({ kind: "skipped", reason: "reply_loop" });
    expect(s.llmCalls).toBe(0);
    expect(s.cloudSends + s.bridgeSends).toBe(0);
    expect(s.conversationUpdates).toHaveLength(1);
    expect(s.conversationUpdates[0]).toMatchObject({ id: "c1" });
    expect((s.conversationUpdates[0].botPausedUntil as Date).getTime()).toBeGreaterThan(Date.now());
    expect(s.activities.at(-1)).toMatchObject({ meta: { reason: "reply_loop" } });
  });

  it("still replies below the cap", async () => {
    seedLoop(AI_LOOP_MAX_REPLIES - 1);
    expect((await respond("cloud")).kind).toBe("replied");
    expect(s.conversationUpdates).toHaveLength(0);
  });

  it("replies once the earlier AI replies fall outside the window", async () => {
    seedLoop(AI_LOOP_MAX_REPLIES, AI_LOOP_WINDOW_MS);
    expect((await respond("cloud")).kind).toBe("replied");
  });

  it("a human reply resets the count", async () => {
    seedLoop(AI_LOOP_MAX_REPLIES);
    s.controls.lastHumanReplyAtMs = Date.now() - 90_000; // after most of the loop
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
});
