/**
 * Href rewriting for broadcast click tracking. Pure string work — no
 * Firestore, no secret — so the parser can be tested on its own.
 *
 * Only the `href` of an `<a>` tag is touched, and only its value: the rest
 * of the tag and everything between tags is left byte-for-byte. Quoted,
 * single-quoted and unquoted values, any attribute order and any letter case
 * are understood; a quoted `>` inside another attribute does not end the tag.
 * Anything the parser can't read is left as it was — an untracked link,
 * never a broken one.
 */

/** `<a …>` with attribute values that may contain `>`. Each alternative
 *  starts with a different character class, so there is no backtracking blow-up. */
const A_TAG_RE = /<a(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** One attribute: name, then an optional double-, single- or un-quoted value. */
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the character references an href can carry — `&amp;` between query
 * parameters above all, which is how an escaped merge-tag value arrives.
 * Only terminated references (`&amp;`, `&#38;`, `&#x26;`) are decoded;
 * anything else stays literal.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Rewrite every `<a href>` in `html` through `wrap`. `wrap` gets the decoded
 * href and returns the replacement URL, or null to leave that link alone.
 * The replacement is written double-quoted; it must not contain `"`.
 */
export function rewriteAnchorHrefs(
  html: string,
  wrap: (href: string) => string | null,
): string {
  return html.replace(A_TAG_RE, (tag) => {
    // Attributes sit between "<a" and the closing ">" (or "/>").
    const body = tag.slice(2, -1);
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(body)) !== null) {
      if (m[1]!.toLowerCase() !== "href") continue;
      // The first href wins, as in a browser; no value means no link.
      const raw = m[2] ?? m[3] ?? m[4];
      if (raw === undefined) return tag;
      const replacement = wrap(decodeHtmlEntities(raw));
      if (replacement === null || replacement.includes('"')) return tag;
      const start = 2 + m.index;
      const end = start + m[0].length;
      return `${tag.slice(0, start)}href="${replacement}"${tag.slice(end)}`;
    }
    return tag;
  });
}
