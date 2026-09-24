import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An AI auto-reply generated inside the workspace's quiet hours is held, not
 * sent and not dropped: it is parked with the rail the customer wrote in on,
 * and released when the window opens. Real respond flow and real WhatsApp
 * dispatcher (the seam decides); the rail clients are counters, so nothing is
 * sent. 21:00Z = 23:00 SAST.
 */

const s = vi.hoisted(() => ({ cloudSends: 0, holds: [] as unknown[], activities: [] as unknown[] }));

const emptyColl = {
  add: async (d: unknown) => void s.activities.push(d),
  doc: () => ({ set: async () => {} }),
  orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({ collection: () => emptyColl }) }) }),
}));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { serverTimestamp: () => "ts" } }));
vi.mock("@/lib/server/conversations-service", () => ({
  getConversationControls: async () => ({ botMode: "auto", botPausedUntilMs: null, loopResetAtMs: null }),
  setConversationDraft: async () => {},
  upsertConversationForMessage: async () => {},
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async () => ({ text: "reply", model: "m", totalTokens: 10, promptTokens: 5, completionTokens: 5 }),
}));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/comms/ai/agent", () => ({ incrementChannelTokens: async () => {} }));
vi.mock("@/lib/comms/ai/context", () => ({ buildContactContextBlock: async () => null }));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "sys" }));
vi.mock("@/lib/comms/ai/loop-guard", () => ({ detectAiReplyLoop: async () => null }));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => true }));
vi.mock("@/lib/comms/meta", () => ({ sendMetaMessage: async () => "mid" }));
vi.mock("@/lib/comms/twilio", () => ({ sendSmsForSubAccount: vi.fn(), sendWhatsappForSubAccount: vi.fn() }));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({ phoneNumberId: "pn", wabaId: "w", accessToken: "t" }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-client", () => ({
  sendWhatsappCloud: async () => {
    s.cloudSends++;
    return { ok: true, messageId: "cloud-1" };
  },
}));
vi.mock("@/lib/comms/quiet-hours-hold", () => ({
  holdForQuietHours: async (h: unknown) => {
    s.holds.push(h);
    return true;
  },
}));

import { maybeRespondWithAi } from "./respond";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { ResolvedAiAgent } from "@/types/ai";

const agent = {
  effective: {
    enabled: true, systemPrompt: "be nice", businessName: "Biz", hoursStart: 0, hoursEnd: 24,
    timezone: "Africa/Johannesburg", escalationKeywords: [], escalationNotifyEmail: "", contextMessageCount: 10,
    modelOverride: null, websiteKb: null,
  },
} as unknown as ResolvedAiAgent;
const subAccount = {
  agencyId: "ag", name: "Biz", whatsappProvider: "cloud",
  whatsappSenders: [{ id: "s-cloud", label: "Cloud", provider: "cloud", phoneNumber: "+27110000001", isDefault: true }],
  sendWindow: { startHour: 8, endHour: 20, timezone: "Africa/Johannesburg" },
} as unknown as SubAccountDoc;
const respond = () =>
  maybeRespondWithAi({
    subAccountId: "sa", subAccount, agent, channelId: "whatsapp", contact: { id: "c1", name: "Cust" } as Contact,
    incomingMessage: "hello", replyTo: "+27820000000", inboundProvider: "cloud",
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  s.cloudSends = 0;
  s.holds = [];
  s.activities = [];
});
afterEach(() => vi.useRealTimers());

describe("AI auto-reply in quiet hours", () => {
  it("at 23:00 SAST holds the generated reply instead of sending it", async () => {
    vi.setSystemTime(new Date("2026-09-24T21:00:00Z"));
    expect(await respond()).toMatchObject({ kind: "held", replyText: "reply" });
    expect(s.cloudSends).toBe(0);
    expect(s.holds).toEqual([
      {
        agencyId: "ag",
        subAccountId: "sa",
        payload: {
          kind: "message",
          message: { channel: "whatsapp", contactId: "c1", to: "+27820000000", body: "reply", senderId: "s-cloud", source: "ai_reply" },
        },
        hold: { retryAfterSec: 9 * 3600, until: new Date("2026-09-25T06:00:00Z") },
      },
    ]);
  });

  it("inside the window replies straight away", async () => {
    vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
    expect((await respond()).kind).toBe("replied");
    expect(s.cloudSends).toBe(1);
    expect(s.holds).toEqual([]);
  });
});
