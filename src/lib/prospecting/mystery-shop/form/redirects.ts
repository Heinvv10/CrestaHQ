import { sameSite } from "@/lib/prospecting/registrable-domain";

/**
 * Which redirects the form engine may follow after the enquiry was posted,
 * and what counts as the form page itself. Pure.
 */

export const httpish = (u: URL) => u.protocol === "http:" || u.protocol === "https:";

/** A refused port, like a refused address: never connected to. */
export const portOk = (u: URL, allow: string[] | undefined) => u.port === "" || (allow ?? []).includes(u.port);

/**
 * The form page itself, whatever its query or fragment: going back to it
 * (`/contact?error=1`) is the classic validation-error redirect, never a
 * confirmation.
 */
export function samePage(a: string, b: string | null): boolean {
  if (!b) return false;
  const path = (u: string) => {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/$/, "")}`;
  };
  return path(a) === path(b);
}

/**
 * A redirect the enquiry may follow — re-POSTed, same body, for ONE hop:
 * a 307 / 308, or a 301 / 302 to the same path and query with only the
 * scheme, the host (same site) or a trailing slash changed. Any other 3xx
 * answer to the enquiry is not followed and never confirms anything.
 */
export function repostable(status: number, from: URL, to: URL): boolean {
  if (status === 307 || status === 308) return true;
  const loose = (u: URL) => `${u.pathname.replace(/\/+$/, "")}${u.search}`;
  return (status === 301 || status === 302) && loose(from) === loose(to) && sameSite(from.hostname, to.hostname);
}

/**
 * Post-redirect-get: a 302 / 303 from the enquiry to ANOTHER path (any
 * query), on the form's own site or a known form backend (`known`), and
 * never to the site's root — a bounce to the homepage proves nothing.
 * Followed with one GET.
 */
export function postRedirectGet(status: number, from: URL, to: URL, known: (host: string) => boolean): boolean {
  const path = (u: URL) => u.pathname.replace(/\/+$/, "");
  return (status === 302 || status === 303) && path(from) !== path(to) && path(to) !== "" && known(to.hostname);
}
