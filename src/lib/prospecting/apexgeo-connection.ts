import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { subAccountSecretPath } from "@/lib/server/sub-account-secrets";
import { APEXGEO_DEFAULT_BASE_URL, type ApexgeoConnection, type ApexgeoError } from "./apexgeo-client";

/**
 * The sub-account's ApexGEO connection: `{ apiKey, baseUrl }` in the locked
 * `subAccounts/{id}/private/apexgeoConnection` doc (decision D2). The parent
 * doc carries only `apexgeoConnected`, `apexgeoKeyLast4`, `apexgeoBaseUrl`.
 */

export const apexgeoSecretPath = (subAccountId: string) => subAccountSecretPath(subAccountId, "apexgeo");

/**
 * A custom base URL must be plain `https://host[/path]` — no port,
 * credentials, query or fragment. Empty means ApexGEO's production URL. Null = refused.
 * Whether the host is public is decided at connect time by `publicFetch`.
 */
export function normalizeBaseUrl(input: unknown): string | null {
  if (input === undefined || input === null || (typeof input === "string" && input.trim() === "")) {
    return APEXGEO_DEFAULT_BASE_URL;
  }
  if (typeof input !== "string" || input.length > 500) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // Default port only: a custom port would let an admin probe services on public hosts.
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The stored connection, or null when none (or a stored one is unusable). */
export async function readApexgeoConnection(subAccountId: string): Promise<ApexgeoConnection | null> {
  const data = (await getAdminDb().doc(apexgeoSecretPath(subAccountId)).get()).data();
  const apiKey = typeof data?.apiKey === "string" ? data.apiKey.trim() : "";
  const baseUrl = normalizeBaseUrl(data?.baseUrl);
  return apiKey && baseUrl ? { apiKey, baseUrl } : null;
}

/** Operator-facing reason for a failed key check. Never the provider's own text. */
export function probeFailureReason(error: ApexgeoError, baseUrl: string): string {
  switch (error.kind) {
    case "unauthorized":
      return "ApexGEO refused this key. Check it was copied in full and has not been revoked.";
    case "forbidden":
      return "This key isn't allowed to read scans. Create a key with read and write scopes.";
    case "network":
      return `Couldn't reach ApexGEO at ${new URL(baseUrl).host}.`;
    case "rate_limited":
      return "ApexGEO is rate-limiting this key. Try again in a minute.";
    default:
      return "ApexGEO returned an unexpected response. Check the base URL.";
  }
}
