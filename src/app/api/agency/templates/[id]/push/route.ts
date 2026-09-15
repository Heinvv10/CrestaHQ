import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { pushTemplate } from "@/lib/templates/push";
import type { SnapshotPayload } from "@/types/snapshots";
import { TEMPLATE_PUSH_TARGETS_MAX } from "@/types/templates";

/**
 * POST — push a library template into one or more sub-accounts. The template
 * is loaded from the caller's own agency; each target is re-anchored to that
 * agency inside {@link pushTemplate}, and reported per-target.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId!;
  const { id } = await ctx.params;

  let body: { subAccountIds?: unknown };
  try {
    body = (await request.json()) as { subAccountIds?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const raw = body.subAccountIds;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || !s.trim())) {
    return NextResponse.json(
      { error: "subAccountIds must be a list of sub-account ids." },
      { status: 400 },
    );
  }
  const subAccountIds = [...new Set((raw as string[]).map((s) => s.trim()))];
  if (subAccountIds.length < 1 || subAccountIds.length > TEMPLATE_PUSH_TARGETS_MAX) {
    return NextResponse.json(
      { error: `Pick between 1 and ${TEMPLATE_PUSH_TARGETS_MAX} sub-accounts.` },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const snap = await db.doc(`agencies/${agencyId}/templates/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
  const payload = (snap.data()?.payload ?? {}) as Partial<SnapshotPayload>;

  const results = await pushTemplate(
    db,
    {
      // Spread first so anything a future capture adds reaches apply
      // untouched (same lesson as the apply-snapshot route).
      ...payload,
      forms: payload.forms ?? [],
      messageTemplates: payload.messageTemplates ?? [],
      products: payload.products ?? [],
      workflows: payload.workflows ?? [],
    },
    subAccountIds,
    { agencyId, createdByUid: caller.uid },
  );

  return NextResponse.json({ results });
}
