import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud inbound shared locations, driven through the real POST with the
 * payload shape Meta documents for `type: "location"`.
 *
 * Firestore is a recording fake: the assertions are what lands on the row,
 * what the inbox and timeline are told, and whether the AI is asked to reply.
 */

const m = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  aiCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS", delete: () => "DELETE" },
}));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/whatsapp/resolve-sender", () => ({
  hasWhatsappSenderOnRail: () => true,
}));
// The AI is on and enabled, so a location that reached it WOULD be answered.
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
    m.upserts.push(a);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async (_db: unknown, a: Record<string, unknown>) => {
    m.activities.push(a);
  },
}));

function contactRef(id: string) {
  return {
    id,
    collection: (name: string) => ({
      doc: (docId: string) => {
        const path = `contacts/${id}/${name}/${docId}`;
        return {
          get: async () => ({ exists: m.rows.has(path), data: () => m.rows.get(path) }),
          set: async (data: Record<string, unknown>) => {
            m.rows.set(path, { ...(m.rows.get(path) ?? {}), ...data });
          },
        };
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
          docs: [
            {
              id: "c_1",
              ref: contactRef("c_1"),
              data: () => ({ name: "Thandi", phone: "+27821234567" }),
            },
          ],
        }),
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const ROW = "contacts/c_1/whatsappMessages/wamid.LOC";

function post(location: unknown) {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Thandi" } }],
              messages: [
                { from: "27821234567", id: "wamid.LOC", timestamp: "1726000000", type: "location", location },
              ],
            },
          },
        ],
      },
    ],
  };
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify(payload),
    }),
  );
}

beforeEach(() => {
  m.rows.clear();
  m.upserts.length = 0;
  m.activities.length = 0;
  m.aiCalls.length = 0;
});

describe("cloud inbound shared location", () => {
  const pin = {
    latitude: -26.3812,
    longitude: 27.8123,
    name: "Thandi's house",
    address: "12 Main Rd, Lawley",
    url: "https://maps.example/p",
  };

  it("stores the location on the row with a readable body, preview and timeline", async () => {
    const res = await post(pin);
    expect(res.status).toBe(200);
    expect(m.rows.get(ROW)).toMatchObject({
      direction: "inbound",
      body: "📍 Thandi's house",
      location: pin,
    });
    expect(m.upserts[0]).toMatchObject({ body: "📍 Thandi's house" });
    expect(m.activities[0]).toMatchObject({ preview: "📍 Thandi's house" });
  });

  it("labels a nameless location generically, never empty", async () => {
    await post({ latitude: -26.3812, longitude: 27.8123 });
    expect(m.rows.get(ROW)).toMatchObject({
      body: "📍 Location",
      location: { latitude: -26.3812, longitude: 27.8123 },
    });
    expect(m.upserts[0]).toMatchObject({ body: "📍 Location" });
  });

  it("does not ask the AI to reply to a shared location", async () => {
    await post(pin);
    expect(m.rows.get(ROW)?.body).toBe("📍 Thandi's house");
    expect(m.aiCalls).toHaveLength(0);
  });

  it.each([
    ["latitude above 90", { latitude: 90.0001, longitude: 27.8 }],
    ["longitude below -180", { latitude: -26.3, longitude: -180.5 }],
    ["string coordinates", { latitude: "-26.3812", longitude: "27.8123" }],
    ["missing latitude", { longitude: 27.8123 }],
    ["null block", null],
  ])("drops an unusable location (%s) without throwing or logging it", async (_, location) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(location);
    expect(res.status).toBe(200);
    const row = m.rows.get(ROW);
    expect(row).toBeDefined();
    expect("location" in (row ?? {})).toBe(false);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("unusable coordinates");
    expect(logged).not.toMatch(/90\.0001|180\.5|26\.3|27\.8/);
    warn.mockRestore();
  });
});
