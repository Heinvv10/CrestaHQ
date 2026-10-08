import { describe, expect, it } from "vitest";
import { allowedTargets, emailDomainTrusted, matchTarget, normalizeEmailTarget } from "./targets";

const contact = { email: " Info@Acme.co.za ", phone: "082 123 4567" };

describe("allowedTargets", () => {
  it("email: the contact's own address, lower-cased", () => {
    expect(allowedTargets("email", contact)).toEqual(["info@acme.co.za"]);
    expect(allowedTargets("email", { email: "not-an-email" })).toEqual([]);
    expect(allowedTargets("email", {})).toEqual([]);
  });

  it("call: the contact's phone in E.164, a bare national number read in the workspace country", () => {
    expect(allowedTargets("call", contact, "ZA")).toEqual(["+27821234567"]);
    expect(allowedTargets("call", { phone: "+27 82 123 4567" })).toEqual(["+27821234567"]);
    expect(allowedTargets("call", { phone: "78893" }, "ZA")).toEqual([]);
  });

  it("whatsapp and form have no targets yet", () => {
    expect(allowedTargets("whatsapp", contact, "ZA")).toEqual([]);
    expect(allowedTargets("form", contact, "ZA")).toEqual([]);
  });
});

describe("matchTarget", () => {
  it("accepts the same value in another spelling, refuses anything else", () => {
    expect(matchTarget("email", "INFO@acme.co.za", ["info@acme.co.za"])).toBe("info@acme.co.za");
    expect(matchTarget("email", "sales@acme.co.za", ["info@acme.co.za"])).toBeNull();
    expect(matchTarget("call", "+27 82 123 4567", ["+27821234567"], "ZA")).toBe("+27821234567");
    expect(matchTarget("call", "0821234567", ["+27821234567"], "ZA")).toBe("+27821234567");
    expect(matchTarget("call", "+27821234568", ["+27821234567"], "ZA")).toBeNull();
    expect(matchTarget("email", 42, ["info@acme.co.za"])).toBeNull();
    expect(matchTarget("email", "info@acme.co.za", [])).toBeNull();
  });
});

describe("emailDomainTrusted", () => {
  it("is the business's own domain: the same as its website, minus www., subdomains either way", () => {
    expect(emailDomainTrusted("info@acme.co.za", "https://www.acme.co.za/contact")).toBe(true);
    expect(emailDomainTrusted("info@acme.co.za", "acme.co.za")).toBe(true);
    expect(emailDomainTrusted("info@mail.acme.co.za", "https://acme.co.za")).toBe(true);
    expect(emailDomainTrusted("info@acme.co.za", "http://shop.acme.co.za")).toBe(true);
  });
  it("is not trusted for a free mailbox, another domain, a lookalike or no website", () => {
    expect(emailDomainTrusted("acme@gmail.com", "https://acme.co.za")).toBe(false);
    expect(emailDomainTrusted("info@notacme.co.za", "https://acme.co.za")).toBe(false);
    expect(emailDomainTrusted("info@acme.co.za.evil.com", "https://acme.co.za")).toBe(false);
    expect(emailDomainTrusted("info@acme.co.za", null)).toBe(false);
    expect(emailDomainTrusted("info@acme.co.za", "not a url %%")).toBe(false);
  });
});

describe("strict email targets (no parser differential with the SMTP send)", () => {
  it.each(["info@evil.com(x).biz.co.za", "info(c)@biz.co.za", '"x"@biz.co.za', "a b@biz.co.za", "a:b@biz.co.za", "info@localhost", "info@biz..co.za", "<info@biz.co.za>", "a@b.co, c@d.co"])(
    "%j is refused",
    (raw) => expect(normalizeEmailTarget(raw)).toBeNull(),
  );
  it.each([["Info@Acme.co.za", "info@acme.co.za"], ["first.last+tag@sub.acme-co.co.za", "first.last+tag@sub.acme-co.co.za"]])(
    "%j is accepted",
    (raw, want) => expect(normalizeEmailTarget(raw)).toBe(want),
  );
});

describe("mailbox providers are never a trusted business domain", () => {
  it.each([
    ["biz@mweb.co.za", "http://biz.mweb.co.za"],
    ["biz@telkomsa.net", "users.telkomsa.net/biz"],
    ["info@gmail.com", "gmail.com"],
    ["info@hotmail.co.uk", "https://hotmail.co.uk"],
    ["me@biz.afrihost.co.za", "https://biz.afrihost.co.za"],
  ])("%s with website %s is untrusted", (email, website) => {
    expect(emailDomainTrusted(email, website)).toBe(false);
  });
});
