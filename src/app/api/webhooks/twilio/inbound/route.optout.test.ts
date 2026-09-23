import { beforeEach, expect, it, vi } from "vitest";

/**
 * SMS opt-out uses the same whole-message keyword rule as WhatsApp, not a
 * first-word list of its own. Driven through the real POST with a signed
 * dedicated-mode message; the assertion is whether `smsOptedOut` is flipped.
 */

const m = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  upsertOptOut: [] as unknown[],
}));

vi.mock("twilio", () => ({ default: { validateRequest: () => true } }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));
vi.mock("@/lib/comms/ai/gates", () => ({ aiChannelGateOn: () => false }));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: { optOut?: boolean }) => {
    m.upsertOptOut.push(a.optOut);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async () => {},
}));

const contactRef = {
  id: "c_1",
  collection: () => ({ doc: () => ({ set: async () => {} }) }),
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === "subAccounts") {
        const sa = {
          where: () => sa,
          limit: () => sa,
          get: async () => ({
            empty: false,
            docs: [
              {
                id: "sa_1",
                data: () => ({
                  agencyId: "ag_1",
                  twilioConfig: { authToken: "tok", enabled: true },
                }),
              },
            ],
          }),
        };
        return sa;
      }
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: false,
          docs: [{ id: "c_1", ref: contactRef, data: () => ({ phone: "+27821234567" }) }],
        }),
        doc: () => ({ id: "generated" }),
      };
      return q;
    },
    doc: () => ({ get: async () => ({ data: () => ({}) }) }),
    batch: () => ({
      update: (_ref: unknown, data: Record<string, unknown>) => {
        m.updates.push(data);
      },
      set: () => {},
      commit: async () => {},
    }),
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  m.updates.length = 0;
  m.upsertOptOut.length = 0;
});

function post(text: string) {
  return POST(
    new Request("http://app.local/api/webhooks/twilio/inbound", {
      method: "POST",
      headers: { "x-twilio-signature": "sig", host: "app.local" },
      body: new URLSearchParams({
        From: "+27821234567",
        To: "+27100000001",
        Body: text,
        MessageSid: "SM1",
      }).toString(),
    }),
  );
}

it.each(["Stop!", "STOP.", "stop all", "Opt out", "END", "Quit", "cancel"])("opts out on %j", async (text) => {
  await post(text);
  expect(m.updates).toEqual([expect.objectContaining({ smsOptedOut: true })]);
  // Indexed without message.received automation, which would race the flip.
  expect(m.upsertOptOut).toEqual([true]);
});

it.each(["Start", "unstop!"])("opts back in on %j", async (text) => {
  await post(text);
  expect(m.updates).toEqual([expect.objectContaining({ smsOptedOut: false })]);
});

it.each(["Cancel my appointment tomorrow", "End of the month", "Yes I'll be there", "YES"])(
  "has no opt effect on %j",
  async (text) => {
    await post(text);
    expect(m.updates).toEqual([]);
    expect(m.upsertOptOut).toEqual([false]);
  },
);
