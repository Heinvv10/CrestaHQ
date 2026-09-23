import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which inbound cloud traffic this webhook accepts.
 *
 * Routing asks whether the sub-account HAS a cloud sender, not whether cloud
 * is its default. A workspace whose campaigns go out on another rail still
 * owns the Meta number a customer replied to, and dropping that reply loses a
 * real customer message. What must still be refused is a stale subscription
 * for a workspace that has no cloud sender at all.
 *
 * Driven through the real POST with a delivery-status payload: it exercises
 * routing and returns before any thread write, so the assertion is the routing
 * decision and nothing else.
 */

const PN = "pn_1";

let subDoc: Record<string, unknown> | null;

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({
            empty: subDoc === null,
            docs:
              subDoc === null
                ? []
                : [{ id: "sa_1", data: () => subDoc }],
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
}));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => ({ id: "c1" }),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
}));

import { POST } from "./route";

const STATUS_PAYLOAD = {
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: PN },
            statuses: [{ id: "wamid.1", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

async function post() {
  const res = await POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      body: JSON.stringify(STATUS_PAYLOAD),
    }),
  );
  return (await res.json()) as { ignored?: string; statuses?: number };
}

function setSub(over: Record<string, unknown>) {
  subDoc = {
    agencyId: "ag_1",
    whatsappEnabledByAgency: true,
    whatsappCloudMeta: { phoneNumberId: PN, displayPhoneNumber: "+27110000000" },
    ...over,
  };
}

beforeEach(() => {
  subDoc = null;
});

describe("cloud inbound is routed by sender membership", () => {
  it("accepts traffic for a workspace whose DEFAULT sender is another rail", async () => {
    setSub({
      whatsappProvider: "bridge",
      whatsappSenders: [
        {
          id: "s_bridge",
          label: "Own number",
          provider: "bridge",
          phoneNumber: "+27784356159",
          isDefault: true,
        },
        {
          id: "s_cloud",
          label: "Support",
          provider: "cloud",
          phoneNumber: "+27110000000",
        },
      ],
    });
    expect(await post()).toEqual({ ok: true, statuses: 1, recorded: 0 });
  });

  it("drops traffic for a workspace with no cloud sender", async () => {
    setSub({
      whatsappProvider: "bridge",
      whatsappSenders: [
        {
          id: "s_bridge",
          label: "Own number",
          provider: "bridge",
          phoneNumber: "+27784356159",
          isDefault: true,
        },
      ],
    });
    expect(await post()).toEqual({ ok: true, ignored: "unrouted" });
  });

  it("accepts a legacy workspace on the cloud rail, as before", async () => {
    setSub({ whatsappProvider: "cloud" });
    expect(await post()).toEqual({ ok: true, statuses: 1, recorded: 0 });
  });

  it("drops a legacy workspace that switched away from cloud, as before", async () => {
    setSub({ whatsappProvider: "twilio" });
    expect(await post()).toEqual({ ok: true, ignored: "unrouted" });
  });

  it("drops when the agency's WhatsApp gate is off", async () => {
    setSub({ whatsappProvider: "cloud", whatsappEnabledByAgency: false });
    expect(await post()).toEqual({ ok: true, ignored: "unrouted" });
  });
});
