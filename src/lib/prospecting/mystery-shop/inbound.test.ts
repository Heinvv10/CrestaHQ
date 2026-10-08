import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The inbound hooks against the in-memory Firestore: an IMAP reply, a
 * mystery-shop call's end-of-call report and an inbound callback each settle
 * only the right shop, once.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const { mem } = await import("@/test/gbp-sync-store");
const { matchInboundCallback, matchMysteryShopEmail, settleMysteryShopCall } = await import("./inbound");
const { releaseShop } = await import("./store");

const SENT = Date.now() - 3 * 3600_000;
const EMAIL = "info@acme.co.za";
const PHONE = "+27821234567";
const NO_HEADERS = { autoSubmitted: null, xAutoreply: null, xAutorespond: null, precedence: null, listId: null, listUnsubscribe: null };

function seedShop(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: EMAIL, status: "sent",
    sentAt: new Date(SENT), respondedAt: null, responseMs: null, autoReplyAt: null, providerRef: `<${id}@crestahq.com>`,
    targetDomainTrusted: true,
    ...extra,
  });
}
const shop = (id: string) => mem.read(`mysteryShops/${id}`)!;
const email = (from: string, over: Record<string, unknown> = {}) => ({
  from, inReplyTo: null, references: [], autoReply: NO_HEADERS, authResults: [] as string[],
  dsn: { contentType: null as string | null, msExchangeNdr: null, failedRecipients: null, text: "", deliveryStatus: "" }, subject: "Re: Enquiry", occurredAtMs: SENT + 2 * 3600_000, ...over,
});
const callReport = (over: Record<string, unknown> = {}) => ({
  endedReason: "customer-ended-call", durationSec: 30, startedAtMs: SENT + 12_000, endedAtMs: SENT + 42_000,
  receivedAtMs: SENT + 60_000,
  turns: [
    { role: "assistant" as const, content: "Hi, I'm calling from Cresta HQ.", secondsFromStart: 0.5 },
    { role: "user" as const, content: "Yes we do.", secondsFromStart: 5 },
  ],
  ...over,
});

beforeEach(() => mem.clear());

describe("email", () => {
  it("a reply from the target settles the shop with the elapsed time; a second reply changes nothing", async () => {
    seedShop("s1");
    await matchMysteryShopEmail("sa1", email(EMAIL));
    expect(shop("s1")).toMatchObject({ status: "responded", responseMs: 2 * 3600_000, responseVia: "email", senderAuth: "unknown" });
    await matchMysteryShopEmail("sa1", email(EMAIL, { occurredAtMs: SENT + 3 * 3600_000 }));
    expect(shop("s1").responseMs).toBe(2 * 3600_000);
  });

  it("only the mailbox's own sub-account's shops are considered", async () => {
    seedShop("s1", { subAccountId: "sa2" });
    await matchMysteryShopEmail("sa1", email(EMAIL));
    expect(shop("s1").status).toBe("sent");
  });

  it("an auto-reply is recorded once and the shop keeps waiting", async () => {
    seedShop("s1");
    await matchMysteryShopEmail("sa1", email(EMAIL, { autoReply: { ...NO_HEADERS, autoSubmitted: "auto-replied" }, occurredAtMs: SENT + 60_000 }));
    await matchMysteryShopEmail("sa1", email(EMAIL, { subject: "Out of office", occurredAtMs: SENT + 120_000 }));
    expect(shop("s1")).toMatchObject({ status: "sent", respondedAt: null });
    expect((shop("s1").autoReplyAt as Date).getTime()).toBe(SENT + 60_000);
  });

  it("a forged In-Reply-To from another sender closes nothing", async () => {
    seedShop("s1");
    await matchMysteryShopEmail("sa1", email("x@evil.example", { inReplyTo: "<s1@crestahq.com>" }));
    expect(shop("s1").status).toBe("sent");
  });

  it("an email reply is never stored verified, even with a (possibly injected) dmarc=pass on top", async () => {
    seedShop("s1");
    await matchMysteryShopEmail("sa1", email(EMAIL, { authResults: ["mx.crestahq.com; dmarc=pass header.from=acme.co.za"] }));
    expect(shop("s1")).toMatchObject({ status: "responded", responseVia: "email", senderAuth: "unknown" });
  });

  it("a From that fails DMARC settles responded, stamped senderAuth fail (kept off the public page)", async () => {
    seedShop("s1");
    const spoof = { authResults: ["mx.crestahq.com; spf=fail smtp.mailfrom=acme.co.za; dmarc=fail header.from=acme.co.za"] };
    await matchMysteryShopEmail("sa1", email(EMAIL, spoof));
    expect(shop("s1")).toMatchObject({ status: "responded", responseVia: "email", senderAuth: "fail" });
  });

  it("a late-synced in-window reply upgrades a missed shop", async () => {
    seedShop("s1", { status: "missed", sentAt: new Date(Date.now() - 30 * 3600_000) });
    await matchMysteryShopEmail("sa1", email(EMAIL, { occurredAtMs: Date.now() - 20 * 3600_000 }));
    expect(shop("s1")).toMatchObject({ status: "responded", responseMs: 10 * 3600_000 });
  });

  it("a bounce naming our Message-ID marks the shop failed/bounced and keeps the cap slot", async () => {
    mem.seed("subAccounts/sa1/usage/2026-10", { mysteryShops: 3 });
    seedShop("s1", { usageMonth: "2026-10" });
    const dsn = {
      contentType: "multipart/report; report-type=delivery-status", msExchangeNdr: null, failedRecipients: null,
      text: "Message-ID: <s1@crestahq.com>", deliveryStatus: "Final-Recipient: rfc822; info@acme.co.za\nAction: failed",
    };
    await matchMysteryShopEmail("sa1", email("mailer-daemon@mx.google.com", { dsn, subject: "Delivery Status Notification (Failure)" }));
    expect(shop("s1")).toMatchObject({ status: "failed", failure: { code: "bounced" } });
    expect(mem.read("subAccounts/sa1/usage/2026-10")?.mysteryShops).toBe(3);
  });

  it("a colleague's reply counts only when the target domain was trusted at send", async () => {
    seedShop("s1", { targetDomainTrusted: false });
    await matchMysteryShopEmail("sa1", email("john@acme.co.za"));
    expect(shop("s1").status).toBe("sent");
    seedShop("s2");
    await matchMysteryShopEmail("sa1", email("john@acme.co.za"));
    expect(shop("s2").status).toBe("responded");
  });

  it("a missed shop more than 48 h past its window is no longer upgraded, even by an in-window reply", async () => {
    const sentAt = Date.now() - 4 * 24 * 3600_000;
    seedShop("s1", { status: "missed", sentAt: new Date(sentAt) });
    await matchMysteryShopEmail("sa1", email(EMAIL, { occurredAtMs: sentAt + 3600_000 }));
    expect(shop("s1").status).toBe("missed");
  });

  it("call shops are not touched by email", async () => {
    seedShop("c1", { channel: "call", target: EMAIL });
    await matchMysteryShopEmail("sa1", email(EMAIL));
    expect(shop("c1").status).toBe("sent");
  });
});

describe("call", () => {
  it("an answered mystery-shop call is responded at the answer time", async () => {
    seedShop("k1", { channel: "call", target: PHONE, providerRef: "call_1" });
    await settleMysteryShopCall("sa1", "k1", "call_1", callReport());
    expect(shop("k1")).toMatchObject({ status: "responded", responseMs: 12_000, responseVia: "answered", senderAuth: "pass" });
  });

  it("an answer timed before the send is clamped to the send (responseMs never negative)", async () => {
    seedShop("k1", { channel: "call", target: PHONE, providerRef: "call_1" });
    await settleMysteryShopCall("sa1", "k1", "call_1", callReport({ startedAtMs: SENT - 4_000 }));
    expect(shop("k1")).toMatchObject({ status: "responded", responseMs: 0, responseVia: "answered" });
  });

  it("only the call we placed settles it: another call carrying a copied shop id is ignored", async () => {
    seedShop("k1", { channel: "call", target: PHONE, providerRef: "call_1" });
    await settleMysteryShopCall("sa1", "k1", "call_other", callReport());
    seedShop("k2", { channel: "call", target: PHONE, providerRef: null });
    await settleMysteryShopCall("sa1", "k2", "call_2", callReport());
    expect(shop("k1").status).toBe("sent");
    expect(shop("k2").status).toBe("sent");
  });

  it.each(["voicemail", "customer-did-not-answer", "customer-busy", "twilio-failed-to-connect-call"])(
    "%s with no dialogue leaves the shop waiting for a callback",
    async (endedReason) => {
      seedShop("k1", { channel: "call", target: PHONE, providerRef: "call_1" });
      const turns = [{ role: "assistant" as const, content: "Hi, I'm calling from Cresta HQ.", secondsFromStart: 0.5 }];
      await settleMysteryShopCall("sa1", "k1", "call_1", callReport({ endedReason, turns }));
      expect(shop("k1").status).toBe("sent");
    },
  );

  it("a report naming another sub-account's shop, or an email shop, is ignored", async () => {
    seedShop("k1", { channel: "call", target: PHONE, subAccountId: "sa2", providerRef: "call_1" });
    seedShop("e1", { providerRef: "call_1" });
    await settleMysteryShopCall("sa1", "k1", "call_1", callReport());
    await settleMysteryShopCall("sa1", "e1", "call_1", callReport());
    await settleMysteryShopCall("sa1", "../x", "call_1", callReport());
    expect(shop("k1").status).toBe("sent");
    expect(shop("e1").status).toBe("sent");
  });

  it("an inbound call from the target number is a callback, at the call's start", async () => {
    seedShop("k1", { channel: "call", target: PHONE });
    await matchInboundCallback("sa1", "+27 82 123 4567", callReport({ startedAtMs: SENT + 3600_000 }));
    expect(shop("k1")).toMatchObject({ status: "responded", responseMs: 3600_000, responseVia: "callback", senderAuth: "unknown" });
  });

  it("a call from a different number never matches", async () => {
    seedShop("k1", { channel: "call", target: PHONE });
    await matchInboundCallback("sa1", "+27821234568", callReport());
    await matchInboundCallback("sa1", null, callReport());
    await matchInboundCallback("sa2", PHONE, callReport());
    expect(shop("k1").status).toBe("sent");
  });
});

describe("release", () => {
  it("gives the slot back once, and never for a shop that sent", async () => {
    mem.seed("subAccounts/sa1/usage/2026-10", { mysteryShops: 2 });
    seedShop("q1", { status: "queued", usageMonth: "2026-10" });
    seedShop("s1", { usageMonth: "2026-10" });
    expect(await releaseShop("q1", "failed", { code: "x", reason: "y" })).toBe(true);
    expect(await releaseShop("q1", "failed", { code: "x", reason: "y" })).toBe(false);
    expect(await releaseShop("s1", "failed", { code: "x", reason: "y" })).toBe(false);
    expect(mem.read("subAccounts/sa1/usage/2026-10")?.mysteryShops).toBe(1);
    expect(shop("s1").status).toBe("sent");
  });
});
