import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two ways a customer's message used to vanish on the Cloud rail:
 *
 *   - a delivery carrying several messages, or a receipt ahead of a message,
 *     was read as its first block only, so everything after it was dropped;
 *   - a never-seen number whose first message was STOP was dropped outright,
 *     so the opt-out was never recorded anywhere.
 *
 * Driven through the real POST against a Firestore fake that resolves contacts
 * by the phone number actually queried.
 */

const m = vi.hoisted(() => ({
  /** phone → contact id, for contacts that already exist. */
  contactsByPhone: new Map<string, string>(),
  created: [] as string[],
  messageRows: [] as Array<{ contactId: string; docId: string; body: unknown }>,
  upserts: [] as string[],
  optOuts: [] as Array<{ contactId: string; optedOut: unknown }>,
  aiCalls: [] as string[],
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
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => true }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({ effective: { enabled: true } }),
}));
vi.mock("@/lib/comms/ai/respond", () => ({
  maybeRespondWithAi: async (a: { incomingMessage: string }) => {
    m.aiCalls.push(a.incomingMessage);
  },
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async (a: { phone: string }) => {
    const id = `c_new_${a.phone}`;
    m.created.push(a.phone);
    m.contactsByPhone.set(a.phone, id);
    return { id };
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: { contactId: string }) => {
    m.upserts.push(a.contactId);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async () => {},
}));

function contactSnap(id: string) {
  return {
    id,
    data: () => ({ name: "", phone: "" }),
    ref: {
      id,
      collection: (name: string) => ({
        doc: (docId?: string) => ({
          id: docId,
          contactId: id,
          get: async () => ({ exists: false }),
          set: async (data: Record<string, unknown>) => {
            if (name === "whatsappMessages") {
              m.messageRows.push({ contactId: id, docId: docId ?? "", body: data.body });
            }
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
                  whatsappProvider: "cloud",
                }),
              },
            ],
          }),
        };
        return sa;
      }
      let phone = "";
      const q = {
        where: (field: string, _op: string, value: string) => {
          if (field === "phone") phone = value;
          return q;
        },
        limit: () => q,
        get: async () => {
          const id = m.contactsByPhone.get(phone);
          return { empty: !id, docs: id ? [contactSnap(id)] : [] };
        },
        doc: (id: string) => ({ get: async () => contactSnap(id) }),
      };
      return q;
    },
    batch: () => {
      const pending: Array<{ contactId: string; optedOut: unknown }> = [];
      return {
        update: (ref: { id: string }, data: Record<string, unknown>) => {
          pending.push({ contactId: ref.id, optedOut: data.whatsappOptedOut });
        },
        set: () => {},
        commit: async () => {
          m.optOuts.push(...pending);
        },
      };
    },
  }),
}));

import { POST } from "./route";

const msg = (id: string, from: string, body: string) => ({
  from,
  id,
  type: "text",
  text: { body },
});

function change(value: Record<string, unknown>) {
  return { value: { metadata: { phone_number_id: "pn_1" }, ...value } };
}

function post(changes: unknown[]) {
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify({ entry: [{ changes }] }),
    }),
  );
}

beforeEach(() => {
  m.contactsByPhone = new Map([
    ["+27821111111", "c_1"],
    ["+27822222222", "c_2"],
  ]);
  m.created.length = 0;
  m.messageRows.length = 0;
  m.upserts.length = 0;
  m.optOuts.length = 0;
  m.aiCalls.length = 0;
});

describe("cloud inbound handles every message in a delivery", () => {
  it("processes all messages in one change, including a STOP after the first", async () => {
    const res = await post([
      change({
        messages: [
          msg("wamid.1", "27821111111", "Is the tech coming?"),
          msg("wamid.2", "27822222222", "STOP"),
        ],
      }),
    ]);

    expect(res.status).toBe(200);
    expect(m.messageRows.map((r) => [r.contactId, r.docId])).toEqual([
      ["c_1", "wamid.1"],
      ["c_2", "wamid.2"],
    ]);
    expect(m.optOuts).toEqual([{ contactId: "c_2", optedOut: true }]);
    expect(m.aiCalls).toEqual(["Is the tech coming?"]);
  });

  it("does not treat a delivery that starts with a receipt as receipts only", async () => {
    await post([
      change({ statuses: [{ id: "wamid.OUT", status: "delivered" }] }),
      change({ messages: [msg("wamid.3", "27822222222", "Stop!")] }),
    ]);

    expect(m.messageRows.map((r) => r.docId)).toEqual(["wamid.3"]);
    expect(m.optOuts).toEqual([{ contactId: "c_2", optedOut: true }]);
  });

  it("still acks a receipt-only delivery without writing anything", async () => {
    const res = await post([change({ statuses: [{ id: "wamid.OUT", status: "read" }] })]);
    expect(await res.json()).toEqual({ ok: true, statuses: 1 });
    expect(m.messageRows).toEqual([]);
  });
});

describe("a never-seen number whose first message is STOP", () => {
  it("is recorded as a contact, a row and a thread, and is opted out", async () => {
    const res = await post([change({ messages: [msg("wamid.N", "27823333333", "STOP")] })]);

    expect(m.created).toEqual(["+27823333333"]);
    expect(m.messageRows).toEqual([
      { contactId: "c_new_+27823333333", docId: "wamid.N", body: "STOP" },
    ]);
    expect(m.upserts).toEqual(["c_new_+27823333333"]);
    expect(m.optOuts).toEqual([{ contactId: "c_new_+27823333333", optedOut: true }]);
    expect(m.aiCalls).toEqual([]);
    expect(await res.json()).toMatchObject({ persisted: true, optedOut: true });
  });
});
