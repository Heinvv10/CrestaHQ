import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import { syncClientSitesFromGitpage } from "@/lib/server/website-import-service";
import {
  requireWebsiteEnabledSub,
  WebsiteServiceError,
} from "@/lib/server/websites-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/sub-accounts/[id]/website/sync
 *
 * Imports copies this sub-account's people made in gitpage (Duplicate) that
 * the Websites list doesn't have yet (lib/server/website-import-service.ts).
 * Called by the Websites page when it opens; the page's Firestore listener
 * shows what was imported. Admin-only, like the page. Failures are quiet: the
 * list just stays as it is.
 *
 * Behind the `websiteEnabledByAgency` gate like create and build (upstream
 * has no check here; its import service checks it and imports nothing).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  // HARDENING: the id becomes a Firestore path; a non-id is "not found" before any read.
  if (!isDocId(subAccountId)) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    await requireWebsiteEnabledSub(subAccountId);
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  try {
    const result = await syncClientSitesFromGitpage(subAccountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      `[website/sync] failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ ok: false, imported: 0 }, { status: 200 });
  }
}
