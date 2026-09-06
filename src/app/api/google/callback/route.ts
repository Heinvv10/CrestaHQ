import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import {
  exchangeCodeForTokens,
  googleAppConfigured,
  googleRedirectUri,
  verifyGoogleState,
} from "@/lib/google/oauth";
import {
  googleConnectionSecretPath,
  type GoogleConnectionMeta,
  type GoogleConnectionSecret,
} from "@/types/google";

/**
 * Single shared OAuth callback for the Google Business Profile connect flow.
 *
 *   GET /api/google/callback?code=…&state=…
 *
 * ONE redirect URI is registered with the Google OAuth client for the whole
 * deployment (Google matches `redirect_uri` exactly, so a per-sub-account path
 * would mean registering one per client). The connecting sub-account travels
 * in the HMAC-signed `state`, so we recover + authenticate it from there
 * rather than from the URL path.
 *
 * The admin's browser lands here after the consent screen (carrying the
 * session cookie — admin-gated, not public). Verifies `state`, re-checks the
 * agency gate, exchanges the code, and stores the tokens in the LOCKED
 * `private` subcollection with only display metadata on the sub-account doc.
 * Always redirects back to Settings with a `?google=…` status; never throws to
 * the user.
 */

function appBase(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const declined = url.searchParams.get("error");

  // The sub-account identity lives in `state`. Without a valid one we can't
  // even tell whose settings page to return to, so bail to a safe landing.
  const verified = state ? verifyGoogleState(state) : null;
  if (!verified) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?google=bad_state", appBase(request)),
    );
  }
  const id = verified.subAccountId;

  // Now that we trust the sub-account id (HMAC-authenticated), gate on the
  // caller being an admin of it.
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));
  const finish = (status: string) => {
    settingsUrl.searchParams.set("google", status);
    return NextResponse.redirect(settingsUrl);
  };

  // User declined the consent screen (`error=access_denied`), or it errored.
  // Nothing is stored — an abandoned connect must leave no trace.
  if (declined || !code) {
    return finish("cancelled");
  }

  if (!(await googleGateOn(id))) {
    return finish("gate_off");
  }

  if (!googleAppConfigured()) {
    return finish("not_configured");
  }

  // Must be byte-identical to the redirect_uri sent at the authorize step.
  const redirectUri = googleRedirectUri();
  if (!redirectUri) {
    return finish("not_configured");
  }

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    // No refresh token means the connection dies within the hour. Refuse it
    // rather than storing a link that looks connected and silently stops.
    if (!tokens.refreshToken) {
      return finish("no_refresh_token");
    }

    const secret: GoogleConnectionSecret = {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    };
    // Display metadata ONLY. The sub-account doc is readable by every active
    // member and Firestore rules are document-level, so a token here would be
    // a token handed to every collaborator seat. Never add one.
    const meta: GoogleConnectionMeta = {
      connected: true,
      // Null today: `business.manage` is the only scope on the consent screen,
      // and it carries no identity claim. A later slice that calls the GBP
      // accounts API can fill this in.
      email: null,
      scopes: tokens.scopes,
      connectedAt: new Date(),
      connectedByUid: access.uid,
    };

    const db = getAdminDb();
    await db.doc(googleConnectionSecretPath(id)).set(secret);
    await db
      .doc(`subAccounts/${id}`)
      .set(
        { googleConnectionMeta: meta, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );

    return finish("connected");
  } catch (err) {
    console.error(`[google/callback] connect failed sa=${id}`, err);
    return finish("error");
  }
}
