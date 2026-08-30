import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createWebsiteForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";

/**
 * Create a new (blank, draft) website for this sub-account and return its id.
 * The client adds the returned doc to the card list via onSnapshot, then the
 * operator fills the form and hits Build (which targets
 * `/website/[siteId]/build`).
 *
 * Gate + per-sub-account cap are enforced in the shared websites service
 * (also used by the AI Suite `create_website` capability) so the two entry
 * points can't drift.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    const { siteId } = await createWebsiteForSubAccount({ subAccountId });
    return NextResponse.json({ ok: true, siteId });
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[website/create] failed", err);
    return NextResponse.json(
      { error: "Failed to create the website." },
      { status: 500 },
    );
  }
}
