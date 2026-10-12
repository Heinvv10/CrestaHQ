import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Our WhatsApp AI never answers a business we mystery-shopped (Prospecting
 * PR 5b review W1): one guard at the top of maybeRespondWithAi, so every
 * WhatsApp inbound route (Cloud, bridge, Twilio) is covered. Held when the
 * sender's number, or the contact, has a WhatsApp shop sent within
 * LATE_REPLY_HORIZON_MS — whatever its status, so the reply that just settled
 * it is held too. When nothing holds it, the next guard (a blank persona
 * prompt here) decides, which proves this one let it through.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem, storeDb } = await import("@/test/gbp-sync-store");
const { maybeRespondWithAi } = await import("./respond");
const { LATE_REPLY_HORIZON_MS } = await import("@/lib/prospecting/mystery-shop/model");
import type { ResolvedAiAgent } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

const PHONE = "+27821234567";
const SUB = { agencyId: "ag1", prospectingEnabledByAgency: true } as unknown as SubAccountDoc;
const agent = { effective: { systemPrompt: "   " } } as unknown as ResolvedAiAgent;
const contact = (id = "c1") => ({ id, agencyId: "ag1", subAccountId: "sa1", phone: PHONE }) as unknown as Contact;
const respond = (over: Record<string, unknown> = {}) =>
  maybeRespondWithAi({
    subAccountId: "sa1", subAccount: SUB, agent, channelId: "whatsapp", contact: contact(), incomingMessage: "Yes we do",
    replyTo: PHONE, inboundProvider: "cloud", ...over,
  });
const shop = (id: string, extra: Record<string, unknown> = {}) =>
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "whatsapp", target: PHONE, status: "responded",
    sentAt: new Date(Date.now() - 3600_000), createdAt: new Date(Date.now() - 3600_000), ...extra,
  });

beforeEach(() => {
  mem.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the mystery-shop hold on the WhatsApp AI", () => {
  it("holds a reply from a number we mystery-shopped — even from another (auto-created) contact, even once responded", async () => {
    shop("w1", { contactId: "cProspect" });
    expect(await respond({ contact: contact("cAutoCreated") })).toEqual({ kind: "skipped", reason: "mystery_shop" });
    expect(mem.list("contacts/cAutoCreated/activities")[0]).toMatchObject({ type: "ai_skipped", meta: { reason: "mystery_shop" } });
  });

  it("holds a reply from the shopped contact on another number", async () => {
    shop("w1", { target: "+27829999999" });
    expect(await respond()).toEqual({ kind: "skipped", reason: "mystery_shop" });
  });

  it("holds while the shop is still being sent (queued, no sentAt yet)", async () => {
    shop("w1", { status: "queued", sentAt: null });
    expect(await respond()).toEqual({ kind: "skipped", reason: "mystery_shop" });
  });

  it("lets it through once the shop is past the late-reply horizon, for another sub-account's shop, or an email shop", async () => {
    const old = new Date(Date.now() - LATE_REPLY_HORIZON_MS - 60_000);
    shop("old", { sentAt: old, createdAt: old });
    shop("theirs", { subAccountId: "sa2" });
    shop("mail", { channel: "email", target: "info@acme.co.za" });
    expect(await respond()).toEqual({ kind: "skipped", reason: "no_prompt" });
  });

  it("holds a reply from a business we form-shopped: by the contact, or by one of its numbers (PR 5c)", async () => {
    shop("f1", { channel: "form", target: "https://www.acme.co.za/contact", matchNumbers: [PHONE], contactId: "cProspect" });
    expect(await respond({ contact: contact("cAutoCreated") })).toEqual({ kind: "skipped", reason: "mystery_shop" });
    mem.clear();
    shop("f1", { channel: "form", target: "https://www.acme.co.za/contact", matchNumbers: ["+27829999999"] });
    expect(await respond()).toEqual({ kind: "skipped", reason: "mystery_shop" });
    mem.clear();
    const old = new Date(Date.now() - LATE_REPLY_HORIZON_MS - 60_000);
    shop("f1", { channel: "form", target: "https://www.acme.co.za/contact", matchNumbers: [PHONE], sentAt: old, createdAt: old });
    shop("f2", { channel: "form", target: "https://x.co.za/", matchNumbers: ["+27829999999"], contactId: "cOther" });
    expect(await respond()).toEqual({ kind: "skipped", reason: "no_prompt" });
  });

  it("only on WhatsApp, and not while Prospecting is off for the sub-account", async () => {
    shop("w1");
    expect(await respond({ channelId: "sms" })).toEqual({ kind: "skipped", reason: "no_prompt" });
    expect(await respond({ subAccount: { ...SUB, prospectingEnabledByAgency: false } })).toEqual({ kind: "skipped", reason: "no_prompt" });
  });

  it("fails closed: if the shops can't be read, the AI stays quiet", async () => {
    const real = storeDb.collection.bind(storeDb);
    vi.spyOn(storeDb, "collection").mockImplementation((path: string) => {
      if (path === "mysteryShops") throw new Error("firestore down");
      return real(path);
    });
    expect(await respond()).toEqual({ kind: "skipped", reason: "mystery_shop_check_failed" });
    expect(mem.list("contacts/c1/activities")[0]).toMatchObject({
      type: "ai_skipped",
      content: "AI reply skipped — the mystery-shop check could not run, so the AI stays quiet to be safe.",
      meta: { reason: "mystery_shop_check_failed" },
    });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("the mystery-shop hold on Email AI drafts", () => {
  const FROM = "info@acme.co.za";
  const draft = (over: Record<string, unknown> = {}) =>
    respond({ channelId: "email", replyTo: FROM, inboundProvider: undefined, ...over });

  it("holds a draft for a business we email-shopped: by the contact, the target address, or a colleague on a trusted domain", async () => {
    shop("e1", { channel: "email", target: FROM, contactId: "cProspect" });
    expect(await draft({ contact: contact("cAutoCreated") })).toEqual({ kind: "skipped", reason: "mystery_shop" });
    expect(mem.list("contacts/cAutoCreated/activities")[0]).toMatchObject({
      content: "AI reply skipped — this address is being mystery-shopped (Prospecting).",
    });
    mem.clear();
    shop("e1", { channel: "email", target: "sales@other.co.za" });
    expect(await draft()).toEqual({ kind: "skipped", reason: "mystery_shop" });
    mem.clear();
    shop("e1", { channel: "email", target: "sales@acme.co.za", targetDomainTrusted: true, contactId: "cProspect" });
    expect(await draft()).toEqual({ kind: "skipped", reason: "mystery_shop" });
  });

  it("holds a draft for a business we form-shopped, by its senders' addresses or domains", async () => {
    shop("f1", { channel: "form", target: "https://www.acme.co.za/contact", contactId: "cProspect", senders: { addresses: [FROM], domains: [] } });
    expect(await draft()).toEqual({ kind: "skipped", reason: "mystery_shop" });
    mem.clear();
    shop("f1", { channel: "form", target: "https://www.acme.co.za/contact", contactId: "cProspect", senders: { addresses: [], domains: ["acme.co.za"] } });
    expect(await draft()).toEqual({ kind: "skipped", reason: "mystery_shop" });
  });

  it("lets it through for an untrusted-domain colleague, an old shop, a WhatsApp shop, another sub-account's shop, or Prospecting off", async () => {
    const old = new Date(Date.now() - LATE_REPLY_HORIZON_MS - 60_000);
    shop("colleague", { channel: "email", target: "sales@acme.co.za", targetDomainTrusted: false, contactId: "cProspect" });
    shop("old", { channel: "email", target: FROM, sentAt: old, createdAt: old });
    shop("wa", { channel: "whatsapp", target: PHONE, contactId: "cProspect" });
    shop("theirs", { channel: "email", target: FROM, subAccountId: "sa2" });
    expect(await draft()).toEqual({ kind: "skipped", reason: "no_prompt" });
    mem.clear();
    shop("e1", { channel: "email", target: FROM });
    expect(await draft({ subAccount: { ...SUB, prospectingEnabledByAgency: false } })).toEqual({ kind: "skipped", reason: "no_prompt" });
  });

  it("fails closed: if the shops can't be read, no draft", async () => {
    const real = storeDb.collection.bind(storeDb);
    vi.spyOn(storeDb, "collection").mockImplementation((path: string) => {
      if (path === "mysteryShops") throw new Error("firestore down");
      return real(path);
    });
    expect(await draft()).toEqual({ kind: "skipped", reason: "mystery_shop_check_failed" });
  });
});
