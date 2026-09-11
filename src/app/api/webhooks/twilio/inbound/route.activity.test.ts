import { beforeEach, expect, it, vi } from "vitest";

/**
 * The inbound SMS webhook, driven through the real POST with a signed
 * dedicated-mode message, must leave an `sms_received` row on the matched
 * contact's timeline carrying the tenant keys — the Activity tab is the
 * only place an operator sees the customer's half of the thread.
 */

const m = vi.hoisted(() => ({
  activityAdds: [] as Array<{ path: string; data: Record<string, unknown> }>,
  messageSets: 0,
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
  upsertConversationForMessage: async () => {},
}));

function contactRef(id: string) {
  return {
    id,
    collection: (name: string) => ({
      doc: () => ({
        set: async () => {
          m.messageSets += 1;
        },
      }),
      add: async (data: Record<string, unknown>) => {
        m.activityAdds.push({ path: `contacts/${id}/${name}`, data });
        return { id: "act1" };
      },
    }),
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === "subAccounts") {
        return {
          where: () => ({
            where: () => ({
              limit: () => ({
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
              }),
            }),
          }),
        };
      }
      // contacts
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: false,
          docs: [{ id: "c_1", ref: contactRef("c_1"), data: () => ({ name: "Thandi", phone: "+27821234567" }) }],
        }),
        doc: (id?: string) => (id ? contactRef(id) : { id: "generated" }),
      };
      return q;
    },
    doc: () => ({ get: async () => ({ data: () => ({}) }) }),
    batch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  m.activityAdds.length = 0;
  m.messageSets = 0;
});

it("writes an sms_received activity with tenant keys for the matched contact", async () => {
  const body = new URLSearchParams({
    From: "+27821234567",
    To: "+27100000001",
    Body: "Hi, is the installer still coming today?",
    MessageSid: "SM123",
  }).toString();
  const res = await POST(
    new Request("http://app.local/api/webhooks/twilio/inbound", {
      method: "POST",
      headers: { "x-twilio-signature": "sig", host: "app.local" },
      body,
    }),
  );
  expect(res.status).toBe(200);
  expect(m.messageSets).toBe(1);

  const activity = m.activityAdds.find((a) => a.path === "contacts/c_1/activities");
  expect(activity?.data).toMatchObject({
    type: "sms_received",
    createdBy: "system",
    agencyId: "ag_1",
    subAccountId: "sa_1",
    content: "SMS received: Hi, is the installer still coming today?",
    meta: { channel: "sms", messageId: "SM123" },
  });
});
