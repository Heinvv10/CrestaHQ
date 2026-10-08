import { describe, expect, it } from "vitest";
import { RESPONSE_WINDOW_MS } from "./model";
import {
  decideEmail,
  isAutoReply,
  isDeliveryReport,
  senderAuthenticated,
  type EmailShopCandidate,
  type InboundEmail,
} from "./email-match";

const SENT = Date.parse("2026-10-08T08:00:00Z");
const NO_HEADERS = { autoSubmitted: null, xAutoreply: null, xAutorespond: null, precedence: null };
const NO_DSN = { contentType: "text/plain", msExchangeNdr: null, failedRecipients: null, text: "" };

const shop = (id: string, target: string, extra: Partial<EmailShopCandidate> = {}): EmailShopCandidate => ({
  id, target, status: "sent", sentAt: new Date(SENT), respondedAt: null, autoReplyAt: null, providerRef: `<${id}@crestahq.com>`,
  targetDomainTrusted: true,
  ...extra,
});
const mail = (from: string, extra: Partial<InboundEmail> = {}): InboundEmail => ({
  from, inReplyTo: null, references: [], autoReply: NO_HEADERS, authResults: [], dsn: NO_DSN, subject: "Re: Enquiry", occurredAtMs: SENT + 2 * 3600_000,
  ...extra,
});
const decide = (m: InboundEmail, shops: EmailShopCandidate[]) => Object.fromEntries(decideEmail(m, shops));

describe("sender match", () => {
  it("the target address itself responds", () => {
    expect(decide(mail("Info@Acme.co.za"), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
  });

  it("another address at the target's domain responds only when that domain is the business's own (website)", () => {
    expect(decide(mail("john@acme.co.za"), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
    // Untrusted (e.g. a gmail address, or a domain unlike the website): the exact address only.
    const untrusted = [shop("s1", "acme@gmail.com", { targetDomainTrusted: false })];
    expect(decide(mail("someone@gmail.com"), untrusted)).toEqual({ s1: "none" });
    expect(decide(mail("acme@gmail.com"), untrusted)).toEqual({ s1: "responded" });
    expect(decide(mail("john@acme.co.za"), [shop("s1", "info@acme.co.za", { targetDomainTrusted: undefined })])).toEqual({ s1: "none" });
  });

  it("a forged In-Reply-To from another sender is ignored", () => {
    const forged = mail("attacker@evil.example", { inReplyTo: "<s1@crestahq.com>", references: ["<s1@crestahq.com>"] });
    expect(decide(forged, [shop("s1", "info@acme.co.za")])).toEqual({ s1: "none" });
  });

  it("a thread match picks the shop among several sender-matching ones", () => {
    const shops = [shop("s1", "info@acme.co.za"), shop("s2", "sales@acme.co.za")];
    expect(decide(mail("john@acme.co.za", { inReplyTo: "<s2@crestahq.com>" }), shops)).toEqual({ s1: "none", s2: "responded" });
    expect(decide(mail("john@acme.co.za", { references: ["<x@y>", "<s1@crestahq.com>"] }), shops)).toEqual({
      s1: "responded", s2: "none",
    });
  });
});

describe("window", () => {
  it("before the send or after 24 h is ignored", () => {
    const s = [shop("s1", "info@acme.co.za")];
    expect(decide(mail("info@acme.co.za", { occurredAtMs: SENT - 1 }), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { occurredAtMs: SENT + RESPONSE_WINDOW_MS + 1 }), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { occurredAtMs: SENT + RESPONSE_WINDOW_MS }), s)).toEqual({ s1: "responded" });
  });

  it("a late-synced reply from inside the window upgrades a missed shop; one from outside does not", () => {
    const missed = [shop("s1", "info@acme.co.za", { status: "missed" })];
    expect(decide(mail("info@acme.co.za"), missed)).toEqual({ s1: "responded" });
    expect(decide(mail("info@acme.co.za", { occurredAtMs: SENT + RESPONSE_WINDOW_MS + 60_000 }), missed)).toEqual({ s1: "none" });
  });

  it("an auto-reply outside the window records nothing", () => {
    const auto = { autoReply: { ...NO_HEADERS, autoSubmitted: "auto-replied" } };
    const s = [shop("s1", "info@acme.co.za")];
    expect(decide(mail("info@acme.co.za", { ...auto, occurredAtMs: SENT - 1 }), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { ...auto, occurredAtMs: SENT + RESPONSE_WINDOW_MS + 1 }), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { ...auto, occurredAtMs: SENT + RESPONSE_WINDOW_MS }), s)).toEqual({ s1: "auto_reply" });
  });

  it("an already-responded shop is not responded again (first wins)", () => {
    expect(decide(mail("info@acme.co.za"), [shop("s1", "info@acme.co.za", { status: "responded" })])).toEqual({ s1: "none" });
  });
});

describe("auto-replies", () => {
  it.each([
    ["Auto-Submitted: auto-replied", { autoSubmitted: "auto-replied" }],
    ["Auto-Submitted: auto-generated", { autoSubmitted: "Auto-Generated" }],
    ["X-Autoreply", { xAutoreply: "yes" }],
    ["X-Autorespond", { xAutorespond: "" }],
    ["Precedence: auto_reply", { precedence: "auto_reply" }],
    ["Precedence: bulk", { precedence: "Bulk" }],
    ["Precedence: junk", { precedence: "junk" }],
  ])("%s is recorded, not counted", (_l, headers) => {
    const m = mail("info@acme.co.za", { autoReply: { ...NO_HEADERS, ...headers } });
    expect(isAutoReply(m)).toBe(true);
    expect(decide(m, [shop("s1", "info@acme.co.za")])).toEqual({ s1: "auto_reply" });
  });

  it.each(["Out of Office: back Monday", "Automatic reply: Enquiry", "Auto-Reply: thanks", "Autoreply", "out-of-office"])(
    "subject %j is an auto-reply",
    (subject) => expect(isAutoReply(mail("x@y.z", { subject }))).toBe(true),
  );

  it("Auto-Submitted: no, Precedence: list and a plain subject are a person", () => {
    expect(isAutoReply(mail("x@y.z", { autoReply: { ...NO_HEADERS, autoSubmitted: "no", precedence: "list" } }))).toBe(false);
    expect(isAutoReply(mail("x@y.z", { subject: "Re: Enquiry: plumber in Gqeberha" }))).toBe(false);
  });

  it("only the first auto-reply is recorded; a missed shop records none", () => {
    const m = mail("info@acme.co.za", { autoReply: { ...NO_HEADERS, autoSubmitted: "auto-replied" } });
    expect(decide(m, [shop("s1", "info@acme.co.za", { autoReplyAt: new Date(SENT + 1) })])).toEqual({ s1: "none" });
    expect(decide(m, [shop("s1", "info@acme.co.za", { status: "missed" })])).toEqual({ s1: "none" });
  });
});

describe("senderAuthenticated (Authentication-Results)", () => {
  const MX = "mx.crestahq.com;";
  it("dmarc=fail anywhere is fail", () => {
    expect(senderAuthenticated([`${MX} dkim=none; spf=pass smtp.mailfrom=x@acme.co.za; dmarc=fail (p=REJECT) header.from=acme.co.za`], "acme.co.za")).toBe("fail");
    expect(senderAuthenticated([`${MX} dkim=pass header.d=acme.co.za`, "other; dmarc=fail header.from=acme.co.za"], "acme.co.za")).toBe("fail");
  });

  it("spf fail/softfail is fail unless an aligned dkim=pass in the same header rescues it (to unknown, never pass)", () => {
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=none`], "acme.co.za")).toBe("fail");
    expect(senderAuthenticated([`${MX} spf=softfail (sender not permitted) smtp.mailfrom=acme.co.za`], "acme.co.za")).toBe("fail");
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=acme.co.za header.s=s1`], "acme.co.za")).toBe("unknown");
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.i=@mail.acme.co.za`], "acme.co.za")).toBe("unknown");
  });

  it("an unaligned dkim=pass (d=attacker.com) does not rescue an spf fail", () => {
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=attacker.com`], "acme.co.za")).toBe("fail");
    // A public suffix is not alignment.
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=co.za`], "acme.co.za")).toBe("fail");
  });

  it("never pass: an email sender is not provable — a topmost dmarc=pass may be the sender's own injected header", () => {
    for (const line of ["dmarc=pass (p=NONE) header.from=acme.co.za", "dkim=pass header.d=acme.co.za", "spf=pass smtp.mailfrom=bounce@acme.co.za"]) {
      expect(senderAuthenticated([`${MX} ${line}`], "acme.co.za")).toBe("unknown");
    }
    // A host that adds no header of its own leaves the sender's injected one on top.
    expect(senderAuthenticated(["attacker.example; dmarc=pass header.from=acme.co.za"], "acme.co.za")).toBe("unknown");
  });

  it("no header is unknown", () => {
    expect(senderAuthenticated([], "acme.co.za")).toBe("unknown");
  });
});

describe("decideEmail with Authentication-Results", () => {
  const auth = (line: string) => ({ authResults: [`mx.crestahq.com; ${line}`] });
  it("a dmarc=fail spoof of the target closes nothing and records nothing — not even an auto-reply", () => {
    const s = [shop("s1", "info@acme.co.za")];
    expect(decide(mail("info@acme.co.za", auth("dmarc=fail header.from=acme.co.za")), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { ...auth("dmarc=fail"), subject: "Out of office" }), s)).toEqual({ s1: "none" });
  });
  it("spf=fail with aligned dkim=pass is accepted", () => {
    expect(decide(mail("info@acme.co.za", auth("spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=acme.co.za")), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
  });
  it("unaligned dkim=pass with spf fail is ignored", () => {
    expect(decide(mail("info@acme.co.za", auth("spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=attacker.com")), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "none" });
  });
  it("no Authentication-Results (unknown) still counts", () => {
    expect(decide(mail("info@acme.co.za", { authResults: [] }), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
  });
});

describe("bounces (delivery-status notifications)", () => {
  const ref = "<s1@crestahq.com>";
  it.each([
    ["multipart/report", { dsn: { ...NO_DSN, contentType: "multipart/report; report-type=delivery-status" } }],
    ["X-MS-Exchange-Message-Is-Ndr", { dsn: { ...NO_DSN, msExchangeNdr: "" } }],
    ["X-Failed-Recipients", { dsn: { ...NO_DSN, failedRecipients: "info@acme.co.za" } }],
    ["a mailer-daemon sender", { from: "MAILER-DAEMON@mx.example" }],
    ["a postmaster sender", { from: "postmaster@acme.co.za" }],
    ["Undeliverable:", { subject: "Undeliverable: Enquiry" }],
    ["Delivery Status Notification", { subject: "Delivery Status Notification (Failure)" }],
    ["Mail delivery failed", { subject: "Mail delivery failed: returning message to sender" }],
    ["Returned mail", { subject: "Returned mail: see transcript for details" }],
    ["Delivery has failed", { subject: "Delivery has failed to these recipients" }],
  ])("%s is a delivery report", (_l, over) => {
    expect(isDeliveryReport(mail("info@acme.co.za", over as Partial<InboundEmail>))).toBe(true);
  });

  it("a report naming our Message-ID (thread headers or body) marks the shop bounced — whatever domain it comes from", () => {
    const s = [shop("s1", "info@acme.co.za"), shop("s2", "info@other.co.za")];
    const viaBody = mail("mailer-daemon@mx.google.com", { dsn: { ...NO_DSN, contentType: "multipart/report", text: `Message-ID: ${ref}` } });
    expect(decide(viaBody, s)).toEqual({ s1: "bounced", s2: "none" });
    expect(decide(mail("postmaster@mx.example", { inReplyTo: ref }), s)).toEqual({ s1: "bounced", s2: "none" });
    expect(decide(mail("mailer-daemon@mx.example", { references: [ref], occurredAtMs: SENT + 3 * RESPONSE_WINDOW_MS }), [shop("s1", "info@acme.co.za", { status: "missed" })])).toEqual({ s1: "bounced" });
  });

  it("a delivery report never counts as a response or an auto-reply, even from the target with no Message-ID", () => {
    const s = [shop("s1", "info@acme.co.za")];
    expect(decide(mail("info@acme.co.za", { subject: "Undeliverable: Enquiry" }), s)).toEqual({ s1: "none" });
    expect(decide(mail("info@acme.co.za", { dsn: { ...NO_DSN, contentType: "multipart/report" }, autoReply: { ...NO_HEADERS, autoSubmitted: "auto-replied" } }), s)).toEqual({ s1: "none" });
  });

  it("a responded shop is never marked bounced", () => {
    expect(decide(mail("mailer-daemon@mx.example", { inReplyTo: ref }), [shop("s1", "info@acme.co.za", { status: "responded" })])).toEqual({ s1: "none" });
  });
});

