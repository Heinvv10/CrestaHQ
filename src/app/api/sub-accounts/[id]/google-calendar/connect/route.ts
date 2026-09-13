import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleCalendarGateOn } from "@/lib/google-calendar/gate";
import { gcalAppConfigured } from "@/lib/google-calendar/provider/mode";
import { getGcalProviderFor } from "@/lib/google-calendar/provider/select";
import {
  GoogleStateSecretMissingError,
  googleRedirectUri,
  signGoogleState,
} from "@/lib/google/oauth";

/**
 * Start the signed-in member's Google Calendar connect.
 *
 *   GET /api/sub-accounts/[id]/google-calendar/connect
 *
 * Any active member (it connects THEIR calendar), only while the agency gate
 * is on and the deployment has a Google OAuth client. Redirects to Google's
 * consent screen (offline access + forced consent, so a refresh token comes
 * back every time); any guard miss redirects to Settings with `?gcal=…`.
 * Completed by the shared /api/google/callback, routed there by the signed
 * `purpose: "calendar"` claim.
 */

function appBase(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));
  const refuse = (status: string) => {
    settingsUrl.searchParams.set("gcal", status);
    return NextResponse.redirect(settingsUrl);
  };

  if (!(await googleCalendarGateOn(id))) return refuse("gate_off");
  if (!gcalAppConfigured()) return refuse("not_configured");
  const redirectUri = googleRedirectUri();
  if (!redirectUri) return refuse("not_configured");

  let state: string;
  try {
    state = signGoogleState({ subAccountId: id, uid: access.uid, purpose: "calendar" });
  } catch (err) {
    if (!(err instanceof GoogleStateSecretMissingError)) throw err;
    return refuse("not_configured");
  }
  // Throws (500) in fake mode for a sub-account outside the fixture agency.
  const provider = await getGcalProviderFor(id, access.uid);
  return NextResponse.redirect(provider.authorizeUrl({ redirectUri, state }));
}
