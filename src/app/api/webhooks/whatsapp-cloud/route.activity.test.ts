import { beforeEach, expect, it, vi } from "vitest";

/**
 * A customer WhatsApp message through the real Cloud webhook POST must leave
 * a `whatsapp_received` row on the matched contact's timeline, keyed by the
 * wamid and stamped with the tenant.
 */

const m = vi.hoisted(() => ({
  activityAdds: [] as Array<{ path: string; data: Record<string, unknown> }>,
  messageSets: [] as string[],
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/whatsapp/resolve-sender", () => ({
  hasWhatsappSenderOnRail: () => true,
}));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => {
    throw new Error("not expected");
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
}));

function contactRef(id: string) {
  return {
    id,
    collection: (name: string) => ({
      doc: (docId: string) => ({
        set: async (data: Record<string, unknown>) => {
          if (name === "activities") {
            m.activityAdds.push({ path: `contacts/${id}/${name}/${docId}`, data });
            return;
          }
          m.messageSets.push(`${name}/${docId}`);
        },
      }),
    }),
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === "subAccounts") {
        return {
          where: () => ({
            limit: () => ({
              get: async () => ({
                empty: false,
                docs: [
                  {
                    id: "sa_1",
                    data: () => ({ agencyId: "ag_1", whatsappEnabledByAgency: true }),
                  },
                ],
              }),
            }),
          }),
        };
      }
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: false,
          docs: [{ id: "c_1", ref: contactRef("c_1"), data: () => ({ name: "Thandi", phone: "+27821234567" }) }],
        }),
        doc: (id: string) => contactRef(id),
      };
      return q;
    },
    batch: () => ({ update: () => {}, set: () => {}, commit: async () => {} }),
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  m.activityAdds.length = 0;
  m.messageSets.length = 0;
});

it("writes a whatsapp_received activity keyed by the wamid with tenant keys", async () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Thandi" } }],
              messages: [
                {
                  from: "27821234567",
                  id: "wamid.ABC",
                  type: "text",
                  text: { body: "Can you move my install to Friday?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const res = await POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify(payload),
    }),
  );
  expect(res.status).toBe(200);
  expect(m.messageSets).toEqual(["whatsappMessages/wamid.ABC"]);

  const activity = m.activityAdds.find(
    (a) => a.path === "contacts/c_1/activities/inbound_whatsapp_wamid.ABC",
  );
  expect(activity?.data).toMatchObject({
    type: "whatsapp_received",
    createdBy: "whatsapp_inbound",
    agencyId: "ag_1",
    subAccountId: "sa_1",
    content: "WhatsApp received: Can you move my install to Friday?",
    meta: { channel: "whatsapp", messageId: "wamid.ABC" },
  });
});
