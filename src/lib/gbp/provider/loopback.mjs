/**
 * Loopback rules for the two GBP fake-provider fences — TWO rules, one
 * containing the other, kept side by side so they cannot drift:
 *
 *  - APP allow-list (`isAppLoopbackUrl`, used by mode.ts): the fake may run
 *    only on exactly 127.0.0.1, localhost or [::1]. Narrow on purpose.
 *  - DEPLOY block-list (`isLoopbackHostname`, used by
 *    scripts/gbp-fake-guard.mjs): refuses a much wider set, a superset of the
 *    app list (loopback.test.ts asserts that).
 *
 * Plain JavaScript on purpose: the deploy guard runs before the build.
 *
 * Takes a WHATWG URL `hostname`, which is already normalised: IPv4 in any
 * spelling (127.1, 0x7f000001, 2130706433, 0177.0.0.1) becomes dotted quad,
 * hosts are lower-cased, and IPv6 is compressed ([0:0:0:0:0:0:0:1] → [::1],
 * [::ffff:127.0.0.1] → [::ffff:7f00:1]).
 *
 * The DEPLOY block-list.
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

/** The hosts on which the APP may run the fake (WHATWG-normalised). */
export const APP_LOOPBACK_HOSTNAMES = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The APP allow-list: true only when `url` parses AND its hostname is exactly
 * one of APP_LOOPBACK_HOSTNAMES. (127.1 or [0:…:1] still qualify — WHATWG
 * normalises them onto the list; 0.0.0.0, 127.0.0.2, *.localhost do not.)
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isAppLoopbackUrl(url) {
  let hostname;
  try {
    hostname = new URL(String(url ?? "").trim()).hostname;
  } catch {
    return false;
  }
  return APP_LOOPBACK_HOSTNAMES.includes(hostname);
}
