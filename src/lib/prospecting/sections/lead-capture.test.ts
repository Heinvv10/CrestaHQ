import { describe, expect, it } from "vitest";
import { detect, run, score, type LeadCaptureRaw } from "./lead-capture";
import { BARE_HOMEPAGE, BUSINESS, RICH_HOMEPAGE } from "./sections.fixture";

const ALL: LeadCaptureRaw = { whatsapp: true, booking: true, contactForm: true, phoneLink: true, chatWidget: true };
const PAGE = "https://www.acme.co.za/";
const codes = (raw: LeadCaptureRaw) => score(raw).findings.map((f) => f.code);

const input = (html: string | null, website = BUSINESS.website) => ({
  business: { ...BUSINESS, website },
  homepage: html === null ? null : { html, url: "https://fixture.example.com/" },
  signal: new AbortController().signal,
  count: () => undefined,
});

describe("lead_capture detect", () => {
  it("finds every route on the rich fixture", () => {
    expect(detect(RICH_HOMEPAGE)).toEqual({ ...ALL, formUrl: null });
  });

  it("finds none on a bare page (a phone number in text is not a tel: link)", () => {
    expect(detect(BARE_HOMEPAGE, PAGE)).toEqual({
      whatsapp: false, booking: false, contactForm: false, phoneLink: false, chatWidget: false, formUrl: null,
    });
  });

  it("recognises each WhatsApp link form", () => {
    for (const href of ["https://wa.me/27415550100", "https://api.whatsapp.com/send?phone=27415550100", "whatsapp://send?phone=1"]) {
      expect(detect(`<a href="${href}">x</a>`).whatsapp).toBe(true);
    }
  });

  it("a form needs an input or textarea after it", () => {
    expect(detect("<form></form>").contactForm).toBe(false);
    expect(detect("<input><form></form>").contactForm).toBe(false);
    expect(detect("<input><textarea></textarea>").contactForm).toBe(false);
    expect(detect("<form><textarea></textarea></form>").contactForm).toBe(true);
  });

  it("booking and chat come from their own tech categories", () => {
    expect(detect(`<script src="https://embed.tawk.to/x"></script>`)).toMatchObject({ chatWidget: true, booking: false });
    expect(detect(`<a href="https://calendly.com/x">Book</a>`)).toMatchObject({ chatWidget: false, booking: true });
  });

  it("tel: links in either quote style", () => {
    expect(detect(`<a href='tel:0415550100'>x</a>`).phoneLink).toBe(true);
  });
});

describe("lead_capture formUrl (the mystery shop's form target)", () => {
  it("is the homepage's final URL when the homepage has the form", () => {
    expect(detect(RICH_HOMEPAGE, "https://www.fixture-plumbing.example.com/?utm=x").formUrl).toBe(
      "https://www.fixture-plumbing.example.com/?utm=x",
    );
  });

  it("else the first same-site contact link, by href or by text", () => {
    const html = (a: string) => `<a href="/about">About</a>${a}<a href="/contact-us">Contact</a>`;
    expect(detect(html(""), PAGE).formUrl).toBe("https://www.acme.co.za/contact-us");
    expect(detect(html(`<a href="/x?a=1&amp;b=2">Get a Quote</a>`), PAGE).formUrl).toBe("https://www.acme.co.za/x?a=1&b=2");
    expect(detect(`<a class="btn" href='kontak.html'>Kontak ons</a>`, PAGE).formUrl).toBe("https://www.acme.co.za/kontak.html");
    expect(detect(`<A HREF=/enquiries>Ask us</A>`, PAGE).formUrl).toBe("https://www.acme.co.za/enquiries");
    expect(detect(`<a href="/p/9"><span>Get in touch</span></a>`, PAGE).formUrl).toBe("https://www.acme.co.za/p/9");
  });

  it("same site means the same registrable domain: www and the bare domain both count", () => {
    expect(detect(`<a href="https://acme.co.za/contact">x</a>`, PAGE).formUrl).toBe("https://acme.co.za/contact");
    expect(detect(`<a href="https://shop.acme.co.za/contact">x</a>`, PAGE).formUrl).toBe("https://shop.acme.co.za/contact");
  });

  it("never another tenant of a hosting platform", () => {
    expect(detect(`<a href="https://evil.wixsite.com/contact">Contact</a>`, "https://acme.wixsite.com/home").formUrl).toBeNull();
    expect(detect(`<a href="https://acme.wixsite.com/contact">Contact</a>`, "https://acme.wixsite.com/home").formUrl).toBe(
      "https://acme.wixsite.com/contact",
    );
  });

  it("never another site, a non-http link or a page that was not fetched", () => {
    for (const a of [
      `<a href="https://other.co.za/contact">Contact</a>`,
      `<a href="https://acme.co.za.evil.com/contact">Contact</a>`,
      `<a href="javascript:openContact()">Contact</a>`,
      `<a href="mailto:info@acme.co.za">Contact us</a>`,
      `<a href="tel:0415550100">Contact</a>`,
      `<a href="ftp://www.acme.co.za/contact">Contact</a>`,
      `<a href="//other.com/contact">Contact</a>`,
      `<a href="http://[::1]/contact">Contact</a>`,
      `<a>Contact</a>`,
    ]) {
      expect(detect(a, PAGE).formUrl, a).toBeNull();
    }
    expect(detect(`<a href="/contact">Contact</a>`).formUrl).toBeNull();
    expect(detect(`<a href="/contact">Contact</a>`, "not a url").formUrl).toBeNull();
  });

  it("skips a bad link and takes the next good one", () => {
    expect(detect(`<a href="https://other.com/contact">Contact</a><a href="/quote">Quote</a>`, PAGE).formUrl).toBe(
      "https://www.acme.co.za/quote",
    );
  });

  it("run() stores it in raw", async () => {
    const out = await run({ ...input(`<a href="/contact">Contact</a>`), homepage: { html: `<a href="/contact">Contact</a>`, url: PAGE } });
    expect(out.raw).toMatchObject({ contactForm: false, formUrl: "https://www.acme.co.za/contact" });
  });
});

describe("lead_capture score", () => {
  it("everything present scores 100 with no findings", () => {
    expect(score(ALL)).toEqual({ score: 100, findings: [] });
  });

  it("each missing route is its own finding and costs 20", () => {
    expect(codes({ ...ALL, whatsapp: false })).toEqual(["no_whatsapp_cta"]);
    expect(codes({ ...ALL, booking: false })).toEqual(["no_booking"]);
    expect(codes({ ...ALL, contactForm: false })).toEqual(["no_contact_form"]);
    expect(codes({ ...ALL, phoneLink: false })).toEqual(["no_phone_link"]);
    expect(codes({ ...ALL, chatWidget: false })).toEqual(["no_chat_widget"]);
    expect(score({ ...ALL, booking: false }).score).toBe(80);
  });
});

describe("lead_capture run", () => {
  it("is unavailable without a website (no_website lives in business_details)", async () => {
    const out = await run(input(null, null));
    expect(out).toMatchObject({ status: "unavailable", findings: [], reason: "No website to inspect." });
  });

  it("is unavailable when the homepage could not be fetched", async () => {
    expect(await run(input(null))).toMatchObject({ status: "unavailable", reason: "The website could not be fetched." });
  });

  it("scores the bare fixture 0 with all five findings", async () => {
    const out = await run(input(BARE_HOMEPAGE));
    expect(out.score).toBe(0);
    expect(out.findings).toHaveLength(5);
  });
});
