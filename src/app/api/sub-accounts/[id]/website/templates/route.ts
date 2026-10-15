import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  fetchTemplates,
  GitpageError,
  gitpageIsConfigured,
} from "@/lib/gitpage/client";
import { isDocId } from "@/lib/server/doc-id";
import {
  requireWebsiteEnabledSub,
  WebsiteServiceError,
} from "@/lib/server/websites-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/sub-accounts/[id]/website/templates
 *
 * Proxies gitpage's `GET /api/v1/templates` (the agency's saved "Agency
 * templates", plus this sub-account's own client templates) for the website
 * builder: the wizard's template picker and the
 * site cards' "Save as template". Admin-only, like building and saving a site
 * (template names and previews are usually the agency's other clients'
 * sites); the agency's gitpage key never reaches the browser.
 * `{ enabled, templates }`: enabled = templates are switched on for the
 * agency's gitpage account (the option shows, even with none saved yet).
 *
 * Behind the `websiteEnabledByAgency` gate like create and build (upstream
 * has no check here): the list feeds a builder the workspace does not have.
 */
export async function GET(
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

  const headers = { "Cache-Control": "private, no-store" };
  if (!gitpageIsConfigured()) {
    return NextResponse.json({ enabled: false, templates: [] }, { headers });
  }

  try {
    const result = await fetchTemplates(subAccountId);
    return NextResponse.json(result, { headers });
  } catch (err) {
    if (err instanceof GitpageError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load templates." },
      { status: 502 },
    );
  }
}
