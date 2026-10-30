import { unavailable, type SectionInput } from "./types";

/**
 * Section 9 — ads running. Decision D5 spike (2026-09-26): Meta's Ad Library
 * answers a plain GET with 403, and Google's Ads Transparency Center is a
 * client-rendered app (its data comes from an undocumented internal RPC, not
 * a public API). Neither has a keyless fetch we can rely on, so the section
 * is always unavailable and carries manual-check links. `no_ads_running` is
 * never emitted from a guess. There is nothing measured, so no `score()`.
 */

export const key = "ads" as const;

export async function run(input: SectionInput) {
  const { name, website } = input.business;
  let domain: string | null = null;
  try {
    domain = website ? new URL(website).hostname.replace(/^www\./, "") : null;
  } catch {
    // Not a URL — the Google link is simply omitted.
  }
  return unavailable(key, "Ad libraries have no keyless API; check manually.", {
    metaAdLibraryUrl: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ZA&q=${encodeURIComponent(name)}`,
    googleAdsTransparencyUrl: domain
      ? `https://adstransparency.google.com/?region=ZA&domain=${encodeURIComponent(domain)}`
      : null,
  });
}
