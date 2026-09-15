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
  /** Activity rows the opt-out batch committed, as `${contactId}/${docId}`. */
  optOutActivities: [] as string[],
  /** Contacts the phone-number query resolves to. One number can match several. */
  contactIds: ["c_1"],
  /** Set to make the opt-out batch commit fail, as contention would. */
  commitThrows: false,
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
      // `docId` is undefined when the route calls `.doc()` with no argument —
      // which is exactly the non-idempotent shape the opt-out test forbids.
      doc: (docId?: string) => ({
        id: docId,
        contactId: id,
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
          docs: m.contactIds.map((id) => ({
            id,
            ref: contactRef(id),
            data: () => ({ name: "Thandi", phone: "+27821234567" }),
          })),
        }),
        doc: (id: string) => contactRef(id),
      };
      return q;
    },
    // A batch is atomic: nothing it buffers is visible until commit succeeds.
    // Recording at call time would report writes that never landed — and the
    // whole point of the 503 test is what survives a commit that throws.
    batch: () => {
      const pendingUpdates: Array<Record<string, unknown>> = [];
      const pendingSets: string[] = [];
      return {
        update: (_ref: unknown, data: Record<string, unknown>) => {
          pendingUpdates.push(data);
        },
        set: (ref: { id?: string; contactId?: string }) => {
          // A missing id is a GENERATED id, and a generated id is what makes
          // this write non-idempotent. Recorded as such rather than collapsed.
          pendingSets.push(`${ref.contactId}/${ref.id ?? "GENERATED"}`);
        },
        commit: async () => {
          if (m.commitThrows) throw new Error("contention");
          m.optOutCommits += 1;
          m.contactUpdates.push(...pendingUpdates);
          m.optOutActivities.push(...pendingSets);
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
  m.optOutActivities.length = 0;
  m.contactIds = ["c_1"];
  m.commitThrows = false;
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

  it("asks EVERY matched contact, not just the first", async () => {
    // One phone number can match several contacts, and the row is written to
    // all of them. Consulting only `contactDocs[0]` makes the answer depend on
    // Firestore's `__name__` ordering: a contact created between two
    // deliveries with a smaller id becomes the new `[0]`, has no row, and the
    // message reads as fresh — re-running the AI auto-reply and sending the
    // customer a second real message.
    //
    // So: two contacts, and only the SECOND holds the row. `some` says
    // redelivery; `seen[0].exists` and `seen.every(...)` both say fresh.
    m.contactIds = ["c_1", "c_2"];
    m.stored.add("c_2/wamid.DUP");

    expect((await post(payload())).status).toBe(200);

    expect(m.conversationUpserts).toHaveLength(0);
    expect(m.inboundActivities).toHaveLength(0);
    expect(m.aiCalls).toHaveLength(0);
    // The row write still fans out to BOTH, so the contact that missed it
    // earlier is filled in regardless.
    expect(m.messageSets).toEqual(["c_1/wamid.DUP", "c_2/wamid.DUP"]);
  });

  it("writes the opt-out activity row once across a redelivered STOP", async () => {
    // Keyed on the message the opt-out came from. A generated id would append
    // a second row on every retry, and re-running the branch on every delivery
    // is precisely what the guard above commits this route to.
    await post(payload({ body: "STOP" }));
    await post(payload({ body: "STOP" }));

    expect(m.optOutActivities).toEqual([
      "c_1/whatsapp-optout-wamid.DUP",
      "c_1/whatsapp-optout-wamid.DUP",
    ]);
    expect(new Set(m.optOutActivities).size).toBe(1);
  });

  it("answers a stated 503 when the opt-out commit fails, never a 500", async () => {
    // The one deliberate non-2xx. Meta disables a subscription that keeps
    // failing, which would stop ALL inbound WhatsApp for this WABA — so every
    // other path acks 200. Here we want the retry, and it must be named
    // rather than surfacing as an unhandled throw.
    m.commitThrows = true;

    const res = await post(payload({ body: "STOP" }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "optout_not_recorded" });
    expect(m.contactUpdates).toHaveLength(0);
  });

  it("treats a genuinely new wamid as a first delivery", async () => {
    await post(payload({ id: "wamid.A" }));
    await post(payload({ id: "wamid.B" }));

    expect(m.conversationUpserts).toHaveLength(2);
    expect(m.aiCalls).toHaveLength(2);
  });
});
