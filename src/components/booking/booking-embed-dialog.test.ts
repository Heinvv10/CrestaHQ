import { expect, it } from "vitest";
import { escapeAttr } from "./booking-embed-dialog";

/**
 * escapeAttr feeds every value dropped into a `"..."`-quoted HTML attribute
 * in the copy-able embed snippets (script src, div ref, iframe src). A
 * booking page name/slug/sub-account id is operator-controlled, not visitor
 * input, but the snippet is still HTML an operator pastes onto their own
 * site — an unescaped `"` would let a crafted slug break out of the
 * attribute and inject markup into their page.
 */

it("escapes & and \" — the two characters that matter inside a double-quoted attribute", () => {
  expect(escapeAttr('a & b " c')).toBe("a &amp; b &quot; c");
});

it("escapes & before \" so a literal &quot; in the input isn't double-escaped into &amp;quot;", () => {
  // Order matters: escaping '"' first, then '&', would turn a literal
  // `&quot;` in the input into `&amp;quot;` — wrong. escapeAttr does '&' first.
  expect(escapeAttr("&quot;")).toBe("&amp;quot;");
});

it("neutralizes the quote that would break out of the attribute — proves the escape is load-bearing", () => {
  // Only the quote can end a "..."-quoted attribute early; a bare `<`/`>`
  // inside an attribute VALUE is inert (the HTML parser doesn't tokenize
  // markup there), so escapeAttr only needs to handle & and ".
  const malicious = '"><script>alert(1)</script>';
  const escaped = escapeAttr(malicious);
  expect(escaped).not.toContain('"');
  expect(`data-x="${escaped}"`).toBe(
    'data-x="&quot;><script>alert(1)</script>"',
  );
});

it("leaves ordinary text (ids, slugs) untouched", () => {
  expect(escapeAttr("sa_9f3c/consult-30min")).toBe("sa_9f3c/consult-30min");
});
