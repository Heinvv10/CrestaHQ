import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Form shops on 5b's WhatsApp matcher: a WhatsApp from one of the contact's
 * own numbers (`matchNumbers`) settles a waiting form shop, with 5b's
 * automatic-reply rules (timed from the submit — there is no delivery
 * receipt for a form); anything else never does.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { matchMysteryShopWhatsApp } = await import("../inbound");

const SENT = Date.now() - 3 * 3600_000;
const PHONE = "+27821234567";
const at = (ms: number) => SENT + ms;

function seedForm(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "form", target: "https://www.acme.co.za/contact",
    status: "sent", sentAt: new Date(SENT), respondedAt: null, responseMs: null, autoReplyAt: null, providerRef: `form:${id}:1`,
    matchDomains: ["acme.co.za"], matchAddresses: ["info@acme.co.za"], matchNumbers: [PHONE], usageMonth: "2026-10", ...extra,
  });
}
const shop = (id: string) => mem.read(`mysteryShops/${id}`)!;
const reply = (from: string, atMs: number, text: string, over: Record<string, unknown> = {}) =>
  matchMysteryShopWhatsApp("sa1", { from, atMs, text, type: "text", optOut: null, ...over });

beforeEach(() => mem.clear());

describe("form shops and WhatsApp replies", () => {
  it("a person's WhatsApp from the contact's number settles it, at Meta's timestamp", async () => {
    seedForm("f1");
    expect(await reply(PHONE, at(20 * 60_000), "Hi, yes we do plumbing in Gqeberha. When do you need us?")).toBe(1);
    expect(shop("f1")).toMatchObject({ status: "responded", responseMs: 20 * 60_000, responseVia: "whatsapp", senderAuth: "pass" });
  });

  it("an automatic reply (within the first minute of the submit, or greeting phrasing) is recorded and the shop waits", async () => {
    seedForm("f1");
    await reply(PHONE, at(30_000), "Yes we do, when?");
    expect(shop("f1")).toMatchObject({ status: "sent" });
    expect((shop("f1").autoReplyAt as Date).getTime()).toBe(at(30_000));
    seedForm("f2", { contactId: "c2" });
    await reply(PHONE, at(10 * 60_000), "Thank you for contacting Acme Plumbing! We'll get back to you.");
    expect(shop("f2")).toMatchObject({ status: "sent", autoReplyAt: expect.any(Date) });
  });

  it("another number, another sub-account, a reaction or a STOP never settles it (and STOP is no opt-out here)", async () => {
    seedForm("f1");
    seedForm("f2", { subAccountId: "sa2" });
    expect(await reply("+27829999999", at(20 * 60_000), "Yes we do")).toBe(0);
    expect(await reply(PHONE, at(20 * 60_000), "", { type: "reaction" })).toBe(0);
    expect(await reply(PHONE, at(20 * 60_000), "STOP", { optOut: true })).toBe(0);
    expect(shop("f1")).toMatchObject({ status: "sent", autoReplyAt: null });
    expect(shop("f1").optOutAt).toBeUndefined();
    expect(shop("f2").status).toBe("sent");
  });

  it("outside the window it does nothing; a missed form shop is upgraded by an in-window late reply", async () => {
    seedForm("f1");
    await reply(PHONE, at(25 * 3600_000), "Yes we do");
    expect(shop("f1").status).toBe("sent");
    seedForm("f2", { status: "missed" });
    await reply(PHONE, at(23 * 3600_000), "Sorry for the delay, yes we do");
    expect(shop("f2").status).toBe("responded");
  });
});
