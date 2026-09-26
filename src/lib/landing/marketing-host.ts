/**
 * Whether the app's landing page should stay out of search results because the
 * brand's marketing site lives on the parent domain.
 *
 * crm.crestahq.com served a second marketing homepage, near-identical in title
 * to crestahq.com, competing with it for brand searches. Only a SUBDOMAIN of the
 * primary domain defers: a buyer deploying on their own domain while the
 * template's placeholder primaryDomain is still set stays indexable, because a
 * noindexed only-homepage is the worse failure.
 */
export function landingDefersToPrimaryDomain(
  appUrl: string | undefined,
  primaryDomain: string,
): boolean {
  if (!appUrl || !primaryDomain) return false;
  let appHost: string;
  try {
    appHost = new URL(appUrl).hostname;
  } catch {
    return false;
  }
  const primary = primaryDomain.toLowerCase().replace(/^www\./, "");
  return appHost.endsWith(`.${primary}`) && appHost !== `www.${primary}`;
}
