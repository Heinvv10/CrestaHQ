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

it("escapes & before \" — escaping \" first would double-escape the & that step just introduced", () => {
  // '&"' has both a literal '&' and a literal '"'. Escaping '&' first, then
  // '"': "&" -> "&amp;", then the '"' -> "&quot;" => "&amp;&quot;" (correct).
  // Escaping '"' first, then '&': the '"' -> "&quot;" first, giving
  // '&&quot;' — THEN the '&' step also escapes the '&' that step just
  // introduced inside "&quot;", producing "&amp;&amp;quot;" (wrong,
  // double-escaped). The two orders disagree only on an input carrying
  // both characters, which is why "&quot;" alone (no real quote in it)
  // can't tell them apart.
  expect(escapeAttr('&"')).toBe("&amp;&quot;");
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
