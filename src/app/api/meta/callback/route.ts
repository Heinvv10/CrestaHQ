import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  exchangeCodeForUserToken,
  getGrantedScopes,
  listMetaPages,
  metaAppConfigured,
  metaRedirectUri,
  subscribePageToWebhook,
  verifyMetaState,
} from "@/lib/comms/meta";
import { deriveMetaCapabilities } from "@/lib/comms/meta-capabilities";
import type { SubAccountDoc } from "@/types";

/**
 * Single shared OAuth callback for the Facebook/Instagram connect flow.
 *
 *   GET /api/meta/callback?code=…&state=…
 *
 * ONE redirect URI is registered with the Meta app for the whole deployment
 * (Meta strict-mode requires an exact match, so a per-sub-account path would
 * mean re-registering per client). The connecting sub-account travels in the
 * HMAC-signed `state`, so we recover + authenticate it from there rather than
 * from the URL path.
 *
 * The admin's browser lands here after Facebook Login (carrying the session
 * cookie — admin-gated, not public). Verifies `state`, re-checks the agency
 * gate, exchanges the code for a Page token, subscribes the Page to our
 * webhook, and stores `metaConfig`. Always redirects back to Settings with a
 * `?meta=…` status; never throws to the user.
 */

function appBase(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const declined = url.searchParams.get("error");

  // The sub-account identity lives in `state`. Without a valid one we can't
  // even tell whose settings page to return to, so bail to a safe landing.
  if (!state) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?meta=bad_state", appBase(request)),
    );
  }
  const verified = verifyMetaState(state);
  if (!verified) {
    return NextResponse.redirect(
      new URL("/agency/sub-accounts?meta=bad_state", appBase(request)),
    );
  }
  const id = verified.subAccountId;

  // Now that we trust the sub-account id (HMAC-authenticated), gate on the
  // caller being an admin of it.
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${id}/dashboard/settings`, appBase(request));
  const finish = (status: string) => {
    settingsUrl.searchParams.set("meta", status);
    return NextResponse.redirect(settingsUrl);
  };

  // User declined the Facebook dialog, or it errored.
  if (declined || !code) {
    return finish("cancelled");
  }

  if (!metaAppConfigured()) {
    return finish("not_configured");
  }

  // Must be byte-identical to the redirect_uri sent at the authorize step.
  const redirectUri = metaRedirectUri();
  if (!redirectUri) {
    return finish("not_configured");
  }

  const db = getAdminDb();
  const snap = await db.doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;
  const inboxOn = sa?.metaInboxEnabledByAgency === true;
  const socialOn = sa?.socialPlannerEnabledByAgency === true;
  if (!inboxOn && !socialOn) {
    return finish("gate_off");
  }

  try {
    const userToken = await exchangeCodeForUserToken(code, redirectUri);
    // Record what Meta actually granted (vs declined), intersected with the
    // gates that are on — the single source of truth both features read.
    const granted = await getGrantedScopes(userToken);
    const capabilities = deriveMetaCapabilities(granted, {
      inbox: inboxOn,
      publish: socialOn,
    });
    const pages = await listMetaPages(userToken);
    if (pages.length === 0) {
      return finish("no_pages");
    }

    // v1: connect the first managed Page. Multi-page selection is deferred —
    // a tester with several Pages would pick here in a later slice.
    const page = pages[0];

    // Best-effort — a failed subscribe shouldn't block storing the connection;
    // the operator can retry, and we surface a partial state if needed.
    let subscribed = true;
    try {
      await subscribePageToWebhook(page.id, page.accessToken);
    } catch (err) {
      subscribed = false;
      console.warn(
        `[meta/callback] page subscribe failed sa=${id} page=${page.id}`,
        err,
      );
    }

    await db.doc(`subAccounts/${id}`).update({
      metaConfig: {
        connected: true,
        pageId: page.id,
        pageName: page.name,
        pageAccessToken: page.accessToken,
        instagramBusinessAccountId: page.instagramBusinessAccountId,
        instagramUsername: page.instagramUsername,
        capabilities,
        connectedByUid: access.uid,
        connectedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });

    return finish(subscribed ? "connected" : "connected_no_sub");
  } catch (err) {
    console.error(`[meta/callback] connect failed sa=${id}`, err);
    return finish("error");
  }
}
