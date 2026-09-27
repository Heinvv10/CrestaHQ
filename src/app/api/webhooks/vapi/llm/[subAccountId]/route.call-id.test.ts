import { beforeEach, expect, it, vi } from "vitest";

/**
 * The Vapi call id becomes `subAccounts/{sa}/voiceCalls/{callId}` in the
 * voice booking (and its attempt stamp). A call id that isn't a doc id is
 * dropped (null) rather than passed on to build that path.
 */

const booked: Array<{ callId: string | null }> = [];

vi.mock("@/lib/comms/voice/webhook-auth", () => ({ vapiWebhookAuthorized: () => true }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({
    effective: { enabled: true, systemPrompt: "Receptionist.", businessName: "Acme", modelOverride: null },
    channel: { voice: { bookingPageSlug: "p" } },
  }),
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "SYSTEM_PROMPT" }));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async () => ({ text: '[[book start="2026-09-14T09:00:00Z" name="Ann"]]', totalTokens: 5, model: "haiku" }),
}));
vi.mock("@/lib/server/voice-booking-service", () => ({
  bookVoiceSlot: async (input: { callId: string | null }) => {
    booked.push({ callId: input.callId });
    return { ok: false, code: "error" };
  },
  formatSlotForSpeech: () => "",
  getVoiceBookingContext: async () => ({ bookable: true, page: { timezone: "UTC", durationMinutes: 30 } }),
  listVoiceSlots: async () => [],
}));
vi.mock("@/lib/booking/page-slots", () => ({ hostSelectionEnabled: () => false }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => {
      const q = { where: () => q, limit: () => q, get: async () => ({ empty: true, docs: [] }) };
      return q;
    },
    doc: (path: string) => ({
      get: async () => ({ exists: path === "subAccounts/sa_1", data: () => ({ agencyId: "ag_1", name: "Acme", inboundVoiceEnabledByAgency: true }) }),
      set: async () => {},
    }),
  }),
}));

const { POST } = await import("./route");

const turn = (callId: string) =>
  POST(
    new Request("http://localhost/api/webhooks/vapi/llm/sa_1?s=x", {
      method: "POST",
      body: JSON.stringify({ stream: false, messages: [], call: { id: callId, customer: { number: "+27821112222" } } }),
    }),
    { params: Promise.resolve({ subAccountId: "sa_1" }) },
  );

beforeEach(() => {
  booked.length = 0;
});

it.each(["a/b", "..", "__x__"])("call id %j reaches the booking as null", async (bad) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await turn(bad);
  warn.mockRestore();
  expect(booked.length).toBeGreaterThan(0);
  expect(booked.every((b) => b.callId === null)).toBe(true);
});

it("a real call id is passed through", async () => {
  await turn("call_123");
  expect(booked[0]).toEqual({ callId: "call_123" });
});
