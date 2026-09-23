import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Delivery receipts through the real POST onto an in-memory Firestore. A
 * message Meta refused after accepting the send (131047 outside the window,
 * 131026 undeliverable) used to be acked and dropped, leaving the thread row
 * "sent" forever.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/whatsapp/resolve-sender", () => ({
  hasWhatsappSenderOnRail: () => true,
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => {} }));
vi.mock("@/lib/server/contact-activities", () => ({ writeInboundMessageActivity: async () => {} }));

const { POST } = await import("./route");

const PHONE = "+27821234567";
const ROW = "contacts/c1/whatsappMessages/wamid.1";

function statusPayload(pn: string, statuses: Array<Record<string, unknown>>) {
  return { entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, statuses } }] }] };
}

async function post(payload: unknown) {
  const res = await POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const failed = {
  id: "wamid.1", status: "failed", recipient_id: "27821234567",
  errors: [{ code: 131047, title: "Re-engagement message" }],
};

beforeEach(() => {
  mem.clear();
  for (const [id, pn] of [["sa1", "pn_1"], ["sa2", "pn_2"]]) {
    mem.seed(`subAccounts/${id}`, {
      agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "cloud",
      whatsappCloudMeta: { phoneNumberId: pn },
    });
  }
  mem.seed("contacts/c1", { subAccountId: "sa1", phone: PHONE });
  mem.seed(ROW, { subAccountId: "sa1", direction: "outbound", status: "sent", error: null, body: "hi" });
});

describe("whatsapp-cloud delivery receipts", () => {
  it("records a failed receipt with its code on the outbound row", async () => {
    expect(await post(statusPayload("pn_1", [failed]))).toMatchObject({ recorded: 1 });
    expect(mem.read(ROW)).toMatchObject({ status: "failed", error: "131047: Re-engagement message" });
  });

  it("applies receipts in a batch in order, and a late delivered never undoes read", async () => {
    await post(statusPayload("pn_1", [
      { id: "wamid.1", status: "delivered", recipient_id: "27821234567" },
      { id: "wamid.1", status: "read", recipient_id: "27821234567" },
    ]));
    await post(statusPayload("pn_1", [{ id: "wamid.1", status: "delivered", recipient_id: "27821234567" }]));
    expect(mem.read(ROW)?.status).toBe("read");
  });

  it("a receipt arriving on another sub-account's number never touches this row", async () => {
    expect(await post(statusPayload("pn_2", [failed]))).toMatchObject({ recorded: 0 });
    expect(mem.read(ROW)?.status).toBe("sent");
  });

  it("routes each receipt by its own block's number, not the first block's", async () => {
    const payload = {
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: "pn_2" }, statuses: [{ id: "wamid.x", status: "read", recipient_id: "27800000000" }] } }] },
        { changes: [{ value: { metadata: { phone_number_id: "pn_1" }, statuses: [failed] } }] },
      ],
    };
    await post(payload);
    expect(mem.read(ROW)?.status).toBe("failed");
  });

  it("records a receipt batched beside an inbound message", async () => {
    const payload = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "pn_1" },
        messages: [{ id: "wamid.in", from: "27821234567", type: "text", text: { body: "hello" } }],
        statuses: [failed],
      } }] }],
    };
    await post(payload);
    expect(mem.read("contacts/c1/whatsappMessages/wamid.in")?.direction).toBe("inbound");
    expect(mem.read(ROW)?.status).toBe("failed");
  });

  it("never writes a receipt into the thread as a message", async () => {
    await post(statusPayload("pn_1", [{ ...failed, id: "wamid.other" }]));
    expect(mem.read("contacts/c1/whatsappMessages/wamid.other")).toBeUndefined();
  });
});
