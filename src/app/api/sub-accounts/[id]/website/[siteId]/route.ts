import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import type { WebsiteConfig, WebsiteDoc } from "@/types/website";

const WIZARD_STEPS = new Set(["start", "business", "pages", "video", "location", "look", "story", "review"]);
const MAX_CONFIG_BYTES = 100_000;

/**
 * PATCH — save the website wizard's draft as the operator steps through it
 * (Save on each Next). Stores the config verbatim (drafts are partial, so no
 * validation beyond shape + size; the build route validates fully) plus the
 * step to resume on. Refused while a build is in flight so a save can't
 * change the config a running job was submitted with. Never touches status,
 * job id or live URL.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { config?: WebsiteConfig; wizardStep?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const config = body.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return NextResponse.json({ error: "Body must include a `config` object." }, { status: 400 });
  }
  if (JSON.stringify(config).length > MAX_CONFIG_BYTES) {
    return NextResponse.json({ error: "That draft is too large to save." }, { status: 413 });
  }
  const wizardStep =
    typeof body.wizardStep === "string" && WIZARD_STEPS.has(body.wizardStep) ? body.wizardStep : null;

  const docRef = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists || (snap.data() as WebsiteDoc).subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }
  const status = (snap.data() as WebsiteDoc).status;
  if (status === "queued" || status === "building") {
    return NextResponse.json(
      { error: "This site is building right now — wait for it to finish before editing." },
      { status: 409 },
    );
  }
  // System fields stay server-owned.
  const clean: WebsiteConfig = { ...config, site_type: "LocalSite", astra_theme: false };
  await docRef.update({
    config: clean,
    wizardStep,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}

/**
 * DELETE a website.
 *
 *   ?reset=1  → reset the doc to draft (the "Rebuild" action). Clears
 *               gitpageJobId / liveUrl / status / errors so the operator can
 *               edit the form and submit a new build. The previously-published
 *               GitHub repo stays live until manually deleted on gitpage's
 *               side — v1 doesn't tear down on rebuild. Config is preserved.
 *
 *   (no flag) → permanently remove the website doc, freeing one of the
 *               sub-account's slots so a different site can be created. The
 *               previously-published repo (if any) likewise stays live.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const reset = new URL(request.url).searchParams.get("reset") === "1";

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "No website to remove." }, { status: 404 });
  }

  if (reset) {
    await docRef.update({
      status: "draft",
      gitpageJobId: null,
      liveUrl: null,
      errorMessage: null,
      partialErrors: null,
      pollAttempts: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, reset: true });
  }

  await docRef.delete();
  return NextResponse.json({ ok: true, removed: true });
}
