import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The Cloud webhook's mystery-shop hooks (Prospecting PR 5b), through the
 * real POST onto an in-memory Firestore: a reply from the target number
 * settles the open WhatsApp shop at Meta's own timestamp, after the message
 * row is written; a failed receipt for our message marks it undeliverable; a
 * matcher failure is logged and never costs the message.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/meta", () => ({ verifyMetaSignature: () => true, metaWebhookVerifyToken: () => "tok" }));
vi.mock("@/lib/comms/whatsapp/resolve-sender", () => ({ hasWhatsappSenderOnRail: () => true }));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => {} }));
vi.mock("@/lib/server/contact-activities", () => ({ writeInboundMessageActivity: async () => {} }));
const matchSpy = vi.hoisted(() => ({ fail: false, createFails: false }));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => {
    if (matchSpy.createFails) throw new Error("contacts down");
    return { id: "cNew" };
  },
}));
vi.mock("@/lib/prospecting/mystery-shop/inbound", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prospecting/mystery-shop/inbound")>();
  return {
    ...real,
    matchMysteryShopWhatsApp: async (...a: Parameters<typeof real.matchMysteryShopWhatsApp>) => {
      if (matchSpy.fail) throw new Error("matcher down");
      return real.matchMysteryShopWhatsApp(...a);
    },
  };
});

const { POST } = await import("./route");

const PHONE = "+27821234567";
const SENT_S = Math.floor(Date.now() / 1000) - 3600;
const SHOP = "mysteryShops/w1";

const value = (pn: string, extra: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: pn }, ...extra } }] }] });
const message = (from: string, body: string, timestamp: number, id = "wamid.IN1") => ({
  messages: [{ from, id, timestamp: String(timestamp), type: "text", text: { body } }],
});

async function post(payload: unknown) {
  const res = await POST(new Request("http://app.local/api/webhooks/whatsapp-cloud", { method: "POST", body: JSON.stringify(payload) }));
  expect(res.status).toBe(200);
}

beforeEach(() => {
  mem.clear();
  matchSpy.fail = false;
  matchSpy.createFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [id, pn] of [["sa1", "pn_1"], ["sa2", "pn_2"]]) {
    mem.seed(`subAccounts/${id}`, {
      agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "cloud", whatsappCloudMeta: { phoneNumberId: pn },
      prospectingEnabledByAgency: true,
    });
  }
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", phone: PHONE });
  mem.seed(SHOP, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "whatsapp", target: PHONE, status: "sent",
    sentAt: new Date(SENT_S * 1000), respondedAt: null, responseMs: null, autoReplyAt: null, providerRef: "wamid.OUT1",
    deliveredAt: new Date((SENT_S + 2) * 1000),
  });
});

describe("whatsapp-cloud → mystery shop", () => {
  it("a reply from the target number settles the shop at Meta's timestamp, not the receive time", async () => {
    await post(value("pn_1", message("27821234567", "Yes we do!", SENT_S + 14 * 60)));
    expect(mem.read("contacts/c1/whatsappMessages/wamid.IN1")?.direction).toBe("inbound");
    expect(mem.read(SHOP)).toMatchObject({ status: "responded", responseMs: 14 * 60_000, responseVia: "whatsapp" });
  });

  it("a reply from another number, or to another sub-account's Cloud number, never settles it", async () => {
    await post(value("pn_1", message("27821234568", "Yes we do!", SENT_S + 60)));
    await post(value("pn_2", message("27821234567", "Yes we do!", SENT_S + 60, "wamid.IN2")));
    expect(mem.read(SHOP)?.status).toBe("sent");
  });

  it("an away message keeps it waiting, with the automatic reply's time", async () => {
    await post(value("pn_1", message("27821234567", "Thanks for your message, we'll get back to you.", SENT_S + 300)));
    expect(mem.read(SHOP)).toMatchObject({ status: "sent" });
    expect((mem.read(SHOP)?.autoReplyAt as Date).getTime()).toBe((SENT_S + 300) * 1000);
  });

  it("a STOP from the target number opts out, is not counted as the business's response, and is recorded on the shop", async () => {
    await post(value("pn_1", message("27821234567", "STOP", SENT_S + 120)));
    expect(mem.read("contacts/c1")?.whatsappOptedOut).toBe(true);
    expect(mem.read(SHOP)?.status).toBe("sent");
    expect((mem.read(SHOP)?.optOutAt as Date).getTime()).toBe((SENT_S + 120) * 1000);
  });

  it("a caption-less photo from the target number is a reply (Meta's type reaches the matcher)", async () => {
    await post(value("pn_1", { messages: [{ from: "27821234567", id: "wamid.P", timestamp: String(SENT_S + 300), type: "image", image: { id: "m1", mime_type: "image/jpeg" } }] }));
    expect(mem.read(SHOP)).toMatchObject({ status: "responded", responseMs: 300_000 });
  });

  it("a reaction from the target number is not a reply", async () => {
    await post(value("pn_1", { messages: [{ from: "27821234567", id: "wamid.R", timestamp: String(SENT_S + 120), type: "reaction", reaction: { emoji: "👍" } }] }));
    expect(mem.read(SHOP)).toMatchObject({ status: "sent", autoReplyAt: null });
  });

  it("the shop settles even when the sender's contact cannot be created", async () => {
    mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", phone: "+27000000000" });
    matchSpy.createFails = true;
    await post(value("pn_1", message("27821234567", "Yes we do!", SENT_S + 14 * 60)));
    expect(mem.read(SHOP)).toMatchObject({ status: "responded", responseMs: 14 * 60_000 });
  });

  it("a reply still settles a shop after Prospecting was switched off; receipts are skipped then", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), prospectingEnabledByAgency: false });
    await post(value("pn_1", { statuses: [{ id: "wamid.OUT1", status: "failed", recipient_id: "27821234567" }] }));
    expect(mem.read(SHOP)?.status).toBe("sent");
    await post(value("pn_1", message("27821234567", "Yes we do!", SENT_S + 14 * 60)));
    expect(mem.read(SHOP)).toMatchObject({ status: "responded", responseMs: 14 * 60_000 });
  });

  it("a matcher failure is logged, the message is still recorded and Meta gets its 200", async () => {
    matchSpy.fail = true;
    await post(value("pn_1", message("27821234567", "Yes we do!", SENT_S + 120)));
    expect(mem.read("contacts/c1/whatsappMessages/wamid.IN1")?.body).toBe("Yes we do!");
    expect(mem.read(SHOP)?.status).toBe("sent");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("mystery-shop"), expect.anything());
  });

  it("a failed receipt for our message marks the shop undeliverable; delivered and read are stamped at Meta's time", async () => {
    await post(value("pn_1", { statuses: [{ id: "wamid.OUT1", status: "delivered", recipient_id: "27821234567", timestamp: String(SENT_S + 2) }] }));
    await post(value("pn_1", { statuses: [{ id: "wamid.OUT1", status: "read", recipient_id: "27821234567", timestamp: String(SENT_S + 30) }] }));
    expect((mem.read(SHOP)?.deliveredAt as Date).getTime()).toBe((SENT_S + 2) * 1000);
    expect((mem.read(SHOP)?.readAt as Date).getTime()).toBe((SENT_S + 30) * 1000);
    mem.seed(SHOP, { ...mem.read(SHOP), status: "sent" });
    await post(value("pn_1", {
      statuses: [{ id: "wamid.OUT1", status: "failed", recipient_id: "27821234567", errors: [{ code: 131026, title: "Message undeliverable" }] }],
    }));
    expect(mem.read(SHOP)).toMatchObject({ status: "failed", failure: { code: "undeliverable" } });
  });

  it("a failed receipt on another sub-account's number never touches the shop", async () => {
    await post(value("pn_2", { statuses: [{ id: "wamid.OUT1", status: "failed", recipient_id: "27821234567" }] }));
    expect(mem.read(SHOP)?.status).toBe("sent");
  });
});
