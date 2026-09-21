import "server-only";

import { getGbpProviderFor } from "./provider/select";
import { GbpProviderError, type GbpProvider } from "./provider/types";
import {
  getValidAccessToken,
  invalidateAccessToken,
  markReconnectRequiredIf,
} from "./tokens";

/**
 * Run Google data calls for one sub-account. Every data-call route (and the
 * sync in PR 2) goes through here so the failure handling is the same
 * everywhere:
 *
 *  - `auth_expired` (401) with a token we believed valid usually means the
 *    grant was revoked at Google while our cached token still had most of its
 *    hour left. Expire the cached token, force ONE refresh and retry ONCE: the
 *    refresh either works (a genuinely stale token) or hits invalid_grant,
 *    which tokens.ts turns into reconnect-required.
 *  - `insufficient_scope` from a data call flags reconnect-required — only if
 *    the secret still holds the token that was refused.
 */
export async function withGbpAccess<T>(
  subAccountId: string,
  fn: (provider: GbpProvider, accessToken: string) => Promise<T>,
): Promise<T> {
  const provider = await getGbpProviderFor(subAccountId);

  const attempt = async (accessToken: string): Promise<T> => {
    try {
      return await fn(provider, accessToken);
    } catch (err) {
      if (err instanceof GbpProviderError && err.kind === "insufficient_scope") {
        await markReconnectRequiredIf(subAccountId, "insufficient_scope", { accessToken });
      }
      throw err;
    }
  };

  const accessToken = await getValidAccessToken(subAccountId);
  try {
    return await attempt(accessToken);
  } catch (err) {
    if (!(err instanceof GbpProviderError) || err.kind !== "auth_expired") throw err;
    await invalidateAccessToken(subAccountId, accessToken);
    return attempt(await getValidAccessToken(subAccountId));
  }
}
