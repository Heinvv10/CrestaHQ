import { describe, expect, it } from "vitest";
import { renderSystemEmail } from "./system-email";

const brand = { name: "Acme", logoUrl: null, supportEmail: "help@acme.test" };

describe("renderSystemEmail", () => {
  it("escapes caller text everywhere it lands in the HTML", () => {
    const { html } = renderSystemEmail({
      brand: { ...brand, name: "<b>Evil</b>" },
      preview: "<script>p</script>",
      heading: "<img src=x>",
      paragraphs: ['Hi "<i>you</i>"'],
      button: { label: "<u>Go</u>", url: 'https://x.test/?a=1&b="2"' },
      note: "<em>n</em>",
    });
    expect(html).not.toMatch(/<(script|img src=x|i>|u>|em>|b>Evil)/);
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });

  it("renders **bold** spans in HTML and strips the markers in text", () => {
    const { html, text } = renderSystemEmail({
      brand,
      preview: "p",
      heading: "h",
      paragraphs: ["Join **Team One** now"],
    });
    expect(html).toMatch(/<strong[^>]*>Team One<\/strong>/);
    expect(text).toContain("Join Team One now");
    expect(text).not.toContain("**");
  });

  it("puts the button URL in the plain-text twin", () => {
    const { text } = renderSystemEmail({
      brand,
      preview: "p",
      heading: "Reset your password",
      paragraphs: ["x"],
      button: { label: "Choose a new password", url: "https://app.test/login?oobCode=abc" },
    });
    expect(text).toContain("Choose a new password: https://app.test/login?oobCode=abc");
    expect(text.startsWith("Reset your password")).toBe(true);
  });

  it("omits the button block when there is no button", () => {
    const { html } = renderSystemEmail({ brand, preview: "p", heading: "h", paragraphs: ["x"] });
    expect(html).not.toContain("Paste this link");
  });

  it("uses the logo only when it is an https URL", () => {
    const withLogo = renderSystemEmail({
      brand: { ...brand, logoUrl: "https://cdn.test/logo.png" },
      preview: "p",
      heading: "h",
      paragraphs: [],
    }).html;
    expect(withLogo).toContain('<img src="https://cdn.test/logo.png"');
    for (const logoUrl of ["http://cdn.test/logo.png", "javascript:alert(1)"]) {
      const html = renderSystemEmail({ brand: { ...brand, logoUrl }, preview: "p", heading: "h", paragraphs: [] }).html;
      expect(html).not.toContain("<img");
      expect(html).toContain(">A</td>");
    }
  });

  it("names the support address in the footer when there is one", () => {
    const withSupport = renderSystemEmail({ brand, preview: "p", heading: "h", paragraphs: [] });
    expect(withSupport.html).toContain("mailto:help@acme.test");
    expect(withSupport.text).toContain("help@acme.test");
    const without = renderSystemEmail({ brand: { name: "Acme" }, preview: "p", heading: "h", paragraphs: [] });
    expect(without.html).not.toContain("mailto:");
  });
});
