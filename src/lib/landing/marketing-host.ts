/**
 * Whether the app's landing page should stay out of search results because the
 * brand's marketing site lives on another host.
 *
 * crm.crestahq.com served a second marketing homepage, near-identical in title
 * to crestahq.com, competing with it for brand searches. A buyer whose app runs
 * on its primary domain is unaffected: the hosts match and the landing indexes.
 */
export function landingDefersToPrimaryDomain(
  appUrl: string | undefined,
  primaryDomain: string,
): boolean {
  if (!appUrl || !primaryDomain) return false;
  let appHost: string;
  try {
    appHost = new URL(appUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const primary = primaryDomain.toLowerCase().replace(/^www\./, "");
  return appHost !== primary && appHost !== `www.${primary}`;
}
