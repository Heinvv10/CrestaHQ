import "server-only";

import type { GbpAccount, GbpLocation, GbpPage, GbpProvider } from "./provider/types";

/**
 * Walk the accounts and locations a connection can see. Bounded: a list that
 * still has a next page after {@link MAX_PAGES} pages stops there and the
 * result says `truncated: true` rather than pretending it saw everything.
 */

export const MAX_PAGES = 20;

/** What the picker shows. `newReviewUri` stays server-side until selection. */
export type PickerLocation = Pick<
  GbpLocation,
  "name" | "title" | "address" | "websiteUri" | "placeId" | "mapsUri"
>;

export interface DiscoveredAccount {
  name: string;
  accountName: string;
  locations: PickerLocation[];
}

async function walk<T>(
  fetchPage: (pageToken?: string) => Promise<GbpPage<T>>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    if (!page.nextPageToken) return { items, truncated: false };
    pageToken = page.nextPageToken;
  }
  return { items, truncated: true };
}

const toPicker = (l: GbpLocation): PickerLocation => ({
  name: l.name,
  title: l.title,
  address: l.address,
  websiteUri: l.websiteUri,
  placeId: l.placeId,
  mapsUri: l.mapsUri,
});

export async function discoverLocations(
  provider: GbpProvider,
  accessToken: string,
): Promise<{ accounts: DiscoveredAccount[]; truncated: boolean }> {
  const accounts = await walk((p) => provider.listAccounts(accessToken, p));
  let truncated = accounts.truncated;
  const out: DiscoveredAccount[] = [];
  for (const account of accounts.items) {
    const locations = await walk((p) => provider.listLocations(accessToken, account.name, p));
    truncated ||= locations.truncated;
    out.push({
      name: account.name,
      accountName: account.accountName,
      locations: locations.items.map(toPicker),
    });
  }
  return { accounts: out, truncated };
}

/**
 * The (account, location) pair IF this connection can actually see it — the
 * server's own re-fetch, so a client can never select a listing it was not
 * shown, nor pair a real location with the wrong account.
 */
export async function findAccessibleLocation(
  provider: GbpProvider,
  accessToken: string,
  accountName: string,
  locationName: string,
): Promise<{ account: GbpAccount; location: GbpLocation } | null> {
  const accounts = await walk((p) => provider.listAccounts(accessToken, p));
  const account = accounts.items.find((a) => a.name === accountName);
  if (!account) return null;
  const locations = await walk((p) => provider.listLocations(accessToken, accountName, p));
  const location = locations.items.find((l) => l.name === locationName);
  return location ? { account, location } : null;
}
