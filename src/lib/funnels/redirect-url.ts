import { publicHttpsUrl } from "@/lib/funnels/image-url";

/**
 * A funnel's stored thank-you redirect as it may be written into the page's
 * `<meta http-equiv="refresh">` and its "go now" link: https on a public
 * host, and none of the characters that could end or re-quote the refresh's
 * `url=` value (quotes, backslash, whitespace, control characters). The save
 * route only checks the https prefix, so this runs on read. Else null.
 */
export function funnelRedirectUrl(v: unknown): string | null {
  return publicHttpsUrl(v, /["'\\\s\u0000-\u001f\u007f]/);
}
