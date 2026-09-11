import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A Messenger or Instagram DM through the REAL Meta webhook POST must leave a
 * `<channel>_received` row on the reconciled contact's timeline, keyed by the
 * Meta mid so a redelivery cannot duplicate it.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
  getMetaUserName: async () => "Naledi",
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/comms/ai/agent", () => ({ resolveAgent: async () => null }));
vi.mock("@/lib/comms/ai/respond", () => ({ maybeRespondWithAi: async () => {} }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback: async () => ({ messageId: "q" }),
  qstashIsConfigured: () => false,
}));

const { POST } = await import("./route");

function post(object: "page" | "instagram", entryId: string, mid: string, text: string) {
  return POST(
    new Request("https://app.test/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify({
        object,
        entry: [
          {
            id: entryId,
            messaging: [
              { sender: { id: "psid_1" }, message: { mid, text } },
            ],
          },
        ],
      }),
    }),
  );
}

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner" });
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    metaInboxEnabledByAgency: true,
    metaConfig: {
      pageId: "page_1",
      instagramBusinessAccountId: "ig_1",
      pageAccessToken: "tok",
    },
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1",
    agencyId: "ag1",
    name: "Naledi",
    metaUserId: "psid_1",
    phone: "",
  });
});

describe("Meta webhook → timeline", () => {
  it("Messenger: writes messenger_received keyed by the mid", async () => {
    expect((await post("page", "page_1", "m_1", "Hi, do you install in Sandton?")).status).toBe(200);
    expect(mem.read("contacts/c1/metaMessages/m_1")).toMatchObject({ direction: "inbound" });
    expect(mem.read("contacts/c1/activities/inbound_messenger_m_1")).toMatchObject({
      type: "messenger_received",
      createdBy: "messenger_inbound",
      agencyId: "ag1",
      subAccountId: "sa1",
      content: "Messenger received: Hi, do you install in Sandton?",
      meta: { channel: "messenger", messageId: "m_1" },
    });
  });

  it("Instagram: writes instagram_received keyed by the mid", async () => {
    expect((await post("instagram", "ig_1", "m_2", "Saw your reel — pricing?")).status).toBe(200);
    expect(mem.read("contacts/c1/activities/inbound_instagram_m_2")).toMatchObject({
      type: "instagram_received",
      createdBy: "instagram_inbound",
      content: "Instagram received: Saw your reel — pricing?",
      meta: { channel: "instagram", messageId: "m_2" },
    });
  });

  it("a Meta redelivery of the same mid leaves one timeline row", async () => {
    await post("page", "page_1", "m_3", "hello");
    await post("page", "page_1", "m_3", "hello");
    expect(mem.list("contacts/c1/activities").map((a) => a.id)).toEqual([
      "inbound_messenger_m_3",
    ]);
  });
});
