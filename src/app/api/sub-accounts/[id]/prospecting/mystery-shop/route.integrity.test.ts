import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mystery-shop route's integrity rules: prospects only, the operator's
 * call consent, the enquiry the dialog showed is the one sent, a send that
 * MAY have gone out is never refunded or re-sendable, and the GET sweep never
 * calls an email shop missed before the mailbox has been read past its window.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/automations/qstash", async () => (await import("@/test/mystery-shop-route-harness")).qstashMock());
vi.mock("@/lib/prospecting/mystery-shop/send", async () => (await import("@/test/mystery-shop-route-harness")).sendMock());

const { mem, storeDb } = await import("@/test/gbp-sync-store");
const {
  USAGE, list, post, publish, readHashes, resetRouteHarness, seedContact, seedSa, seedShop, send, shops, used,
  valid,
} = await import("@/test/mystery-shop-route-harness");

const MAYBE = { code: "send_uncertain", error: "The enquiry may have been sent; check the contact's conversation before trying again." };
const DAY = 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

beforeEach(resetRouteHarness);

describe("prospects only", () => {
  it("403 not_a_prospect for a contact neither imported as a prospect nor carrying the prospecting map; GET too", async () => {
    seedContact("plain", { prospecting: undefined, source: "manual" });
    for (const res of [await post(valid({ contactId: "plain" })), await list("plain")]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "not_a_prospect" });
    }
    seedContact("imported", { prospecting: undefined, source: "prospecting" });
    expect((await list("imported")).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("consent", () => {
  it.each([[undefined], [false], ["true"]])("a call with consentAck %j is 403 consent_required and nothing is sent", async (consentAck) => {
    const res = await post(valid({ channel: "call", target: "0821234567", consentAck }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "consent_required" });
    expect(send).not.toHaveBeenCalled();
    expect(shops()).toEqual([]);
  });
});

describe("the enquiry sent is the one shown", () => {
  it("409 enquiry_changed for a missing or stale hash, e.g. after the template changed", async () => {
    expect((await post(valid({ enquiryHash: undefined }))).status).toBe(409);
    expect((await post(valid({ channel: "call", target: "0821234567", enquiryHash: "0".repeat(64) }))).status).toBe(409);
    seedSa(true, { prospectingMysteryShopTemplates: { emailSubject: "New wording" } });
    const res = await post(valid());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "enquiry_changed", error: "The enquiry changed — reopen the dialog." });
    await readHashes();
    expect((await post(valid())).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("trust reads only the server-owned prospecting.website, never the member-editable contact.website", async () => {
    seedContact("edited", { website: "https://www.acme.co.za", prospecting: { category: "plumber" } });
    await readHashes("edited");
    expect((await post(valid({ contactId: "edited" }))).status).toBe(202);
    expect(shops()[0].targetDomainTrusted).toBe(false);
  });

  it("colleague replies are trusted only when the target is at the website's domain", async () => {
    seedContact("gm", { email: "acme@gmail.com" });
    await readHashes("gm");
    expect((await post(valid({ contactId: "gm", target: "acme@gmail.com" }))).status).toBe(202);
    expect(shops()[0].targetDomainTrusted).toBe(false);
  });
});

describe("a send that may have gone out", () => {
  it.each([
    ["the seam says uncertain", () => send.mockResolvedValueOnce({ ok: false, kind: "uncertain", providerRef: null, reason: "socket hang up" })],
    ["the seam throws", () => send.mockRejectedValueOnce(new Error("boom"))],
  ])("%s: 502 fixed warning, kept sent + sendUncertain, slot kept, timer queued, still blocking", async (_l, arrange) => {
    mem.seed(USAGE, { mysteryShops: 4 });
    arrange();
    const res = await post(valid());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(MAYBE);
    const [shop] = shops();
    expect(shop).toMatchObject({ status: "sent", sendUncertain: true, providerRef: null });
    expect(shop.sentAt).toBeInstanceOf(Date);
    expect(used()).toBe(5);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: { shopId: shop.id }, delaySeconds: 88_200 }));
    expect((await post(valid())).status).toBe(409);
  });

  it("the sent write failing after a real send is uncertain too, with the provider's id kept", async () => {
    const real = storeDb.runTransaction;
    vi.spyOn(storeDb, "runTransaction")
      .mockImplementationOnce(real) // reserve
      .mockImplementationOnce(() => Promise.reject(new Error("14 UNAVAILABLE"))); // markSent
    const res = await post(valid());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(MAYBE);
    expect(shops()[0]).toMatchObject({ status: "sent", sendUncertain: true, providerRef: "<abc@crestahq.com>" });
    expect(used()).toBe(1);
  });

  it("GET treats a queued shop stuck > 10 min as an uncertain send dated from creation — not failed, not refunded", async () => {
    mem.seed(USAGE, { mysteryShops: 2 });
    seedShop("stuck", { status: "queued", sentAt: null, createdAt: ago(11 * 60_000) });
    seedShop("sending", { status: "queued", sentAt: null, createdAt: ago(60_000), channel: "call" });
    const body = (await (await list()).json()) as { shops: { id: string; status: string; sendUncertain: boolean }[] };
    expect(Object.fromEntries(body.shops.map((s) => [s.id, [s.status, s.sendUncertain]]))).toEqual({
      stuck: ["sent", true], sending: ["queued", false],
    });
    expect((mem.read("mysteryShops/stuck")!.sentAt as Date).getTime()).toBe((mem.read("mysteryShops/stuck")!.createdAt as Date).getTime());
    expect(used()).toBe(2);
  });
});

describe("GET sweep", () => {
  it("settles an overdue call shop missed; an email one only once the mailbox has synced past its window", async () => {
    const sent = ago(DAY + 31 * 60_000);
    seedShop("call", { channel: "call", sentAt: sent, contactId: "c1" });
    seedShop("mail", { sentAt: sent });
    seedShop("graceLeft", { sentAt: ago(DAY + 29 * 60_000), channel: "call" });
    let body = (await (await list()).json()) as { shops: { id: string; status: string; awaitingSync: boolean }[] };
    const status = () => Object.fromEntries(body.shops.map((s) => [s.id, s.status]));
    expect(status()).toEqual({ call: "missed", mail: "sent", graceLeft: "sent" });
    expect(body.shops.find((s) => s.id === "mail")?.awaitingSync).toBe(true);

    seedSa(true, { mailboxConfig: { enabled: true, verifiedAt: "x", inboxCaughtUpAt: new Date().toISOString(), lastError: "IMAP down" } });
    body = (await (await list()).json()) as typeof body;
    expect(status().mail).toBe("sent");

    // A recent sync that did not read the INBOX to its end is not enough.
    seedSa(true, { mailboxConfig: { enabled: true, verifiedAt: "x", lastSyncAt: new Date().toISOString(), lastError: null } });
    body = (await (await list()).json()) as typeof body;
    expect(status().mail).toBe("sent");

    seedSa(true, { mailboxConfig: { enabled: true, verifiedAt: "x", inboxCaughtUpAt: new Date().toISOString(), lastError: null } });
    body = (await (await list()).json()) as typeof body;
    expect(status().mail).toBe("missed");
  });
});
