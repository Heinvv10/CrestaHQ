import { beforeEach, expect, it, vi } from "vitest";

/**
 * A never-seen number whose first message is STOP must still be recorded —
 * contact, message row, inbox entry — and the opt-out applied to that new
 * contact. Dropping it silently loses the opt-out: a later bulk send to the
 * number finds no opted-out contact and messages them anyway.
 *
 * Driven through the real POST against a recording Firestore fake.
 */

const m = vi.hoisted(() => ({
  contactIds: [] as string[],
  created: 0,
  createdOptedOut: [] as unknown[],
  upsertOptOut: [] as unknown[],
  messageRows: [] as Array<{ contactId: string; body: unknown }>,
  upserts: 0,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("twilio", () => ({ default: { validateRequest: () => true } }));
vi.mock("@/lib/comms/twilio", () => ({
  stripWhatsappPrefix: (s: string) => s.replace(/^whatsapp:/, ""),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: { optOut?: boolean }) => {
    m.upserts += 1;
    m.upsertOptOut.push(a.optOut);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async () => {},
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async (a: { optedOutOnWhatsapp?: boolean }) => {
    m.created += 1;
    m.createdOptedOut.push(a.optedOutOnWhatsapp);
    m.contactIds = ["c_new"];
    return { id: "c_new" };
  },
}));

function snap(id: string) {
  return {
    id,
    data: () => ({ phone: "+27821234567" }),
    ref: {
      id,
      collection: () => ({
        doc: () => ({
          set: async (data: Record<string, unknown>) => {
            m.messageRows.push({ contactId: id, body: data.body });
          },
        }),
      }),
    },
  };
}

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
                  whatsappEnabledByAgency: true,
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
          empty: m.contactIds.length === 0,
          docs: m.contactIds.map(snap),
        }),
        doc: (id?: string) => ({ id: id ?? "generated", get: async () => snap(id!) }),
      };
      return q;
    },
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
  m.contactIds = [];
  m.created = 0;
  m.createdOptedOut.length = 0;
  m.upsertOptOut.length = 0;
  m.messageRows.length = 0;
  m.upserts = 0;
  m.updates.length = 0;
});

function post(text: string) {
  return POST(
    new Request("http://app.local/api/webhooks/twilio/whatsapp/inbound", {
      method: "POST",
      headers: { "x-twilio-signature": "sig", host: "app.local" },
      body: new URLSearchParams({
        From: "whatsapp:+27821234567",
        To: "whatsapp:+27100000001",
        Body: text,
        MessageSid: "SM1",
      }).toString(),
    }),
  );
}

it("records a never-seen number's STOP and opts the new contact out", async () => {
  expect((await post("STOP")).status).toBe(200);

  expect(m.created).toBe(1);
  expect(m.messageRows).toEqual([{ contactId: "c_new", body: "STOP" }]);
  expect(m.upserts).toBe(1);
  expect(m.updates).toEqual([expect.objectContaining({ whatsappOptedOut: true })]);
  // Created opted out and unannounced, and indexed without message.received
  // automation — nothing can message someone whose only message was STOP.
  expect(m.createdOptedOut).toEqual([true]);
  expect(m.upsertOptOut).toEqual([true]);
});

it("an existing contact's STOP is indexed without message.received automation", async () => {
  m.contactIds = ["c_1"];
  await post("stop");
  expect(m.created).toBe(0);
  expect(m.upsertOptOut).toEqual([true]);
  expect(m.updates).toEqual([expect.objectContaining({ whatsappOptedOut: true })]);
});

it("still creates an ordinary new lead with no opt effect", async () => {
  await post("Hi, do you install in Soweto?");
  expect(m.created).toBe(1);
  expect(m.messageRows).toHaveLength(1);
  expect(m.updates).toEqual([]);
  expect(m.createdOptedOut).toEqual([false]);
  expect(m.upsertOptOut).toEqual([false]);
});
