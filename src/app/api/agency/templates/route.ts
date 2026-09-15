import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { captureEntity, TemplateCaptureError } from "@/lib/templates/capture";
import { parseTemplateMeta } from "@/lib/templates/validate";
import { SNAPSHOT_VERSION } from "@/types/snapshots";
import {
  AGENCY_TEMPLATE_KINDS,
  TEMPLATE_NAME_MAX,
  type AgencyTemplateKind,
  type AgencyTemplateSummary,
} from "@/types/templates";

/** GET — list this agency's library templates. Summaries only, no payload. */
export async function GET(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  const snap = await getAdminDb()
    .collection(`agencies/${caller.agencyId}/templates`)
    .orderBy("createdAt", "desc")
    .get();

  const templates: AgencyTemplateSummary[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      kind: data.kind,
      name: data.name ?? "",
      description: data.description ?? "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      sourceSubAccountId: data.sourceSubAccountId ?? "",
      includesTriggerForm:
        data.kind === "workflow" && (data.payload?.forms?.length ?? 0) > 0,
      createdAt: data.createdAt?.toMillis?.() ?? null,
      updatedAt: data.updatedAt?.toMillis?.() ?? null,
    };
  });

  return NextResponse.json({ templates });
}

/** POST — capture one entity from a sub-account into the library. */
export async function POST(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId!;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subAccountId =
    typeof body.subAccountId === "string" ? body.subAccountId.trim() : "";
  const entityId =
    typeof body.entityId === "string" ? body.entityId.trim() : "";
  const kind = body.kind as AgencyTemplateKind;
  if (!subAccountId || !entityId) {
    return NextResponse.json(
      { error: "subAccountId and entityId are required." },
      { status: 400 },
    );
  }
  if (!AGENCY_TEMPLATE_KINDS.includes(kind)) {
    return NextResponse.json(
      { error: "kind must be workflow, email or form." },
      { status: 400 },
    );
  }
  const parsed = parseTemplateMeta(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const db = getAdminDb();
  let captured;
  try {
    captured = await captureEntity(db, { agencyId, subAccountId }, kind, entityId);
  } catch (err) {
    if (err instanceof TemplateCaptureError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // The entity's own name is the default; an empty one still needs a label.
  const name =
    parsed.meta.name ?? captured.entityName.trim().slice(0, TEMPLATE_NAME_MAX);
  if (!name) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  const ref = db.collection(`agencies/${agencyId}/templates`).doc();
  await ref.set({
    id: ref.id,
    agencyId,
    createdByUid: caller.uid,
    kind,
    name,
    description: parsed.meta.description ?? "",
    tags: parsed.meta.tags ?? [],
    sourceSubAccountId: subAccountId,
    payload: captured.payload,
    version: SNAPSHOT_VERSION,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({
    templateId: ref.id,
    name,
    includesTriggerForm: captured.includesTriggerForm,
  });
}
