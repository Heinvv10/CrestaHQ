import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Meta redelivers a webhook it considers failed, and the same wamid arrives
 * twice. The message row converges on its own doc id; nothing after it does.
 *
 * Driven through the real POST, twice, against a fake Firestore that actually
 * REMEMBERS the first delivery's row — so the second POST discovers the
 * redelivery the same way production does, rather than being told about it by
 * a flag the test set.
 */

const m = vi.hoisted(() => ({
  /** `${contactId}/${docId}` for every whatsappMessages row written. */
  messageSets: [] as string[],
  /** Rows the fake holds, so a second delivery finds the first one's. */
  stored: new Set<string>(),
  conversationUpserts: [] as Array<Record<string, unknown>>,
  inboundActivities: [] as string[],
  aiCalls: [] as Array<Record<string, unknown>>,
  contactUpdates: [] as Array<Record<string, unknown>>,
  optOutCommits: 0,
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
  maybeRespondWithAi: async (a: Record<string, unknown>) => {
    m.aiCalls.push(a);
  },
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => {
    throw new Error("not expected — the fixture contact already exists");
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: Record<string, unknown>) => {
    m.conversationUpserts.push(a);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async (
    _db: unknown,
    a: { contactId: string; messageId: string },
  ) => {
    m.inboundActivities.push(`${a.contactId}/${a.messageId}`);
  },
}));

function contactRef(id: string) {
  return {
    id,
    collection: (name: string) => ({
      doc: (docId: string) => ({
        id: docId,
        get: async () => ({ exists: m.stored.has(`${id}/${docId}`) }),
        set: async () => {
          if (name === "whatsappMessages") {
            m.messageSets.push(`${id}/${docId}`);
            m.stored.add(`${id}/${docId}`);
          }
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
                    data: () => ({
                      agencyId: "ag_1",
                      whatsappEnabledByAgency: true,
                      whatsappProvider: "cloud",
                    }),
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
          docs: [
            {
              id: "c_1",
              ref: contactRef("c_1"),
              data: () => ({ name: "Thandi", phone: "+27821234567" }),
            },
          ],
        }),
        doc: (id: string) => contactRef(id),
      };
      return q;
    },
    // A batch is atomic: buffer, and only record on a successful commit.
    batch: () => {
      const pending: Array<Record<string, unknown>> = [];
      return {
        update: (_ref: unknown, data: Record<string, unknown>) => {
          pending.push(data);
        },
        set: () => {},
        commit: async () => {
          m.optOutCommits += 1;
          m.contactUpdates.push(...pending);
        },
      };
    },
  }),
}));

import { POST } from "./route";

function payload(over: { id?: string; body?: string } = {}) {
  return {
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
                  id: over.id ?? "wamid.DUP",
                  type: "text",
                  text: { body: over.body ?? "Can you move my install?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function post(body: unknown) {
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  m.messageSets.length = 0;
  m.stored.clear();
  m.conversationUpserts.length = 0;
  m.inboundActivities.length = 0;
  m.aiCalls.length = 0;
  m.contactUpdates.length = 0;
  m.optOutCommits = 0;
});

describe("cloud inbound suppresses only the non-idempotent effects on a redelivery", () => {
  it("re-writes the row but bumps the thread and auto-replies exactly once", async () => {
    expect((await post(payload())).status).toBe(200);
    expect((await post(payload())).status).toBe(200);

    // Idempotent on its own doc id — re-run every time, so a first delivery
    // that died between the row write and everything else still converges.
    expect(m.messageSets).toEqual(["c_1/wamid.DUP", "c_1/wamid.DUP"]);

    // Not idempotent: each of these bumps the inbox or spends a real send.
    expect(m.conversationUpserts).toHaveLength(1);
    expect(m.inboundActivities).toEqual(["c_1/wamid.DUP"]);
    expect(m.aiCalls).toHaveLength(1);
  });

  it("honours a redelivered STOP instead of swallowing it as a duplicate", async () => {
    // Honouring an opt-out is a POPIA obligation, not a best effort. If a
    // first delivery wrote the row and then failed before the flip, the retry
    // is the only thing that records it.
    expect((await post(payload({ body: "STOP" }))).status).toBe(200);
    expect((await post(payload({ body: "STOP" }))).status).toBe(200);

    expect(m.optOutCommits).toBe(2);
    expect(m.contactUpdates).toHaveLength(2);
    expect(m.contactUpdates.every((u) => u.whatsappOptedOut === true)).toBe(true);
    // And still no second AI reply on the STOP path.
    expect(m.aiCalls).toHaveLength(0);
  });

  it("treats a genuinely new wamid as a first delivery", async () => {
    await post(payload({ id: "wamid.A" }));
    await post(payload({ id: "wamid.B" }));

    expect(m.conversationUpserts).toHaveLength(2);
    expect(m.aiCalls).toHaveLength(2);
  });
});
