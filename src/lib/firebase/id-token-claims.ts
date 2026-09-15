import type { ParsedToken } from "firebase/auth";

/** The one method of `firebase/auth` `User` this needs; a test fake need not build the rest. */
export interface TokenSource {
  getIdTokenResult(forceRefresh?: boolean): Promise<{ claims: ParsedToken }>;
}

/**
 * Custom claims for the signed-in user.
 *
 * A forced refresh is attempted first so claims set moments ago (signup,
 * invite acceptance) are visible. If the network refresh fails, the cached
 * token is used instead — it was minted by the same auth server and still
 * carries `agencyId` / `agencyRole`. Returning `{}` on a transient refresh
 * failure silently demoted agency owners (no `agencyRole` → sub-account
 * redirect instead of /agency).
 */
export async function loadIdTokenClaims(
  user: TokenSource,
): Promise<ParsedToken> {
  try {
    return (await user.getIdTokenResult(true)).claims;
  } catch {
    try {
      return (await user.getIdTokenResult(false)).claims;
    } catch {
      return {};
    }
  }
}

/**
 * Whether the user holds the agency-owner claim. Unlike
 * {@link loadIdTokenClaims} this THROWS when the token cannot be read at all,
 * so a caller can tell "not an owner" from "could not find out" — returning
 * `{}` there would show a real owner a refusal instead of a retry.
 */
export async function readOwnerClaim(
  user: TokenSource,
): Promise<"owner" | "not_owner"> {
  const { claims } = await user.getIdTokenResult(true);
  return claims.agencyRole === "owner" ? "owner" : "not_owner";
}
