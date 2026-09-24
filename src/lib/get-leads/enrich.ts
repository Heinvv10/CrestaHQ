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
): Promise<GetLeadsBusiness[]> {
  const out = [...businesses];
  let next = 0;
  async function worker() {
    while (next < out.length) {
      const i = next++;
      const b = out[i]!;
      if (!b.website) continue;
      const page = await fetchHomepage(b.website);
      if (!page) continue;
      const found = extractContacts(page.html, page.url);
      out[i] = {
        ...b,
        email: b.email ?? found.email,
        facebook: b.facebook ?? found.facebook,
        instagram: b.instagram ?? found.instagram,
      };
    }
  }
  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  return out;
}

function httpUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function fetchHomepage(website: string): Promise<{ html: string; url: string } | null> {
  let url = httpUrl(website);
  const signal = AbortSignal.timeout(SITE_TIMEOUT_MS);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
      const res = await publicFetch(url.href, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal,
        maxBytes: HOMEPAGE_MAX_BYTES,
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

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
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
    candidates.push(...(decoded.match(EMAIL_RE) ?? []));
  }
  candidates.push(...(text.match(EMAIL_RE) ?? []));

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
