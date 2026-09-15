import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { MediaError } from "./service";

/**
 * Prologue shared by every `/api/sub-accounts/[id]/media/*` route: only a
 * sub-account admin (or the agency owner) may change the library — members
 * read it through Firestore rules, like customFields. The body is parsed
 * once; a `MediaError` becomes its status, anything else propagates.
 */

export interface MediaRouteContext {
  subAccountId: string;
  agencyId: string;
  uid: string;
  body: Record<string, unknown>;
}

export async function withMedia(
  request: Request,
  subAccountId: string,
  fn: (ctx: MediaRouteContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown> = {};
  if (request.method !== "DELETE") {
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;
  if (!agencyId) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  try {
    return await fn({ subAccountId, agencyId, uid: access.uid, body });
  } catch (err) {
    if (err instanceof MediaError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
