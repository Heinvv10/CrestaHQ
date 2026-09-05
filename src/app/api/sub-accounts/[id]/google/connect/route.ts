import "server-only";

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import {
  buildGoogleOAuthUrl,
  googleAppConfigured,
  googleRedirectUri,
  signGoogleState,
} from "@/lib/google/oauth";

/**
 * Kick off the Google Business Profile connect flow.
 *
 *   GET /api/sub-accounts/[id]/google/connect
 *
 * Sub-account admin only, and only while the agency gate
 * (`googleEnabledByAgency`) is on and the deployment has a Google OAuth client
 * configured. On success redirects to Google's consent screen; any guard miss
 * redirects back to Settings with a `?google=…` status. The shared callback
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

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));

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

  const nonce = crypto.randomBytes(16).toString("hex");
  return NextResponse.redirect(
    buildGoogleOAuthUrl({ redirectUri, state: signGoogleState(id, nonce) }),
  );
}
