import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  fetchTemplates,
  gitpageIsConfigured,
  removeTemplate,
  saveTemplate,
  type GitpageTemplate,
} from "@/lib/gitpage/client";
import { gitpageErrorResponse } from "@/lib/gitpage/route-errors";
import { isDocId } from "@/lib/server/doc-id";
import {
  requireWebsiteEnabledSub,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * POST   /api/sub-accounts/[id]/website/[siteId]/template  { name }
 * DELETE /api/sub-accounts/[id]/website/[siteId]/template
 *
 * Save this built site as one of the agency's gitpage "Agency templates" (or
 * rename it), or stop it being one — so agencies never have to leave
 * LeadStack. The site stays a normal live site.
 *   agency owner  saves for every client, or (`scope: "client"`) for this
 *                 client only
 *   client admins save templates only this sub-account builds from; they
 *                 can't change the agency's own templates (gitpage refuses)
 * gitpage checks the rest (its site, published, on GitLab, templates
 * switched on).
 *
 * Behind the `websiteEnabledByAgency` gate like create and build (upstream
 * has no check here).
 */
async function siteFor(subAccountId: string, siteId: string): Promise<WebsiteDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`).get();
  const doc = snap.exists ? (snap.data() as WebsiteDoc) : null;
  return doc && doc.subAccountId === subAccountId ? doc : null;
}

/**
 * Client templates need a gitpage version that knows them (an older one would
 * save the template for every client). Returns this site's current template
 * entry, or a response refusing the request.
 */
async function clientTemplateCheck(
  subAccountId: string,
  pageId: string,
  isAgencyOwner: boolean,
): Promise<{ current: GitpageTemplate | null } | { response: NextResponse }> {
  const list = await fetchTemplates(subAccountId);
  if (!list.enabled) {
    return { response: NextResponse.json({ error: "Agency templates aren't switched on for this gitpage account." }, { status: 404 }) };
  }
  if (!list.clientTemplates) {
    return { response: NextResponse.json({ error: "Templates for one client need a newer gitpage. Ask your agency to update." }, { status: 409 }) };
  }
  const current = list.templates.find((t) => t.templateId === pageId) ?? null;
  if (!isAgencyOwner && current?.scope === "agency") {
    return { response: NextResponse.json({ error: "This is one of your agency's templates. Only the agency can change it." }, { status: 403 }) };
  }
  return { current };
}

async function guard(request: Request, ctx: { params: Promise<{ id: string; siteId: string }> }) {
  const { id: subAccountId, siteId } = await ctx.params;
  // HARDENING: both ids become a Firestore path; a non-id is "not found" before any read.
  if (!isDocId(subAccountId) || !isDocId(siteId)) {
    return { response: NextResponse.json({ error: "Website not found in this workspace." }, { status: 404 }) };
  }
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return { response: access };
  try {
    await requireWebsiteEnabledSub(subAccountId);
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      return { response: NextResponse.json({ error: err.message }, { status: err.status }) };
    }
    throw err;
  }
  if (!gitpageIsConfigured()) {
    return { response: NextResponse.json({ error: "gitpage is not configured on this deployment (GITPAGE_API_KEY missing)." }, { status: 503 }) };
  }
  const site = await siteFor(subAccountId, siteId);
  if (!site) return { response: NextResponse.json({ error: "Website not found in this workspace." }, { status: 404 }) };
  if (site.status !== "ready" || !site.gitpagePageId) {
    return { response: NextResponse.json({ error: "Only a published site can be a template. Build it first." }, { status: 400 }) };
  }
  return { site, subAccountId, isAgencyOwner: access.subAccountRole === "agencyOwner" };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const g = await guard(request, ctx);
  if ("response" in g) return g.response;
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; scope?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Give the template a name." }, { status: 400 });
  if (name.length > 60) return NextResponse.json({ error: "Keep the name under 60 characters." }, { status: 400 });
  try {
    const pageId = g.site.gitpagePageId as string;
    const scope = body.scope === "client" || body.scope === "agency" ? body.scope : undefined;
    const wantsClient = !g.isAgencyOwner || scope === "client";
    let existed = false;
    if (wantsClient) {
      const check = await clientTemplateCheck(g.subAccountId, pageId, g.isAgencyOwner);
      if ("response" in check) return check.response;
      existed = !!check.current;
    }
    const template = await saveTemplate(pageId, name, g.isAgencyOwner ? { scope } : { client: g.subAccountId });
    // Belt and braces: a client template must come back as one.
    if (wantsClient && !template) {
      // HARDENING: no readable answer — what gitpage saved is unknown, so nothing is undone.
      return NextResponse.json({ error: "gitpage's answer didn't include the template. Check it in gitpage before trying again." }, { status: 502 });
    }
    if (wantsClient && template?.scope !== "client") {
      // HARDENING (not upstream, which removed it as the agency): undone
      // acting as this client, so the undo can never remove an agency template.
      if (!existed) {
        await removeTemplate(pageId, g.subAccountId).catch((err) =>
          console.error(
            `[website/template] could not undo an agency-wide save sa=${g.subAccountId} page=${pageId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return NextResponse.json({ error: "gitpage didn't save it for this client only. Ask your agency to update gitpage." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, isTemplate: true, template });
  } catch (err) {
    return gitpageErrorResponse(err, "Could not save the template.");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const g = await guard(request, ctx);
  if ("response" in g) return g.response;
  try {
    if (!g.isAgencyOwner) {
      const check = await clientTemplateCheck(g.subAccountId, g.site.gitpagePageId as string, false);
      if ("response" in check) return check.response;
    }
    await removeTemplate(g.site.gitpagePageId as string, g.isAgencyOwner ? undefined : g.subAccountId);
    return NextResponse.json({ ok: true, isTemplate: false });
  } catch (err) {
    return gitpageErrorResponse(err, "Could not remove the template.");
  }
}
