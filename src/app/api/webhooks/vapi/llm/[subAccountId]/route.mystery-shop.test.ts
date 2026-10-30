import { beforeEach, expect, it, vi } from "vitest";

/**
 * A mystery-shop call (metadata.mysteryShopId) runs on the short enquiry
 * prompt — never the sub-account's sales persona — with the shop's enquiry
 * only when the shop is this sub-account's call shop.
 */

vi.mock("@/lib/comms/voice/webhook-auth", () => ({ vapiWebhookAuthorized: () => true }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({
    effective: { enabled: true, systemPrompt: "Be a helpful receptionist.", businessName: "Cresta HQ", modelOverride: null },
    channel: { voice: {} },
  }),
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "PERSONA_PROMPT" }));
const systemPrompts: string[] = [];
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async (args: { messages: { role: string; content: string }[] }) => {
    systemPrompts.push(args.messages[0].content);
    return { text: "Thanks!", totalTokens: 5, model: "haiku" };
  },
}));
vi.mock("@/lib/server/agent-booking-service", () => ({
  bookAgentSlot: async () => ({ ok: false, code: "error" }),
  formatSlotForSpeech: () => "",
  getAgentBookingContext: async () => null,
  listAgentSlots: async () => [],
}));
vi.mock("@/lib/booking/page-slots", () => ({ hostSelectionEnabled: () => false }));

const DOCS: Record<string, Record<string, unknown>> = {
  "subAccounts/sa_1": { agencyId: "ag_1", name: "Cresta HQ", outboundVoiceEnabledByAgency: true },
  "mysteryShops/s_ok": { subAccountId: "sa_1", channel: "call", enquiryText: "Do you do plumber in Gqeberha?" },
  "mysteryShops/s_foreign": { subAccountId: "sa_2", channel: "call", enquiryText: "THEIR ENQUIRY" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => {
      const q = { where: () => q, limit: () => q, get: async () => ({ empty: true, docs: [] }) };
      return q;
    },
    doc: (path: string) => ({ get: async () => ({ exists: path in DOCS, data: () => DOCS[path] }) }),
  }),
}));

const { POST } = await import("./route");

const call = (metadata: Record<string, string>) =>
  POST(
    new Request("http://localhost/api/webhooks/vapi/llm/sa_1?s=secret", {
      method: "POST",
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "Yes we do" }], call: { customer: { number: "+27821234567" }, metadata } }),
    }),
    { params: Promise.resolve({ subAccountId: "sa_1" }) },
  );

beforeEach(() => {
  systemPrompts.length = 0;
});

it("uses the mystery-shop prompt with the shop's enquiry and the business name", async () => {
  await call({ direction: "outbound", mysteryShopId: "s_ok" });
  expect(systemPrompts[0]).toContain("on behalf of Cresta HQ");
  expect(systemPrompts[0]).toContain("Do you do plumber in Gqeberha?");
  expect(systemPrompts[0]).not.toContain("PERSONA_PROMPT");
});

it("another sub-account's shop, or a missing one, still never gets the persona — and leaks no enquiry", async () => {
  for (const id of ["s_foreign", "s_missing", "a/b"]) {
    systemPrompts.length = 0;
    await call({ direction: "outbound", mysteryShopId: id });
    expect(systemPrompts[0]).toContain("on behalf of Cresta HQ");
    expect(systemPrompts[0]).not.toContain("THEIR ENQUIRY");
    expect(systemPrompts[0]).not.toContain("PERSONA_PROMPT");
  }
});

it("an ordinary outbound call keeps the persona", async () => {
  await call({ direction: "outbound" });
  expect(systemPrompts[0]).toContain("PERSONA_PROMPT");
});
