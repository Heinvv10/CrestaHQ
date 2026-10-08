import { describe, expect, it } from "vitest";
import { RESPONSE_WINDOW_MS } from "./model";
import {
  decideEmail,
  isAutoReply,
  isPublicMailDomain,
  senderAuthenticated,
  type EmailShopCandidate,
  type InboundEmail,
} from "./email-match";

const SENT = Date.parse("2026-10-08T08:00:00Z");
const NO_HEADERS = { autoSubmitted: null, xAutoreply: null, xAutorespond: null, precedence: null };

const shop = (id: string, target: string, extra: Partial<EmailShopCandidate> = {}): EmailShopCandidate => ({
  id, target, status: "sent", sentAt: new Date(SENT), respondedAt: null, autoReplyAt: null, providerRef: `<${id}@crestahq.com>`,
  ...extra,
});
const mail = (from: string, extra: Partial<InboundEmail> = {}): InboundEmail => ({
  from, inReplyTo: null, references: [], autoReply: NO_HEADERS, authResults: [], subject: "Re: Enquiry", occurredAtMs: SENT + 2 * 3600_000,
  ...extra,
});
const decide = (m: InboundEmail, shops: EmailShopCandidate[]) => Object.fromEntries(decideEmail(m, shops));

describe("sender match", () => {
  it("the target address itself responds", () => {
    expect(decide(mail("Info@Acme.co.za"), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
  });

  it("another address at the business's own domain responds", () => {
    expect(decide(mail("john@acme.co.za"), [shop("s1", "info@acme.co.za")])).toEqual({ s1: "responded" });
  });

  it("a shared public-mailbox domain does NOT domain-match", () => {
    for (const domain of ["gmail.com", "outlook.com", "hotmail.co.uk", "yahoo.co.za", "mweb.co.za", "gmx.de", "icloud.com"]) {
      expect(isPublicMailDomain(domain)).toBe(true);
      expect(decide(mail(`someone@${domain}`), [shop("s1", `acme@${domain}`)])).toEqual({ s1: "none" });
    }
    expect(decide(mail("acme@gmail.com"), [shop("s1", "acme@gmail.com")])).toEqual({ s1: "responded" });
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

  it("spf fail/softfail is fail unless an aligned dkim=pass in the same header rescues it", () => {
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=none`], "acme.co.za")).toBe("fail");
    expect(senderAuthenticated([`${MX} spf=softfail (sender not permitted) smtp.mailfrom=acme.co.za`], "acme.co.za")).toBe("fail");
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=acme.co.za header.s=s1`], "acme.co.za")).toBe("pass");
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.i=@mail.acme.co.za`], "acme.co.za")).toBe("pass");
  });

  it("an unaligned dkim=pass (d=attacker.com) does not rescue an spf fail", () => {
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=attacker.com`], "acme.co.za")).toBe("fail");
    // A public suffix is not alignment.
    expect(senderAuthenticated([`${MX} spf=fail smtp.mailfrom=acme.co.za; dkim=pass header.d=co.za`], "acme.co.za")).toBe("fail");
  });

  it("pass: dmarc=pass, aligned dkim=pass, or spf=pass with an aligned mail-from — from the receiver's (top) header", () => {
    expect(senderAuthenticated([`${MX} dmarc=pass (p=NONE) header.from=acme.co.za`], "acme.co.za")).toBe("pass");
    expect(senderAuthenticated([`${MX} dkim=pass header.d=acme.co.za`], "acme.co.za")).toBe("pass");
    expect(senderAuthenticated([`${MX} spf=pass smtp.mailfrom=bounce@acme.co.za`], "acme.co.za")).toBe("pass");
    expect(senderAuthenticated([`${MX} spf=pass smtp.mailfrom=bounce@mailer.example`], "acme.co.za")).toBe("unknown");
    // A pass claim in a lower (sender-supplied) header is not trusted.
    expect(senderAuthenticated([`${MX} spf=none`, "forged; dmarc=pass header.from=acme.co.za"], "acme.co.za")).toBe("unknown");
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
