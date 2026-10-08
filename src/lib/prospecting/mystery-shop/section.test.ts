import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatMoney,
  mysteryShopSections,
  serializeShop,
  shopStatusLine,
  type MemberShop,
} from "./section";

const SENT = "2026-10-08T08:00:00.000Z";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const EMAIL = "owner@acme-plumbing.co.za";
const PHONE = "+27829876543";

const shop = (over: Partial<MemberShop> = {}): MemberShop => ({
  id: "s1", channel: "email", status: "responded", target: EMAIL, sentAt: SENT,
  respondedAt: "2026-10-08T10:14:00.000Z", responseMs: (2 * 60 + 14) * 60_000, autoReplyAt: null,
  jobValueCents: 150_000, currency: "ZAR", enquiryText: "Do you do plumber in Gqeberha?",
  failure: null, createdAt: SENT, responseVia: "email", senderAuth: "unknown", sendUncertain: false, awaitingSync: false, disputed: false, missedConfirmedAt: null,
  ...over,
});

describe("formatting", () => {
  it.each([
    [(2 * 60 + 14) * 60_000, "2 h 14 m"],
    [2 * 3600_000, "2 h"],
    [45 * 60_000, "45 m"],
    [38_000, "38 s"],
    [0, "0 s"],
  ])("%d ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text));
  it("money is R with thousands commas", () => {
    expect(formatMoney(150_000, "ZAR")).toBe("R1,500");
    expect(formatMoney(150_050, "ZAR")).toBe("R1,500.50");
    expect(formatMoney(100_000_000, "ZAR")).toBe("R1,000,000");
  });
});

describe("public sections", () => {
  it("responded and CONFIRMED missed, newest per channel, with the disclosure; no shops → no sections", () => {
    expect(mysteryShopSections([], { audience: "public", nowMs: NOW })).toEqual([]);
    const sections = mysteryShopSections(
      [
        shop(),
        shop({ id: "old", sentAt: "2026-09-01T08:00:00.000Z", responseMs: 60_000 }),
        shop({
          id: "c1", channel: "call", status: "missed", target: PHONE, respondedAt: null, responseMs: null,
          autoReplyAt: "2026-10-08T08:03:00.000Z", missedConfirmedAt: "2026-10-09T10:00:00.000Z",
        }),
      ],
      { audience: "public", nowMs: NOW, timeZone: "Africa/Johannesburg" },
    );
    expect(sections).toEqual([
      {
        key: "speed_to_lead",
        title: "Speed to lead",
        items: [
          {
            channel: "email", outcome: "responded", text: "Responded in 2 h 14 m by email.", note: null,
            disclosure: "This was a response-time test: a plain enquiry sent on 8 Oct 2026.",
          },
          {
            channel: "call", outcome: "missed", text: "No response within 24 h — an estimated R1,500 lead missed.",
            note: "An automatic acknowledgement arrived after 3 m; no person replied within 24 h.",
            disclosure: "This was a response-time test: a plain enquiry sent on 8 Oct 2026.",
          },
        ],
      },
    ]);
  });

  it("never carries the target, the enquiry, the failure or an open/failed shop", () => {
    const shops = [
      shop(),
      shop({ id: "c1", channel: "call", status: "missed", target: PHONE }),
      shop({ id: "w1", channel: "whatsapp", status: "sent", target: PHONE }),
      shop({ id: "f1", channel: "form", status: "failed", target: "https://acme.example/contact", failure: { code: "x", reason: "SECRET-FAILURE" } }),
    ];
    const json = JSON.stringify(mysteryShopSections(shops, { audience: "public", nowMs: NOW }));
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain("acme-plumbing");
    expect(json).not.toContain("829876543");
    expect(json).not.toContain("acme.example");
    expect(json).not.toContain("Gqeberha");
    expect(json).not.toContain("SECRET-FAILURE");
    expect(json).not.toContain("whatsapp");
    expect(json).not.toMatch(/"target"/);
  });

  it("WhatsApp is section 12, on its own", () => {
    const [sec] = mysteryShopSections([shop({ channel: "whatsapp", target: PHONE })], { audience: "public", nowMs: NOW });
    expect(sec).toMatchObject({ key: "whatsapp_response", title: "WhatsApp responsiveness" });
    expect(sec.items[0].text).toBe("Responded in 2 h 14 m on WhatsApp.");
  });
});

describe("member sections", () => {
  it("show the target, and an open shop as waiting", () => {
    const [sec] = mysteryShopSections([shop({ status: "sent", respondedAt: null, responseMs: null })], {
      audience: "member", nowMs: Date.parse("2026-10-08T11:00:00Z"),
    });
    expect(sec.items[0]).toMatchObject({ outcome: "waiting", text: "Waiting for a reply (sent 3 h ago).", target: EMAIL });
  });
});

describe("a public missed claim needs an operator's confirmation", () => {
  const missed = (over: Partial<MemberShop> = {}) => shop({ status: "missed", respondedAt: null, responseMs: null, ...over });
  const pub = (shops: MemberShop[]) => mysteryShopSections(shops, { audience: "public", nowMs: NOW });

  it("an unconfirmed miss is member-only — whatever its flags; a confirmed one is public — whatever its flags", () => {
    for (const flags of [{}, { sendUncertain: true }, { disputed: true }]) {
      expect(pub([missed(flags)])).toEqual([]);
      expect(pub([missed({ ...flags, missedConfirmedAt: "2026-10-09T10:00:00.000Z" })])[0].items[0].outcome).toBe("missed");
    }
    expect(mysteryShopSections([missed()], { audience: "member", nowMs: NOW })[0].items[0]).toMatchObject({
      outcome: "missed", note: "Not confirmed: only confirmed misses appear on the public report.",
    });
  });

  it("a response is public without confirmation, an uncertain send included", () => {
    expect(pub([shop({ sendUncertain: true })])[0].items[0].outcome).toBe("responded");
  });

  it("an unconfirmed miss does not hide an older confirmed one on the channel", () => {
    const older = missed({ id: "old", sentAt: "2026-09-01T08:00:00.000Z", missedConfirmedAt: "2026-09-02T08:00:00.000Z" });
    expect(pub([missed(), older])[0].items[0].disclosure).toContain("1 Sept 2026");
  });

  it("the card asks the operator to check before confirming, and lists the flags", () => {
    const at = Date.parse("2026-10-09T09:00:00Z");
    const check = "Check the inbox, Junk folder and call log before confirming — only confirmed misses appear on the report.";
    expect(shopStatusLine(missed(), at)).toBe(`Email to ${EMAIL} — no reply detected in 24 h. ${check}`);
    expect(shopStatusLine(missed({ disputed: true }), at)).toBe(
      `Email to ${EMAIL} — no reply detected in 24 h (a reply arrived but failed the sender check). ${check}`,
    );
    expect(shopStatusLine(missed({ sendUncertain: true, disputed: true }), at)).toBe(
      `Email to ${EMAIL} — no reply detected in 24 h (a reply arrived but failed the sender check; send uncertain — may not have been delivered). It can't be published as a missed lead.`,
    );
    expect(shopStatusLine(missed({ missedConfirmedAt: "2026-10-09T10:00:00.000Z" }), at)).toBe(
      `Email to ${EMAIL} — no reply in 24 h — R1,500 lead missed (confirmed)`,
    );
    expect(mysteryShopSections([missed({ disputed: true })], { audience: "member", nowMs: NOW })[0].items[0].note).toBe(
      "A reply arrived but failed the sender check. Not confirmed: only confirmed misses appear on the public report.",
    );
  });

  it("the card says when a shop is waiting for the mailbox sync, or its send was uncertain", () => {
    const at = Date.parse("2026-10-09T09:00:00Z");
    const base = { status: "sent" as const, respondedAt: null, responseMs: null };
    expect(shopStatusLine(shop({ ...base, awaitingSync: true }), at)).toBe(
      `Email to ${EMAIL} — 24 h passed; waiting for the mailbox sync to catch up before calling it missed`,
    );
    expect(shopStatusLine(shop({ ...base, sendUncertain: true }), Date.parse("2026-10-08T08:03:00Z"))).toBe(
      `Email to ${EMAIL} — may have been sent 3 m ago (the send did not confirm), waiting for a reply (24 h)`,
    );
  });
});

describe("sender verification (member only)", () => {
  it("the member view says whether the reply's sender was verified; the public view does not change", () => {
    const shops = [shop({ senderAuth: "unknown" }), shop({ id: "c1", channel: "call", target: PHONE, responseVia: "answered", senderAuth: "pass" })];
    const [member] = mysteryShopSections(shops, { audience: "member", nowMs: NOW });
    expect(member.items.map((i) => i.verified)).toEqual(["Reply sender unverified", "Reply sender verified"]);
    const [pub] = mysteryShopSections(shops, { audience: "public", nowMs: NOW });
    expect(pub.items[0]).not.toHaveProperty("verified");
    expect(JSON.stringify(pub)).not.toMatch(/verified|senderAuth|callback/);
    expect(pub.items[0].text).toBe("Responded in 2 h 14 m by email.");
  });
  it("status lines mark an unverified response, e.g. a callback by caller ID", () => {
    const at = Date.parse("2026-10-08T08:03:00Z");
    expect(shopStatusLine(shop({ senderAuth: "unknown" }), at)).toBe(`Email to ${EMAIL} — responded in 2 h 14 m (sender unverified)`);
    expect(shopStatusLine(shop({ channel: "call", target: PHONE, responseVia: "callback", senderAuth: "unknown" }), at)).toBe(
      `Call to ${PHONE} — called back after 2 h 14 m (caller ID unverified)`,
    );
  });
});

describe("status lines", () => {
  const at = Date.parse("2026-10-08T08:03:00Z");
  it.each([
    [{ status: "sent" as const }, `Email to ${EMAIL} — sent 3 m ago, waiting for a reply (24 h)`],
    [{}, `Email to ${EMAIL} — responded in 2 h 14 m (sender unverified)`],
    [{ channel: "call" as const, target: PHONE, responseVia: "answered" as const, senderAuth: "pass" as const }, `Call to ${PHONE} — responded in 2 h 14 m (sender verified)`],
    [{ status: "missed" as const, missedConfirmedAt: "2026-10-09T10:00:00.000Z" }, `Email to ${EMAIL} — no reply in 24 h — R1,500 lead missed (confirmed)`],
    [
      { channel: "call" as const, target: PHONE, status: "refused" as const, failure: { code: "outside_window", reason: "outside calling hours" } },
      `Call to ${PHONE} — refused: outside calling hours`,
    ],
    [{ status: "failed" as const, failure: { code: "smtp", reason: "SMTP rejected" } }, `Email to ${EMAIL} — failed: SMTP rejected`],
  ])("%j", (over, line) => expect(shopStatusLine(shop(over), at)).toBe(line));
});

describe("serializeShop", () => {
  it("ISO-ifies timestamps and keeps only known fields", () => {
    const s = serializeShop("s1", {
      channel: "email", status: "sent", target: EMAIL, sentAt: new Date(SENT), respondedAt: null,
      responseMs: null, autoReplyAt: { toMillis: () => Date.parse(SENT) + 1000 }, jobValueCents: 150_000,
      currency: "ZAR", enquiryText: "x", failure: null, createdAt: new Date(SENT), providerRef: "<m@x>",
    });
    expect(s).toMatchObject({ responseVia: null, senderAuth: null, sendUncertain: false, awaitingSync: false, disputed: false, missedConfirmedAt: null });
    expect(s.sentAt).toBe(SENT);
    expect(s.autoReplyAt).toBe("2026-10-08T08:00:01.000Z");
    expect(s).not.toHaveProperty("providerRef");
  });
});
