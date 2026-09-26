import "server-only";

import { publicFetch } from "@/lib/webhooks/public-fetch";
import type { GetLeadsBusiness } from "@/types/get-leads";

/**
 * Get Leads contact enrichment: Places has no email or social fields, so we
 * read each business's homepage and pull the first plausible email (the
 * site's own domain preferred) plus Facebook / Instagram profile links.
 *
 * The website is owner-controlled text, so every hop goes through
 * `publicFetch` (public addresses only in production, checked at connect
 * time; redirects are followed here, one guarded hop at a time). Any failure
 * just leaves that row without contacts — enrichment never fails a search.
 */

export const ENRICH_CONCURRENCY = 6;
export const HOMEPAGE_MAX_BYTES = 500 * 1024;
// Overall deadline for one enrichBusinesses call, regardless of how many
// sites it has to enrich or how long the process-wide queue is. Without
// this, one tenant's large search queues every other tenant's search behind
// it with no bound (the per-site timeout only starts once a slot is held).
export const ENRICH_DEADLINE_MS = 30_000;
const SITE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; LeadStack-GetLeads/1.0; CRM contact lookup)";

export interface SiteContacts {
  email: string | null;
  facebook: string | null;
  instagram: string | null;
}

export async function enrichBusinesses(
  businesses: GetLeadsBusiness[],
  signal?: AbortSignal,
  deadlineMs: number = ENRICH_DEADLINE_MS,
): Promise<GetLeadsBusiness[]> {
  // One deadline per call: the caller's own abort (e.g. a disconnected
  // client) combined with a hard ceiling, so this call can never wait
  // longer than deadlineMs no matter how deep the shared queue is.
  const deadline = AbortSignal.any(
    signal ? [AbortSignal.timeout(deadlineMs), signal] : [AbortSignal.timeout(deadlineMs)],
  );
  return Promise.all(
    businesses.map(async (b) => {
      if (!b.website) return b;
      const website = b.website;
      const page = await withFetchSlot(() => fetchHomepage(website, deadline), deadline);
      if (!page) return b;
      const found = extractContacts(page.html, page.url);
      return {
        ...b,
        email: b.email ?? found.email,
        facebook: b.facebook ?? found.facebook,
        instagram: b.instagram ?? found.instagram,
      };
    }),
  );
}

// createFetchSlots(limit) is a process-wide cap: every caller of one
// instance — however many run at once — shares its slots. Get Leads
// enrichment has its own instance (ENRICH_CONCURRENCY); prospect reports have
// a separate one, so neither can starve the other. A slot is handed
// straight to the next waiter (FIFO) on release. The per-site timeout starts
// only once a slot is held, so queued sites never time out while waiting —
// instead, a waiter that is still queued when its call's deadline fires
// leaves the queue immediately (no slot leak, no stale waiter woken later).
// A slot handed over in the same tick the deadline fires still runs fn, whose
// fetch is refused at once on the aborted signal (at worst one abandoned DNS
// lookup) and the slot releases in `finally`.
export function createFetchSlots(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  function release(): void {
    const next = queue.shift();
    if (next) next();
    else active--;
  }

  // Resolves true once a slot is handed to this waiter, or false if the
  // deadline fires first — removing this waiter from the queue so a later
  // release never hands a slot to a caller that already gave up.
  function waitForSlot(deadline: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry = () => {
        deadline.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        resolve(false);
      };
      queue.push(entry);
      deadline.addEventListener("abort", onAbort, { once: true });
    });
  }

  return async function withSlot<T>(fn: () => Promise<T>, deadline: AbortSignal): Promise<T | null> {
    if (deadline.aborted) return null;
    if (active < limit) {
      active++;
    } else if (!(await waitForSlot(deadline))) {
      // Deadline fired while queued — this waiter never held a slot, so
      // there is nothing to release.
      return null;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const withFetchSlot = createFetchSlots(ENRICH_CONCURRENCY);

function httpUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function fetchHomepage(
  website: string,
  deadline: AbortSignal,
  maxBytes: number = HOMEPAGE_MAX_BYTES,
  timeoutMs: number = SITE_TIMEOUT_MS,
): Promise<{ html: string; url: string } | null> {
  let url = httpUrl(website);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      const res = await publicFetch(url.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal,
        maxBytes,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = httpUrl(location, url.href);
        continue;
      }
      return res.ok ? { html: await res.text(), url: url.href } : null;
    }
    return null;
  } catch {
    // Refused (non-public address), timed out, too large, TLS, DNS — the row
    // simply stays without contacts.
    return null;
  }
}

// Email extraction is linear in the page size: rather than one unanchored
// regex (`[local]+@domain` backtracks quadratically over a long run of
// local-part characters with no "@"), we visit each "@" once and match a
// bounded window on either side of it — the local part scanning left (at
// most 64 chars, never into the previous match), the domain anchored right
// of the "@" (at most 253 chars).
const LOCAL_MAX = 64;
const DOMAIN_MAX = 253;
const LOCAL_CHAR = /^[a-z0-9._%+-]$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/i;
const ASSET_TLD = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf)$/i;
const NOISE_DOMAIN = /(^|\.)(sentry\.io|sentry-next\.wixpress\.com|wixpress\.com)$/i;

const FACEBOOK_RE = /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9.\-_]+)/gi;
const FACEBOOK_RESERVED = new Set([
  "sharer", "sharer.php", "share", "share.php", "dialog", "plugins", "tr", "login",
  "login.php", "policies", "privacy", "help", "groups", "events", "watch", "profile.php",
]);
const INSTAGRAM_RE = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/gi;
const INSTAGRAM_RESERVED = new Set([
  "p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct", "about", "legal",
]);

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function extractContacts(html: string, siteUrl: string): SiteContacts {
  const text = html.replace(/&#0*64;|&#x0*40;/gi, "@");

  const candidates: string[] = [];
  for (const m of text.matchAll(/mailto:([^"'\s>?]+)/gi)) {
    let decoded = m[1]!;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Malformed %-escape: keep the raw text; the email regex decides.
    }
    candidates.push(...findEmails(decoded));
  }
  candidates.push(...findEmails(text));

  const emails = candidates
    .map((e) => e.toLowerCase())
    .filter((e) => {
      const domain = e.split("@")[1]!;
      return !ASSET_TLD.test(domain) && !NOISE_DOMAIN.test(domain);
    });

  const host = bareHost(httpUrl(siteUrl)?.hostname ?? "");
  const ownDomain = emails.find((e) => {
    const domain = bareHost(e.split("@")[1]!);
    return !!host && (domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`));
  });

  return {
    email: ownDomain ?? emails[0] ?? null,
    facebook: firstProfile(text, FACEBOOK_RE, FACEBOOK_RESERVED, "https://www.facebook.com/"),
    instagram: firstProfile(text, INSTAGRAM_RE, INSTAGRAM_RESERVED, "https://www.instagram.com/"),
  };
}

function findEmails(text: string): string[] {
  const found: string[] = [];
  let lastEnd = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > lastEnd && at - start < LOCAL_MAX && LOCAL_CHAR.test(text[start - 1]!)) start--;
    if (start === at) continue;
    const domain = DOMAIN_RE.exec(text.slice(at + 1, at + 1 + DOMAIN_MAX));
    if (!domain) continue;
    found.push(text.slice(start, at + 1) + domain[0]);
    lastEnd = at + 1 + domain[0].length;
    at = lastEnd - 1;
  }
  return found;
}

function firstProfile(
  text: string,
  re: RegExp,
  reserved: Set<string>,
  prefix: string,
): string | null {
  for (const m of text.matchAll(re)) {
    const handle = m[1]!;
    if (!reserved.has(handle.toLowerCase())) return `${prefix}${handle}`;
  }
  return null;
}
