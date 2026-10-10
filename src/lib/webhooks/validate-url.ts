import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Which automation tool a webhook destination URL belongs to, when it's
 * recognizable. Powers tool-specific advice — most importantly n8n's
 * test-vs-production URL trap: the Test URL (`…/webhook-test/…`) only
 * receives events while the n8n editor is actively listening ("Execute
 * workflow"); the Production URL (`…/webhook/…`, same path otherwise) only
 * responds once the workflow's Active toggle is on. A webhook registered
 * against the Test URL verifies fine in the moment and then silently dies.
 */
export interface AutomationUrlInfo {
  tool: "n8n" | "make" | "zapier" | null;
  /** Only set for n8n-shaped URLs. */
  n8nKind?: "test" | "production";
}

export function detectAutomationUrl(raw: string): AutomationUrlInfo {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { tool: null };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // `/webhook-test/` is unique to n8n regardless of hostname (self-hosted
  // instances rarely advertise "n8n" in the domain).
  if (path.includes("/webhook-test/")) {
    return { tool: "n8n", n8nKind: "test" };
  }
  if (path.includes("/webhook/") && (host.includes("n8n") || /\/webhook\/[0-9a-f-]{20,}/.test(path))) {
    return { tool: "n8n", n8nKind: "production" };
  }
  if (/^hook\.[a-z0-9-]+\.make\.com$/.test(host)) return { tool: "make" };
  if (host === "hooks.zapier.com") return { tool: "zapier" };
  return { tool: null };
}

/** The n8n Production URL for a given n8n Test URL (same path, different segment). */
export function n8nProductionUrl(testUrl: string): string {
  return testUrl.replace("/webhook-test/", "/webhook/");
}

/**
 * Destination-URL validation for outbound webhook subscriptions — shared by
 * the management API route and the AI Suite's create_webhook capability so
 * both enforce identical rules:
 *   - http/https only (https required in production, except localhost)
 *   - private / loopback hostnames and IP literals rejected in production
 *     (SSRF guard; string-level only — `validatePublicUrl` also resolves DNS)
 */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "URL must use http or https." };
    }
    if (
      url.protocol === "http:" &&
      process.env.NODE_ENV === "production" &&
      !url.hostname.endsWith(".localhost") &&
      url.hostname !== "localhost"
    ) {
      return { ok: false, error: "Production URLs must use https." };
    }
    // Block private + loopback hosts in production to prevent SSRF.
    if (ssrfGuardEnabled() && isBlockedHostname(url.hostname)) {
      return { ok: false, error: "Private / loopback hostnames are not allowed." };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
}

/**
 * The SSRF guard is production-only, like the https rule above: local dev
 * points webhooks at localhost receivers on purpose.
 */
export function ssrfGuardEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * True for any IP address outside public unicast space: loopback, private,
 * link-local, CGNAT 100.64/10 (Tailscale), unspecified, multicast, broadcast,
 * reserved, and every IPv6 form that embeds an IPv4 address (mapped, NAT64,
 * 6to4, Teredo) — those are refused outright rather than unwrapped.
 * Unparseable input counts as non-public.
 */
export function isNonPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  return ipaddr.parse(ip).range() !== "unicast";
}

/**
 * String-level check on a URL hostname (as `new URL` yields it, so decimal /
 * octal / hex IPv4 forms have already been normalised to dotted quads and
 * IPv6 literals carry brackets). Names are NOT resolved here — see
 * `resolvePublicAddresses` for that.
 */
export function isBlockedHostname(hostname: string): boolean {
  // One trailing dot is the fully-qualified spelling of the same name.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return ipaddr.isValid(h) && isNonPublicAddress(h);
}

export class NonPublicUrlError extends Error {
  constructor(hostname: string) {
    super(`Refused: ${hostname} is not a public internet address.`);
    this.name = "NonPublicUrlError";
  }
}

/**
 * Names resolve through c-ares, not `dns.lookup`: on velo-server glibc's
 * getaddrinfo (A+AAAA via the systemd-resolved stub, on the libuv threadpool)
 * stalls 5–20 s under concurrent lookups, while direct queries answer in ms.
 * c-ares skips /etc/hosts — stricter for SSRF, and `localhost`-style names are
 * already refused by `isBlockedHostname`. Uses the system's configured servers.
 */
const resolver = new Resolver({ timeout: 2000, tries: 2 });

/**
 * Test-only: point the resolver at a local DNS server so tests exercise real
 * c-ares behaviour. Production never calls this and keeps the system servers.
 */
export function setResolverServersForTest(servers: string[]): void {
  resolver.setServers(servers);
}

/** A then AAAA answers, IPv4 first (this host has no IPv6 route). */
async function resolveName(h: string): Promise<LookupAddress[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(h), resolver.resolve6(h)]);
  // A transient A-record failure (ETIMEOUT, ESERVFAIL, ECONNREFUSED, ...) is
  // not "no such record" (ENODATA / ENOTFOUND) — a v6-only answer under a
  // transient v4 failure must not stand in for a real v4 lookup: this host
  // has no IPv6 route, so that answer is unreachable, and a transient DNS
  // failure should not pass the save-time check.
  if (
    v4.status === "rejected" &&
    !["ENODATA", "ENOTFOUND"].includes((v4.reason as NodeJS.ErrnoException)?.code ?? "")
  ) {
    throw v4.reason;
  }
  const addresses: LookupAddress[] = [
    ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (!addresses.length) {
    if (v4.status === "rejected") throw v4.reason;
    if (v6.status === "rejected") throw v6.reason;
    throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
  }
  return addresses;
}

/**
 * Resolve `hostname` and return its addresses only when EVERY one is public.
 * Throws `NonPublicUrlError` otherwise (a single private answer among public
 * ones is enough to refuse — the connection could land on either).
 */
export async function resolvePublicAddresses(
  hostname: string,
): Promise<LookupAddress[]> {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(h)) throw new NonPublicUrlError(h);
  const addresses = ipaddr.isValid(h)
    ? [{ address: h, family: h.includes(":") ? 6 : 4 }]
    : await resolveName(h);
  if (!addresses.length || addresses.some((a) => isNonPublicAddress(a.address))) {
    throw new NonPublicUrlError(h);
  }
  return addresses;
}

/**
 * `lookup` for `http(s).request` / an `https.Agent`: the guard runs on the
 * addresses the socket actually connects to, so a name that answered public
 * at save time and private now (DNS rebinding) is still refused.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  resolvePublicAddresses(hostname).then(
    (list) => {
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    },
    (err: NodeJS.ErrnoException) => callback(err, "", 4),
  );
};

/**
 * Save-time form of the guard: `validateWebhookUrl` plus, in production, a
 * DNS resolution that must yield only public addresses. Callers that fetch
 * the URL later must still go through `publicFetch` — resolution can change.
 */
export async function validatePublicUrl(
  raw: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const check = validateWebhookUrl(raw);
  if (!check.ok || !ssrfGuardEnabled()) return check;
  try {
    await resolvePublicAddresses(new URL(check.url).hostname);
    return check;
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof NonPublicUrlError
          ? "That URL points at a private or internal address."
          : "That URL's hostname could not be resolved.",
    };
  }
}
