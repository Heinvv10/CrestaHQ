import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import {
  requireWebsiteEnabledSub,
  transitionWebsite,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import type { WebsiteConfig, WebsiteDoc } from "@/types/website";

/**
 * A site id is a document id, never a path. Answered before anything
 * touches Firestore: "a/b" would address a doc in a nested collection, and
 * an id that makes the doc path an even number of segments is not a
 * document path at all — the Admin SDK throws on it, which would be a 500.
 */
const siteNotFound = () => NextResponse.json({ error: "Website not found." }, { status: 404 });

const WIZARD_STEPS = new Set(["start", "business", "pages", "video", "location", "look", "story", "review"]);
const MAX_CONFIG_BYTES = 100_000;

/**
 * PATCH — save the website wizard's draft as the operator steps through it
 * (Save on each Next). Stores the config verbatim (drafts are partial, so no
 * validation beyond shape + size; the build route validates fully) plus the
 * step to resume on. Refused (409) while a build is in flight so a save
 * can't change the config a running job was submitted with — and while the
 * site is `failed` but still carries its job id: Re-check now or a late
 * callback can turn that job into the live site, and the stored config must
 * be the one it was built from. The check and the write are one transaction
 * (`transitionWebsite`), so a build submitted between them cannot be
 * overwritten. Never touches status, job id or live URL.
 *
 * Behind the `websiteEnabledByAgency` gate like create and build (upstream
 * has no check here): a draft is the input to a build the workspace may not
 * start. DELETE below stays open with the gate off, as it always has, so a
 * gated-off workspace can still remove a site.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  if (!isDocId(siteId)) return siteNotFound();
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
  // System fields stay server-owned.
  const clean: WebsiteConfig = { ...config, site_type: "LocalSite", astra_theme: false };
  const saved = await transitionWebsite(
    docRef,
    {
      fromStatuses: ["draft", "ready", "failed"],
      when: (fresh) => !(fresh.status === "failed" && fresh.gitpageJobId),
    },
    { config: clean, wizardStep, updatedAt: FieldValue.serverTimestamp() },
  );
  if (saved.applied) return NextResponse.json({ ok: true });
  if (saved.reason === "missing") {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }
  return NextResponse.json(
    {
      error:
        saved.reason === "condition"
          ? "This site's last build can still finish — use Re-check now, or reset it, before editing."
          : "This site is building right now — wait for it to finish before editing.",
    },
    { status: 409 },
  );
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
  if (!isDocId(siteId)) return siteNotFound();
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
    // From any status, and it clears the job id: a poll tick or callback
    // still in flight for the old job then finds no job to write for
    // (`transitionWebsite` in each of them) and stops.
    const done = await transitionWebsite(
      docRef,
      { fromStatuses: ["draft", "queued", "building", "ready", "failed"] },
      {
        status: "draft",
        gitpageJobId: null,
        liveUrl: null,
        errorMessage: null,
        partialErrors: null,
        pollAttempts: 0,
        statusPhase: null,
        settledDelivery: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
    );
    if (!done.applied) {
      return NextResponse.json({ error: "No website to remove." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, reset: true });
  }

  await docRef.delete();
  return NextResponse.json({ ok: true, removed: true });
}
