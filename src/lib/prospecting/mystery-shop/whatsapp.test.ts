import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * whatsapp.ts below the route: which template is used, and the last check
 * before the send — the text the provider will get is the text the dialog
 * showed. The rail's readiness and the template send are faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "cloud", sender: { id: "default" } }),
}));
const waSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/whatsapp-template-send", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/whatsapp-template-send")>()),
  sendWhatsappTemplate: (...a: unknown[]) => waSend(...a),
}));

const { mem } = await import("@/test/gbp-sync-store");
const { sendWhatsappShop, whatsappEnquiryOf, whatsappState } = await import("./whatsapp");
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

const SUB = { agencyId: "ag1", name: "Cresta HQ", whatsappEnabledByAgency: true, whatsappProvider: "cloud" } as unknown as SubAccountDoc;
const CONTACT = { agencyId: "ag1", subAccountId: "sa1", phone: "082 123 4567", city: "Gqeberha", prospecting: { category: "plumber" } } as unknown as Contact;
const variable = (position: number) => ({ position, label: `v${position}`, sampleValue: "x", source: "manual", mergeTag: null });
const template = (id: string, extra: Record<string, unknown> = {}) =>
  mem.seed(`subAccounts/sa1/whatsappTemplates/${id}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "leadstack_speed_check", language: "en",
    body: "Hi, do you offer {{1}} in {{2}}?", variables: [variable(1), variable(2)], status: "approved", contentSid: null,
    registrations: { cloud: { externalId: "meta-1", status: "approved", rejectionReason: null } }, ...extra,
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { ...SUB });
  waSend.mockReset().mockResolvedValue({ ok: true, sid: "wamid.1" });
});

describe("the template", () => {
  it("of several named leadstack_speed_check, a usable one is used", async () => {
    template("a1", { registrations: { cloud: { externalId: "m", status: "rejected", rejectionReason: "x" } } });
    template("b2", { body: "Hello, any {{1}} in {{2}}?" });
    expect(await whatsappState("sa1", SUB)).toEqual({ available: true });
    expect((await whatsappEnquiryOf("sa1", CONTACT, SUB))?.text).toBe("Hello, any plumber in Gqeberha?");
  });

  it("a chosen id that is not a doc id is no template", async () => {
    template("t1");
    const sub = { ...SUB, prospectingMysteryShopTemplates: { whatsappTemplateId: "a/b" } } as SubAccountDoc;
    expect(await whatsappEnquiryOf("sa1", CONTACT, sub)).toBeNull();
    expect((await whatsappState("sa1", sub)).available).toBe(false);
  });
});

describe("sendWhatsappShop", () => {
  it("refuses, sending nothing, when the template's text is no longer the text the dialog showed", async () => {
    template("t1");
    const enquiry = await whatsappEnquiryOf("sa1", CONTACT, SUB);
    template("t1", { body: "Different words for {{1}} in {{2}}." });
    expect(await sendWhatsappShop({ target: "+27821234567", contact: CONTACT, contactId: "c1", uid: "u1", enquiry })).toEqual({
      ok: false, kind: "refused", code: "enquiry_changed", reason: "The WhatsApp template changed — reopen the dialog.",
    });
    expect(waSend).not.toHaveBeenCalled();
  });

  it("refuses without an enquiry, and for an opted-out contact before anything else", async () => {
    template("t1");
    const enquiry = await whatsappEnquiryOf("sa1", CONTACT, SUB);
    expect(await sendWhatsappShop({ target: "+27821234567", contact: CONTACT, contactId: "c1", uid: "u1", enquiry: null })).toMatchObject({
      kind: "refused", code: "channel_unavailable",
    });
    const optedOut = { ...CONTACT, whatsappOptedOut: true } as Contact;
    expect(await sendWhatsappShop({ target: "+27821234567", contact: optedOut, contactId: "c1", uid: "u1", enquiry })).toMatchObject({
      kind: "refused", code: "opted_out",
    });
    expect(waSend).not.toHaveBeenCalled();
  });
});
