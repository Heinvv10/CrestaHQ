import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WhatsApp shop's delivery evidence (5b review W4, W8) on the in-memory
 * Firestore: the send is timed from before the provider is asked and its
 * message id is on the shop before anything else; a miss reads the thread
 * row's delivery status first; and a miss is confirmable only once WhatsApp
 * confirmed delivery, never after a STOP, and after an automatic-looking
 * reply only once the member says they read the thread.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { confirmMissed, markSent, markUncertain, recordProviderRef, settleMissed, stampSendStart } = await import("./store");
const { recordMysteryShopWhatsAppStatus } = await import("./inbound");

const DAY = 24 * 3600_000;
const SENT = Date.now() - DAY - 3600_000;
const ROW = "contacts/c1/whatsappMessages/wamid.1";
const shop = (id: string) => mem.read(`mysteryShops/${id}`)!;
const seed = (id: string, extra: Record<string, unknown> = {}) =>
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "whatsapp", target: "+27821234567", status: "sent",
    sentAt: new Date(SENT), respondedAt: null, autoReplyAt: null, providerRef: "wamid.1", createdAt: new Date(SENT), ...extra,
  });

beforeEach(() => mem.clear());

describe("the send's own record", () => {
  it("sentAt is stamped before the provider is asked and kept by markSent; the id lands as soon as it is known", async () => {
    seed("q1", { status: "queued", sentAt: null, providerRef: null });
    const started = await stampSendStart("q1");
    expect(started).toBeInstanceOf(Date);
    expect(await recordProviderRef("q1", "wamid.Q")).toBe(true);
    expect(shop("q1")).toMatchObject({ status: "queued", providerRef: "wamid.Q" });
    // A receipt that beats markSent now finds the shop.
    await recordMysteryShopWhatsAppStatus("sa1", "wamid.Q", "delivered", Date.now(), null);
    expect(shop("q1").deliveredAt).toBeInstanceOf(Date);
    const sentAt = await markSent("q1", "wamid.Q");
    expect(sentAt?.getTime()).toBe(started!.getTime());
    expect((shop("q1").sentAt as Date).getTime()).toBe(started!.getTime());
  });

  it("an uncertain send keeps the pre-stamped sentAt too", async () => {
    seed("q1", { status: "queued", sentAt: null, providerRef: null });
    const started = await stampSendStart("q1");
    await markUncertain("q1", null);
    expect((shop("q1").sentAt as Date).getTime()).toBe(started!.getTime());
  });

  it("stamps only a queued shop, and records only the first id", async () => {
    seed("s1");
    expect(await stampSendStart("s1")).toBeNull();
    seed("q1", { status: "queued", sentAt: null, providerRef: null });
    await recordProviderRef("q1", "wamid.A");
    expect(await recordProviderRef("q1", "wamid.B")).toBe(false);
    expect(shop("q1").providerRef).toBe("wamid.A");
    seed("f1", { status: "failed", providerRef: null });
    expect(await recordProviderRef("f1", "wamid.F")).toBe(false);
    expect(shop("f1").providerRef).toBeNull();
  });

  it("a failed receipt that beats markSent marks the queued shop undeliverable (it reached Meta: no refund)", async () => {
    seed("q1", { status: "queued", providerRef: "wamid.Q" });
    await recordMysteryShopWhatsAppStatus("sa1", "wamid.Q", "failed", Date.now(), "131026");
    expect(shop("q1")).toMatchObject({ status: "failed", failure: { code: "undeliverable" } });
  });
});

describe("settleMissed reads the thread row first", () => {
  it("a failed row → failed/undeliverable instead of missed", async () => {
    seed("w1");
    mem.seed(ROW, { direction: "outbound", status: "failed", error: "131026: Message undeliverable" });
    expect(await settleMissed("w1")).toBe("failed");
    expect(shop("w1")).toMatchObject({
      status: "failed",
      failure: { code: "undeliverable", reason: "WhatsApp couldn't deliver the enquiry (131026: Message undeliverable)." },
    });
  });

  it("a delivered or read row stamps the evidence, then missed", async () => {
    seed("w1");
    mem.seed(ROW, { direction: "outbound", status: "read" });
    expect(await settleMissed("w1")).toBe("missed");
    expect(shop("w1").deliveredAt).toBeInstanceOf(Date);
    expect(shop("w1").readAt).toBeInstanceOf(Date);
    seed("w2", { providerRef: "wamid.2" });
    mem.seed("contacts/c1/whatsappMessages/wamid.2", { direction: "outbound", status: "delivered" });
    await settleMissed("w2");
    expect(shop("w2").deliveredAt).toBeInstanceOf(Date);
    expect(shop("w2").readAt).toBeUndefined();
  });

  it("an existing receipt time is kept; a sent row or no row stamps nothing", async () => {
    const at = new Date(SENT + 5_000);
    seed("w1", { deliveredAt: at });
    mem.seed(ROW, { direction: "outbound", status: "delivered" });
    await settleMissed("w1");
    expect((shop("w1").deliveredAt as Date).getTime()).toBe(at.getTime());
    seed("w2", { providerRef: "wamid.none" });
    expect(await settleMissed("w2")).toBe("missed");
    expect(shop("w2").deliveredAt).toBeUndefined();
  });

  it("an email shop never looks for a WhatsApp row", async () => {
    seed("e1", { channel: "email" });
    mem.seed(ROW, { direction: "outbound", status: "failed" });
    mem.seed("subAccounts/sa1", { mailboxConfig: { inboxCaughtUpAt: new Date().toISOString() } });
    expect(await settleMissed("e1")).toBe("missed");
  });
});

describe("confirmMissed for a WhatsApp miss", () => {
  const delivered = { status: "missed", deliveredAt: new Date(SENT + 2_000) };

  it("refuses without a delivery receipt", async () => {
    seed("w1", { status: "missed" });
    expect(await confirmMissed("w1", "sa1", "u1")).toBe("not_delivered");
    expect(shop("w1").missedConfirmedAt).toBeUndefined();
  });

  it("refuses after the business replied STOP", async () => {
    seed("w1", { ...delivered, optOutAt: new Date(SENT + 60_000) });
    expect(await confirmMissed("w1", "sa1", "u1")).toBe("opted_out");
  });

  it("after an automatic-looking reply, only once the member says they read the thread", async () => {
    seed("w1", { ...delivered, autoReplyAt: new Date(SENT + 10_000) });
    expect(await confirmMissed("w1", "sa1", "u1")).toBe("review_auto_reply");
    expect(await confirmMissed("w1", "sa1", "u1", { reviewedAutoReply: true })).toBeInstanceOf(Date);
  });

  it("a delivered miss with no automatic reply confirms; an email miss needs none of this", async () => {
    seed("w1", delivered);
    expect(await confirmMissed("w1", "sa1", "u1")).toBeInstanceOf(Date);
    seed("e1", { channel: "email", status: "missed", autoReplyAt: new Date(SENT + 10_000) });
    expect(await confirmMissed("e1", "sa1", "u1")).toBeInstanceOf(Date);
  });
});
