import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getGbpProviderFor } from "@/lib/gbp/provider/select";
import { googleGateOn } from "@/lib/google/gate";
import {
  googleAppConfigured,
  googleRedirectUri,
  googleReturnPath,
  signGoogleState,
  GoogleStateSecretMissingError,
  type GoogleReturnTo,
} from "@/lib/google/oauth";

/**
 * Kick off the Google Business Profile connect flow.
 *
 *   GET /api/sub-accounts/[id]/google/connect[?return=gbp]
 *
 * Sub-account admin only, and only while the agency gate
 * (`googleEnabledByAgency`) is on and the deployment has a Google OAuth client
 * configured. On success redirects to Google's consent screen; any guard miss
 * redirects back to Settings (or, with `?return=gbp`, the Google Business
 * page) with a `?google=…` status. The shared callback
 * completes the handshake and stores the tokens.
 */

function appBase(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  // Allow-list: only the literal "gbp" selects the other page. The value is
  // carried in the signed state, so the callback never trusts a URL param.
  const returnTo: GoogleReturnTo =
    new URL(request.url).searchParams.get("return") === "gbp" ? "gbp" : "settings";
  const settingsUrl = new URL(googleReturnPath(id, returnTo), appBase(request));

  if (!(await googleGateOn(id))) {
    settingsUrl.searchParams.set("google", "gate_off");
    return NextResponse.redirect(settingsUrl);
  }

  if (!googleAppConfigured()) {
    settingsUrl.searchParams.set("google", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  // ONE shared redirect URI for the whole deployment (see googleRedirectUri).
  // The sub-account travels in the signed `state`, not the URL path.
  const redirectUri = googleRedirectUri();
  if (!redirectUri) {
    settingsUrl.searchParams.set("google", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  let state: string;
  try {
    state = signGoogleState({ subAccountId: id, uid: access.uid, returnTo });
  } catch (err) {
    if (!(err instanceof GoogleStateSecretMissingError)) throw err;
    settingsUrl.searchParams.set("google", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }
  // Throws (500) in fake mode for a sub-account outside the fixture agency.
  const provider = await getGbpProviderFor(id);
  return NextResponse.redirect(
    provider.authorizeUrl({ redirectUri, state }),
  );
}
