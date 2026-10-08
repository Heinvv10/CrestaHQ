/**
 * The message/delivery-status part of a bounce (RFC 3464), read from the raw
 * source for the mystery-shop bounce check (lib/prospecting/mystery-shop/
 * email-match.ts). mailparser folds that part into the message text, where a
 * person's own words could imitate it, so it is found here by MIME structure:
 * inside a multipart/report with report-type=delivery-status, at any depth of
 * multipart nesting (some servers wrap the report in multipart/mixed).
 * Base64 and quoted-printable parts are decoded; capped at 16 KB. "" if none.
 */

const MAX_DEPTH = 4;

const header = (head: string, name: string) =>
  new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, "im").exec(head)?.[1]?.trim() ?? "";

function decode(body: string, encoding: string): string {
  if (/^base64$/i.test(encoding)) return Buffer.from(body, "base64").toString("utf8");
  if (/^quoted-printable$/i.test(encoding)) {
    const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

export function deliveryStatusPart(source: string, contentType: string | null, depth = 0): string {
  const ct = contentType?.trim() ?? "";
  const boundary = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(ct)?.[1];
  if (!boundary || !/^multipart\//i.test(ct) || depth > MAX_DEPTH) return "";
  const report = /^multipart\/report\b/i.test(ct) && /report-type\s*=\s*"?delivery-status\b/i.test(ct);
  // Whole boundary lines only (boundary "b1" must not split "--b10"); the body may start with the first one.
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(String.raw`\r?\n--${escaped}(?:--)?[ \t]*(?=\r?\n|$)`);
  for (const part of `\r\n${source}`.split(line).slice(1)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split === -1) continue;
    const head = part.slice(0, split).replace(/\r?\n[ \t]+/g, " ");
    const body = part.slice(split).trim();
    const partType = header(head, "content-type");
    if (report && /^message\/(global-)?delivery-status\b/i.test(partType)) {
      return decode(body, header(head, "content-transfer-encoding")).trim().slice(0, 16384);
    }
    if (/^multipart\//i.test(partType)) {
      const nested = deliveryStatusPart(body, partType, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
}
