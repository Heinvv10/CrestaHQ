/**
 * The ONE loopback rule for the GBP fake-provider fences. Plain JavaScript on
 * purpose: `mode.ts` (the app fence) imports it, and so does
 * `scripts/gbp-fake-guard.mjs` (the deploy fence), which runs before the
 * build — so neither can drift from the other.
 *
 * Takes a WHATWG URL `hostname`, which is already normalised: IPv4 in any
 * spelling (127.1, 0x7f000001, 2130706433, 0177.0.0.1) becomes dotted quad,
 * hosts are lower-cased, and IPv6 is compressed ([0:0:0:0:0:0:0:1] → [::1],
 * [::ffff:127.0.0.1] → [::ffff:7f00:1]).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "[::]" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4-mapped IPv6 inside 127.0.0.0/8.
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
}

/**
 * True only when `url` parses AND its host is loopback.
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isLoopbackUrl(url) {
  try {
    return isLoopbackHostname(new URL(String(url ?? "").trim()).hostname);
  } catch {
    return false;
  }
}
