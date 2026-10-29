import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleRedirectUri, type GoogleStateClaims } from "@/lib/google/oauth";
import { gcalConnectionPath, type GoogleCalendarConnection } from "./connection";
import { googleCalendarGateOn } from "./gate";
import { deleteImportedEvents } from "./import-state";
import { gcalAppConfigured } from "./provider/mode";
import { getGcalProviderFor } from "./provider/select";
import { GCAL_SCOPE } from "./scopes";

/**
 * The Google Calendar half of the shared `/api/google/callback`, reached only
 * with a state whose signed purpose is "calendar" (GBP states never carry
 * one). The connection is the SIGNED-IN MEMBER's own: any active member may
 * connect, and only as the uid that started the flow. Always redirects to
 * Settings with `?gcal=<status>`; never throws to the user.
 */

function appBase(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
}

export async function completeCalendarConnect(
  request: Request,
  claims: GoogleStateClaims,
): Promise<Response> {
  const sa = claims.subAccountId;
  const access = await requireSubAccountMember(request, sa);
  if (access instanceof NextResponse) return access;

  const settingsUrl = new URL(`/sa/${sa}/dashboard/settings`, appBase(request));
  const finish = (status: string) => {
    settingsUrl.searchParams.set("gcal", status);
    return NextResponse.redirect(settingsUrl);
  };

  // Bound to the member who started it: a state leaked to a colleague would
  // otherwise connect THEIR Google account as the starter's calendar.
  if (access.uid !== claims.uid) return finish("bad_state");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return finish("cancelled");
  if (!(await googleCalendarGateOn(sa))) return finish("gate_off");
  if (!gcalAppConfigured()) return finish("not_configured");
  const redirectUri = googleRedirectUri();
  if (!redirectUri) return finish("not_configured");

  try {
    // Inside the try: in fake mode a sub-account outside the fixture agency
    // throws here, BEFORE any exchange or write.
    const provider = await getGcalProviderFor(sa, access.uid);
    const tokens = await provider.exchangeCode(code, redirectUri);
    // Without a refresh token the connection dies within the hour.
    if (!tokens.refreshToken) return finish("no_refresh_token");
    // The consent screen lets the member untick calendar access.
    if (!tokens.scopes.includes(GCAL_SCOPE)) return finish("insufficient_scope");

    let googleEmail: string | null = null;
    try {
      googleEmail = await provider.userEmail(tokens.accessToken);
    } catch (err) {
      // Display only — a connection without the email still syncs.
      console.warn(`[google-calendar/callback] userinfo failed sa=${sa}`, err instanceof Error ? err.name : typeof err);
    }

    const agencyId = (await getAdminDb().doc(`subAccounts/${sa}`).get()).data()?.agencyId as string;
    const conn: GoogleCalendarConnection = {
      uid: access.uid,
      agencyId,
      subAccountId: sa,
      googleEmail,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      status: "connected",
      connectedAt: new Date(),
      lastError: null,
      lastErrorAt: null,
    };
    // Whole-doc set: a reconnect replaces a revoked grant and its warning —
    // and the import opt-in, which may have been for another Google account.
    // Its imported events go with it; the member opts in again.
    await getAdminDb().doc(gcalConnectionPath(sa, access.uid)).set(conn);
    try {
      await deleteImportedEvents(sa, access.uid);
    } catch (err) {
      // The daily orphan sweep is the backstop: no opt-in means not kept.
      console.error(`[google-calendar/callback] import cleanup failed sa=${sa}`, err instanceof Error ? err.message : String(err));
    }
    return finish("connected");
  } catch (err) {
    // Name + message only. GbpProviderError messages are fixed per kind.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
    console.error(`[google-calendar/callback] connect failed sa=${sa}`, reason);
    return finish("error");
  }
}
