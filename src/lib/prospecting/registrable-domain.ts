import { getDomain } from "tldts";

/**
 * The registrable domain of a host name, from the Public Suffix List with
 * its private section (`tldts`): `www.acme.co.za` → `acme.co.za`, and a
 * hosting platform's tenant is its own site (`acme.wixsite.com`, never
 * `wixsite.com`). Null for a host with none: an IP address, `localhost`, a
 * bare public suffix. Lower-cased, a trailing dot dropped. Pure — imported by
 * sections/lead-capture.ts, which scripts load under plain Node.
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host.toLowerCase().replace(/\.$/, ""), { allowPrivateDomains: true });
}

/** Same site: one registrable domain. A host without one matches only itself. */
export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  if (da === null || db === null) return a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");
  return da === db;
}
