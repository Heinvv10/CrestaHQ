import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { reverifyListingAfterReconnect } from "@/lib/gbp/listing-events";
import { completeCalendarConnect } from "@/lib/google-calendar/callback";
import { getGbpProviderFor } from "@/lib/gbp/provider/select";
import {
  GOOGLE_SCOPE,
  googleAppConfigured,
  googleRedirectUri,
  googleReturnPath,
  verifyGoogleState,
} from "@/lib/google/oauth";
import {
  googleConnectionSecretPath,
  type GoogleConnectionMeta,
  type GoogleConnectionSecret,
  type GoogleListing,
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
 * Always redirects back to Settings (or the Google Business page, per the
 * signed `r` claim) with a `?google=…` status; never throws to the user.
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
  const badState = () =>
    NextResponse.redirect(
      new URL("/agency/sub-accounts?google=bad_state", appBase(request)),
    );
  const verified = state ? verifyGoogleState(state) : null;
  if (!verified) return badState();
  // A member's Google Calendar connection shares this one registered redirect
  // URI. Its own handler owns every step after the signature check; a state
  // without the purpose claim (every GBP state) never reaches it.
  if (verified.purpose === "calendar") {
    return completeCalendarConnect(request, verified);
  }
  const id = verified.subAccountId;

  // Now that we trust the sub-account id (HMAC-authenticated), gate on the
  // caller being an admin of it.
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  // The state is bound to the uid that started the flow. Another admin of the
  // same sub-account holding a leaked state must not be able to complete it.
  if (access.uid !== verified.uid) return badState();

  const settingsUrl = new URL(
    googleReturnPath(id, verified.returnTo),
    appBase(request),
  );
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
    // Inside the try: in fake mode a sub-account outside the fixture agency
    // throws here, BEFORE any exchange or write.
    const provider = await getGbpProviderFor(id);
    const tokens = await provider.exchangeCode(code, redirectUri);
    // No refresh token means the connection dies within the hour. Refuse it
    // rather than storing a link that looks connected and silently stops.
    if (!tokens.refreshToken) {
      return finish("no_refresh_token");
    }
    // Google's consent screen lets the user untick the scope. A grant without
    // business.manage can do nothing we need — store nothing.
    if (!tokens.scopes.includes(GOOGLE_SCOPE)) {
      return finish("insufficient_scope");
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
      // Explicit, not omitted: the doc write below is a deep merge, so an
      // omitted field would leave a stale `reconnectRequired: true` behind.
      reconnectRequired: false,
      reconnectReason: null,
    };

    const db = getAdminDb();
    const subRef = db.doc(`subAccounts/${id}`);
    const listing = (await subRef.get()).data()?.googleListing as GoogleListing | null | undefined;
    await db.doc(googleConnectionSecretPath(id)).set(secret);
    await subRef.set(
      { googleConnectionMeta: meta, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    // A reconnect may be a DIFFERENT Google identity: the old listing must
    // still be visible to this grant, or it is cleared (and audited).
    if (listing?.locationName) {
      await reverifyListingAfterReconnect(id, access.uid, provider, tokens.accessToken, listing);
    }

    return finish("connected");
  } catch (err) {
    // Name + message only: a raw error object can carry request detail.
    // GbpProviderError messages are fixed per kind and never hold a token.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[google/callback] connect failed sa=${id}`, reason);
    return finish("error");
  }
}
