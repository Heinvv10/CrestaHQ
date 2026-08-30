import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  submitWebsiteBuildForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import type { WebsiteConfig } from "@/types/website";

/**
 * Submit a build for one of the sub-account's websites
 * (`subAccounts/{id}/website/{siteId}`). On success the doc is persisted with
 * status: "queued" + the gitpage formResponseId; the client's onSnapshot picks
 * it up and flips that card to the Building view. The first QStash poll is
 * scheduled against `/website/{siteId}/poll`, which reschedules itself until
 * the build settles.
 *
 * Normalization, validation, the agency gate, the gitpage submit, and the
 * poll scheduling all live in the shared websites service (also used by the
 * AI Suite `create_website` capability) — this route is auth + JSON mapping.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { config?: WebsiteConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const config = body.config;
  if (!config || typeof config !== "object") {
    return NextResponse.json(
      { error: "Body must include `config` object." },
      { status: 400 },
    );
  }

  try {
    const submission = await submitWebsiteBuildForSubAccount({
      subAccountId,
      siteId,
      config,
      buildByUid: access.uid,
    });
    return NextResponse.json({
      ok: true,
      status: "queued",
      formResponseId: submission.formResponseId,
      estimatedDurationSeconds: submission.estimatedDurationSeconds,
    });
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json(
        {
          error: err.message,
          ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
          ...(err.gitpageStatus !== undefined
            ? { gitpageStatus: err.gitpageStatus, gitpageBody: err.gitpageBody }
            : {}),
        },
        { status: err.status },
      );
    }
    console.error("[website/build] failed", err);
    return NextResponse.json(
      { error: "Failed to submit the build." },
      { status: 500 },
    );
  }
}
