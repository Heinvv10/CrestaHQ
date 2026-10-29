import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, rewriteAnchorHrefs } from "./email-tracking-html";

/**
 * The rewriter runs over an admin-authored email body. It must find every
 * real link however the HTML spells it, change nothing but the href value,
 * and leave anything it can't read exactly as it was.
 */

const seen: string[] = [];
const wrapAll = (href: string) => {
  seen.push(href);
  return `https://app.test/t/c/${seen.length}`;
};
const run = (html: string) => {
  seen.length = 0;
  return rewriteAnchorHrefs(html, wrapAll);
};

describe("rewriteAnchorHrefs", () => {
  it("rewrites double-quoted, single-quoted and unquoted values", () => {
    expect(run(`<a href="https://a.test/1">A</a>`)).toBe(`<a href="https://app.test/t/c/1">A</a>`);
    expect(run(`<a href='https://a.test/1'>A</a>`)).toBe(`<a href="https://app.test/t/c/1">A</a>`);
    expect(run(`<a href=https://a.test/1>A</a>`)).toBe(`<a href="https://app.test/t/c/1">A</a>`);
    expect(seen).toEqual(["https://a.test/1"]);
  });

  it("finds href in any letter case and any attribute order, keeping the other attributes", () => {
    const out = run(
      `<A class="btn" style="color:red" HREF="https://a.test/x" target=_blank>Go</A>`,
    );
    expect(out).toBe(
      `<A class="btn" style="color:red" href="https://app.test/t/c/1" target=_blank>Go</A>`,
    );
  });

  it("is not fooled by a '>' or an 'href=' inside another attribute's value", () => {
    const out = run(`<a title="a > b href=https://evil.test" href="https://a.test/real">x</a>`);
    expect(seen).toEqual(["https://a.test/real"]);
    expect(out).toBe(`<a title="a > b href=https://evil.test" href="https://app.test/t/c/1">x</a>`);
  });

  it("decodes entities before handing the href over", () => {
    run(`<a href="https://a.test/p?x=1&amp;y=2&#38;z=3&#x26;w=4">x</a>`);
    expect(seen).toEqual(["https://a.test/p?x=1&y=2&z=3&w=4"]);
  });

  it("ignores data-href, <abbr>, <area> and text that only looks like a link", () => {
    const html = `<span data-href="https://a.test">s</span><abbr title="t">x</abbr><area href="https://a.test/m"> see https://a.test/plain`;
    expect(run(html)).toBe(html);
    expect(seen).toEqual([]);
  });

  it("uses the first href only, as a browser does", () => {
    expect(run(`<a href="https://a.test/1" href="https://a.test/2">x</a>`)).toBe(
      `<a href="https://app.test/t/c/1" href="https://a.test/2">x</a>`,
    );
  });

  it("leaves a link alone when wrap declines it, and an anchor with no href", () => {
    const html = `<a href="mailto:x@y.test">m</a><a name="top">t</a><a href>e</a>`;
    expect(rewriteAnchorHrefs(html, () => null)).toBe(html);
    expect(run(`<a name="top">t</a><a href>e</a>`)).toBe(`<a name="top">t</a><a href>e</a>`);
  });

  it("leaves an unterminated tag and the text around anchors byte-for-byte", () => {
    const broken = `Hi<br>\n<a href="https://a.test/1>never closed`;
    expect(run(broken)).toBe(broken);
    const html = `Hi &amp; welcome<br><a href="https://a.test">x</a> — bye<br>`;
    expect(run(html)).toBe(`Hi &amp; welcome<br><a href="https://app.test/t/c/1">x</a> — bye<br>`);
  });

  it("never writes a replacement that would break out of the attribute", () => {
    const html = `<a href="https://a.test">x</a>`;
    expect(rewriteAnchorHrefs(html, () => `https://x.test/" onclick="alert(1)`)).toBe(html);
  });

  it("handles self-closing and newline-separated attributes", () => {
    expect(run(`<a\nhref="https://a.test/1"\n/>`)).toBe(`<a\nhref="https://app.test/t/c/1"\n/>`);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes terminated named and numeric references and leaves the rest", () => {
    expect(decodeHtmlEntities("a&amp;b&lt;&gt;&quot;&apos;&#65;&#x42;")).toBe(`a&b<>"'AB`);
    expect(decodeHtmlEntities("a&ampb &unknown; &#0; &#xZZ;")).toBe("a&ampb &unknown; &#0; &#xZZ;");
  });
});
