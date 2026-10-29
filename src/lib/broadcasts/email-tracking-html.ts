/**
 * Href rewriting for broadcast click tracking. Pure string work — no
 * Firestore, no secret — so the parser can be tested on its own.
 *
 * One forward pass, in the spirit of the HTML tokenizer: text, comments,
 * tags with their attributes, and the raw-text elements (`<script>`,
 * `<style>`, …) whose content is never markup. Only the `href` of a real
 * `<a>` tag is touched — not one inside a comment, a raw-text element, or
 * another tag's attribute value — and only that attribute is replaced; the
 * rest of the HTML is copied byte for byte. Quoted, single-quoted and
 * unquoted values, any attribute order and any letter case are understood.
 *
 * Linear in the input: every scan starts where the previous one stopped,
 * and an unterminated comment, quote, tag or raw-text element ends the pass
 * there, leaving the rest exactly as it was — an untracked link, never a
 * broken one.
 */

const TAG_NAME_RE = /[A-Za-z][^\s/>]*/y;
const SPACE_RE = /[\s/]*/y;
const ATTR_NAME_RE = /[^\s/>][^\s/>=]*/y;
const EQUALS_RE = /\s*=\s*/y;
const UNQUOTED_RE = /[^\s>]*/y;

/** Elements whose content the tokenizer reads as text, up to the close tag. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

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

/** Escape a value for a double-quoted attribute, so it can't end it. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Match a sticky regex at `pos`: the index just past the match, or -1. */
function matchAt(re: RegExp, html: string, pos: number): number {
  re.lastIndex = pos;
  return re.exec(html) ? re.lastIndex : -1;
}

interface ParsedTag {
  /** Index just past the closing ">". */
  end: number;
  /** The first href attribute: [start, end) of `name=value`, and its raw value. */
  href: { start: number; end: number; raw: string | null } | null;
}

/** Parse the attributes of a tag whose name ends at `pos`; null if unterminated. */
function parseTag(html: string, pos: number): ParsedTag | null {
  let href: ParsedTag["href"] = null;
  for (;;) {
    pos = matchAt(SPACE_RE, html, pos);
    if (pos >= html.length) return null;
    if (html[pos] === ">") return { end: pos + 1, href };
    const nameStart = pos;
    pos = matchAt(ATTR_NAME_RE, html, pos);
    const isHref = html.slice(nameStart, pos).toLowerCase() === "href";
    let raw: string | null = null;
    const afterEquals = matchAt(EQUALS_RE, html, pos);
    if (afterEquals !== -1) {
      pos = afterEquals;
      const quote = html[pos];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, pos + 1);
        if (close === -1) return null;
        raw = html.slice(pos + 1, close);
        pos = close + 1;
      } else {
        const valueStart = pos;
        pos = matchAt(UNQUOTED_RE, html, pos);
        raw = html.slice(valueStart, pos);
      }
    }
    // The first href wins, as in a browser.
    if (isHref && !href) href = { start: nameStart, end: pos, raw };
  }
}

/**
 * Rewrite every `<a href>` in `html` through `wrap`. `wrap` gets the decoded
 * href and returns the replacement URL, or null to leave that link alone.
 * The replacement is written double-quoted and attribute-escaped.
 */
export function rewriteAnchorHrefs(
  html: string,
  wrap: (href: string) => string | null,
): string {
  let out = "";
  let copied = 0;
  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) break;
      pos = close + 3;
      continue;
    }
    const nameEnd = matchAt(TAG_NAME_RE, html, lt + 1);
    if (nameEnd === -1) {
      // A closing tag, a declaration or a stray "<": text as far as we care.
      pos = lt + 1;
      continue;
    }
    const name = html.slice(lt + 1, nameEnd).toLowerCase();
    const tag = parseTag(html, nameEnd);
    if (!tag) break;
    pos = tag.end;

    if (name === "a" && tag.href?.raw != null) {
      const replacement = wrap(decodeHtmlEntities(tag.href.raw));
      if (replacement !== null) {
        out += `${html.slice(copied, tag.href.start)}href="${escapeAttribute(replacement)}"`;
        copied = tag.href.end;
      }
    }
    if (RAW_TEXT.has(name)) {
      // `name` is letters plus whatever the tag-name pattern allowed; only
      // known raw-text names get here, so it is safe inside the pattern.
      const closeRe = new RegExp(`</${name}[\\s/>]`, "gi");
      closeRe.lastIndex = pos;
      const close = closeRe.exec(html);
      if (!close) break;
      pos = close.index;
    }
  }
  return out + html.slice(copied);
}
