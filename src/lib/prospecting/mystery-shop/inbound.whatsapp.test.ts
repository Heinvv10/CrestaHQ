import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WhatsApp hooks against the in-memory Firestore: a reply from the
 * target number (at Meta's own timestamp) settles only that sub-account's
 * open WhatsApp shop to that number; an away message is recorded and the shop
 * keeps waiting; a delivery receipt for our message id stamps it, and a failed
 * one marks it undeliverable.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { matchMysteryShopWhatsApp, recordMysteryShopWhatsAppStatus } = await import("./inbound");

const SENT = Date.now() - 3 * 3600_000;
const PHONE = "+27821234567";
const WAMID = "wamid.OUT1";

function seedShop(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "whatsapp", target: PHONE, status: "sent",
    sentAt: new Date(SENT), respondedAt: null, responseMs: null, autoReplyAt: null, providerRef: WAMID, usageMonth: "2026-10",
    ...extra,
  });
}
const shop = (id: string) => mem.read(`mysteryShops/${id}`)!;
const at = (ms: number) => SENT + ms;

beforeEach(() => mem.clear());

describe("matchMysteryShopWhatsApp", () => {
  it("a reply from the target number settles the shop at Meta's timestamp; a second reply changes nothing", async () => {
    seedShop("w1");
    await matchMysteryShopWhatsApp("sa1", PHONE, at(14 * 60_000), "Yes we do, where are you?");
    expect(shop("w1")).toMatchObject({ status: "responded", responseMs: 14 * 60_000, responseVia: "whatsapp", senderAuth: "pass" });
    expect((shop("w1").respondedAt as Date).getTime()).toBe(at(14 * 60_000));
    await matchMysteryShopWhatsApp("sa1", PHONE, at(20 * 60_000), "Hello?");
    expect(shop("w1").responseMs).toBe(14 * 60_000);
  });

  it("a different number never settles it", async () => {
    seedShop("w1");
    await matchMysteryShopWhatsApp("sa1", "+27821234568", at(60_000), "Yes we do");
    expect(shop("w1").status).toBe("sent");
  });

  it("another sub-account's shop to the same number is never settled", async () => {
    seedShop("w1", { subAccountId: "sa2" });
    await matchMysteryShopWhatsApp("sa1", PHONE, at(60_000), "Yes we do");
    expect(shop("w1").status).toBe("sent");
  });

  it("an email or call shop to the same number is not touched", async () => {
    seedShop("k1", { channel: "call" });
    await matchMysteryShopWhatsApp("sa1", PHONE, at(60_000), "Yes we do");
    expect(shop("k1").status).toBe("sent");
  });

  it("an away / greeting message is recorded once as an automatic reply and the shop keeps waiting", async () => {
    seedShop("w1");
    await matchMysteryShopWhatsApp("sa1", PHONE, at(5_000), "Thank you for contacting Acme! We'll get back to you soon.");
    expect(shop("w1")).toMatchObject({ status: "sent" });
    expect((shop("w1").autoReplyAt as Date).getTime()).toBe(at(5_000));
    await matchMysteryShopWhatsApp("sa1", PHONE, at(9_000), "Our business hours are 8–5.");
    expect((shop("w1").autoReplyAt as Date).getTime()).toBe(at(5_000));
    await matchMysteryShopWhatsApp("sa1", PHONE, at(3600_000), "Hi, yes we do");
    expect(shop("w1")).toMatchObject({ status: "responded", responseMs: 3600_000 });
  });

  it("a message timed outside the window (before the send, or after 24 h) settles nothing", async () => {
    seedShop("w1");
    await matchMysteryShopWhatsApp("sa1", PHONE, SENT - 60_000, "an older message, redelivered late");
    await matchMysteryShopWhatsApp("sa1", PHONE, at(24 * 3600_000 + 1), "Sorry, only saw this now");
    expect(shop("w1")).toMatchObject({ status: "sent", respondedAt: null, autoReplyAt: null });
  });

  it("a number that is not a valid phone matches nothing", async () => {
    seedShop("w1", { target: "+" });
    await matchMysteryShopWhatsApp("sa1", "+", at(60_000), "Yes");
    expect(shop("w1").status).toBe("sent");
  });
});

describe("recordMysteryShopWhatsAppStatus", () => {
  it("delivered and read are stamped once each, at Meta's time; the shop keeps waiting", async () => {
    seedShop("w1");
    await recordMysteryShopWhatsAppStatus("sa1", WAMID, "delivered", at(2_000), null);
    await recordMysteryShopWhatsAppStatus("sa1", WAMID, "read", at(90_000), null);
    await recordMysteryShopWhatsAppStatus("sa1", WAMID, "delivered", at(95_000), null);
    expect(shop("w1")).toMatchObject({ status: "sent" });
    expect((shop("w1").deliveredAt as Date).getTime()).toBe(at(2_000));
    expect((shop("w1").readAt as Date).getTime()).toBe(at(90_000));
  });

  it("failed → failed/undeliverable with Meta's error; the cap slot is kept", async () => {
    seedShop("w1");
    mem.seed("subAccounts/sa1/usage/2026-10", { mysteryShops: 3 });
    await recordMysteryShopWhatsAppStatus("sa1", WAMID, "failed", at(2_000), "131026: Message undeliverable");
    expect(shop("w1")).toMatchObject({
      status: "failed",
      failure: { code: "undeliverable", reason: "WhatsApp couldn't deliver the enquiry (131026: Message undeliverable)." },
    });
    expect(mem.read("subAccounts/sa1/usage/2026-10")?.mysteryShops).toBe(3);
  });

  it("a failed receipt also fails a shop already missed, never a responded one", async () => {
    seedShop("m1", { status: "missed" });
    seedShop("r1", { status: "responded", providerRef: "wamid.R" });
    await recordMysteryShopWhatsAppStatus("sa1", WAMID, "failed", at(2_000), null);
    await recordMysteryShopWhatsAppStatus("sa1", "wamid.R", "failed", at(2_000), null);
    expect(shop("m1")).toMatchObject({ status: "failed", failure: { code: "undeliverable", reason: "WhatsApp couldn't deliver the enquiry." } });
    expect(shop("r1").status).toBe("responded");
  });

  it("only our message id in this sub-account's WhatsApp shops: another id, sub-account or channel is untouched", async () => {
    seedShop("w1", { providerRef: "wamid.OTHER" });
    seedShop("w2", { subAccountId: "sa2" });
    seedShop("e1", { channel: "email" });
    for (const status of ["failed", "delivered"] as const) await recordMysteryShopWhatsAppStatus("sa1", WAMID, status, at(2_000), null);
    for (const id of ["w1", "w2", "e1"]) expect(shop(id)).toMatchObject({ status: "sent" });
    for (const id of ["w1", "w2", "e1"]) expect(shop(id).deliveredAt).toBeUndefined();
  });

  it("a receipt with no message id matches nothing (a shop whose send never returned an id)", async () => {
    seedShop("w1", { providerRef: null });
    await recordMysteryShopWhatsAppStatus("sa1", "", "failed", at(2_000), null);
    expect(shop("w1").status).toBe("sent");
  });
});
