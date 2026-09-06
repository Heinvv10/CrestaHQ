/** Sentinel origin. Never reachable; only used to resolve a relative path. */
const PROBE_ORIGIN = "http://redirect.invalid";

/**
 * Where to land after a successful sign-in.
 *
 * `?redirect` is attacker-supplied — /login is a public path, so anyone can
 * hand a victim `https://crm.crestahq.com/login?redirect=…`.
 *
 * PARSE, do not pattern-match. A prefix blacklist (`startsWith("//")` and
 * friends) inspects the raw string while the browser parses a NORMALISED one:
 * WHATWG strips ASCII tab, LF and CR from anywhere in a URL before parsing, so
 * `/<TAB>/evil.com` slips past a `//` check and then resolves to
 * `https://evil.com`. Five such bypasses existed in the first version of this
 * guard. Resolving against a sentinel origin normalises exactly as the browser
 * does, so every one of them collapses into the origin comparison below.
 *
 * Returns a same-origin, root-relative path, or the dashboard.
 */
export function safeRedirect(value: string | null | undefined): string {
  if (!value) return "/dashboard";
  try {
    const url = new URL(value, PROBE_ORIGIN);
    // Anything that changed origin was absolute, protocol-relative, or used a
    // scheme — none of which may steer a post-login navigation.
    if (url.origin !== PROBE_ORIGIN) return "/dashboard";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/dashboard";
  }
}
