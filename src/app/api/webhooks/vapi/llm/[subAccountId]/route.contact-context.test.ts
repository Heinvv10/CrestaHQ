import { beforeEach, expect, it, vi } from "vitest";

/**
 * Voice's contact lookup is keyed on caller ID (`call.customer.number`),
 * which is trivially spoofable on inbound calls and, on outbound calls, no
 * guarantee the dialed handset was answered by the account holder. Unlike
 * SMS / web-chat (whose contact match is anchored to a channel identity we
 * actually own), the voice agent must never be handed the matched contact's
 * company, deals, or any other account detail — only a first name, and only
 * for a greeting. This test drives the real POST handler end to end and
 * inspects exactly what lands in the system prompt handed to the LLM.
 */

const promptArgs: Array<{ contactContextBlock: string | null }> = [];

vi.mock("@/lib/comms/voice/webhook-auth", () => ({
  vapiWebhookAuthorized: () => true,
}));

vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({
    effective: {
      enabled: true,
      systemPrompt: "Be a helpful receptionist.",
      businessName: "Acme Fibre",
      modelOverride: null,
    },
    channel: { voice: {} },
  }),
  incrementChannelTokens: async () => {},
}));

vi.mock("@/lib/comms/ai/prompt", () => ({
  buildSystemPrompt: (args: { contactContextBlock: string | null }) => {
    promptArgs.push(args);
    return "SYSTEM_PROMPT";
  },
}));

vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async () => ({ text: "Hi there!", totalTokens: 5, model: "haiku" }),
}));

vi.mock("@/lib/server/voice-booking-service", () => ({
  bookVoiceSlot: async () => ({ ok: false, code: "error" }),
  formatSlotForSpeech: () => "",
  getVoiceBookingContext: async () => null,
  listVoiceSlots: async () => [],
}));

vi.mock("@/lib/booking/page-slots", () => ({
  hostSelectionEnabled: () => false,
}));

const CONTACT_DOC = {
  id: "c_1",
  name: "Jane Doe",
  phone: "+27821112222",
  company: "Acme Widgets Ltd",
  subAccountId: "sa_1",
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== "contacts") throw new Error(`unexpected collection ${name}`);
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: false,
          docs: [{ id: CONTACT_DOC.id, data: () => CONTACT_DOC }],
        }),
      };
      return q;
    },
    doc: (path: string) => {
      // The contact an outbound call was placed to (its metadata.contactId).
      if (path === "contacts/c_called") {
        return { get: async () => ({ id: "c_called", exists: true, data: () => ({ name: "Ann Called", phone: "+27821112222", subAccountId: "sa_1" }) }) };
      }
      if (path === "contacts/c_foreign") {
        return { get: async () => ({ id: "c_foreign", exists: true, data: () => ({ name: "Other Tenant", subAccountId: "sa_2" }) }) };
      }
      if (path !== "subAccounts/sa_1") throw new Error(`unexpected doc ${path}`);
      return {
        get: async () => ({
          exists: true,
          data: () => ({
            agencyId: "ag_1",
            name: "Acme Fibre",
            inboundVoiceEnabledByAgency: true,
            outboundVoiceEnabledByAgency: true,
          }),
        }),
      };
    },
  }),
}));

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/webhooks/vapi/llm/sa_1?s=secret", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  promptArgs.length = 0;
});

it("hands the voice agent only the caller's first name — never company or account data", async () => {
  await POST(makeRequest({ stream: false, messages: [], call: { customer: { number: "+27821112222" } } }), {
    params: Promise.resolve({ subAccountId: "sa_1" }),
  });

  expect(promptArgs).toHaveLength(1);
  const block = promptArgs[0].contactContextBlock;
  expect(block).not.toBeNull();
  expect(block).toContain("Jane");
  expect(block).not.toContain("Doe");
  expect(block).not.toContain("Acme Widgets Ltd");
  expect((block ?? "").toLowerCase()).toContain("verified");
});

it("an outbound call greets the contact it was placed to, not another contact sharing the number", async () => {
  await POST(
    makeRequest({ stream: false, messages: [], call: { customer: { number: "+27821112222" }, metadata: { direction: "outbound", contactId: "c_called" } } }),
    { params: Promise.resolve({ subAccountId: "sa_1" }) },
  );
  const block = promptArgs[0].contactContextBlock ?? "";
  expect(block).toContain("Ann");
  expect(block).not.toContain("Jane");
});

it("an outbound call's contactId from another sub-account greets nobody", async () => {
  await POST(
    makeRequest({ stream: false, messages: [], call: { customer: { number: "+27821112222" }, metadata: { direction: "outbound", contactId: "c_foreign" } } }),
    { params: Promise.resolve({ subAccountId: "sa_1" }) },
  );
  expect(promptArgs[0].contactContextBlock).toBeNull();
});
