import { describe, expect, it } from "vitest";
import {
  allowedTargets, emailDomainTrusted, formMatchDomains, matchTarget, normalizeEmailTarget, normalizeFormUrl,
} from "./targets";

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

  it("whatsapp: the contact's phone in E.164, the same normalisation as a call", () => {
    expect(allowedTargets("whatsapp", contact, "ZA")).toEqual(["+27821234567"]);
    expect(allowedTargets("whatsapp", { phone: "78893" }, "ZA")).toEqual([]);
    expect(allowedTargets("whatsapp", { email: "info@acme.co.za" }, "ZA")).toEqual([]);
    expect(matchTarget("whatsapp", "082 123 4567", ["+27821234567"], "ZA")).toBe("+27821234567");
    expect(matchTarget("whatsapp", "+27821234568", ["+27821234567"], "ZA")).toBeNull();
  });

  it("form has no targets yet", () => {
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

describe("form targets", () => {
  it("normalizeFormUrl: the WHATWG serialisation of an http(s) URL, nothing else", () => {
    expect(normalizeFormUrl(" HTTPS://WWW.Acme.co.za:443/contact?x=1#top ")).toBe("https://www.acme.co.za/contact?x=1#top");
    expect(normalizeFormUrl("https://www.acme.co.za")).toBe("https://www.acme.co.za/");
    for (const bad of [
      "javascript:alert(1)", "file:///etc/passwd", "ftp://acme.co.za/", "data:text/html,x", "/contact", "acme.co.za/contact",
      "https://user:pw@acme.co.za/", `https://acme.co.za/${"x".repeat(2100)}`, 42, null, undefined,
    ]) {
      expect(normalizeFormUrl(bad), String(bad)).toBeNull();
    }
  });

  it("matchTarget(form): only the report's URL, byte-for-byte after normalisation", () => {
    const allowed = ["https://www.acme.co.za/contact"];
    expect(matchTarget("form", "https://WWW.ACME.co.za:443/contact", allowed)).toBe("https://www.acme.co.za/contact");
    expect(matchTarget("form", "https://www.acme.co.za/contact/", allowed)).toBeNull();
    expect(matchTarget("form", "https://www.acme.co.za/contact?x", allowed)).toBeNull();
    expect(matchTarget("form", "http://www.acme.co.za/contact", allowed)).toBeNull();
    expect(matchTarget("form", "https://www.acme.co.za/contact", [])).toBeNull();
  });

  it("formMatchDomains: the form's registrable domain, never a mailbox provider's or an IP", () => {
    expect(formMatchDomains("https://www.acme.co.za/contact")).toEqual(["acme.co.za"]);
    expect(formMatchDomains("https://shop.acme.com/c")).toEqual(["acme.com"]);
    expect(formMatchDomains("https://acme.mweb.co.za/contact")).toEqual([]);
    expect(formMatchDomains("https://acme.outlook.com/")).toEqual([]);
    expect(formMatchDomains("http://203.0.113.9/contact")).toEqual([]);
    expect(formMatchDomains("http://[2001:db8::1]/contact")).toEqual([]);
    // A hosting platform's tenant is its own domain, never the platform's.
    expect(formMatchDomains("https://acme.wixsite.com/contact")).toEqual(["acme.wixsite.com"]);
    expect(formMatchDomains("https://acme.org.za/contact")).toEqual(["acme.org.za"]);
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
