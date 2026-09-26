import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { validateFieldDefInput } from "@/lib/custom-fields/validation";
import { createCustomField } from "@/lib/custom-fields/write";
import type { CustomFieldDef } from "@/types/custom-fields";

/**
 * Custom-field definitions per sub-account.
 *
 * GET  — list definitions (optionally `?entity=contact|deal`). Member-readable.
 * POST — create a definition. Sub-account admin only. Generates a stable
 *        snake_case `key` from the label, unique within (sub-account, entity).
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const entity = new URL(request.url).searchParams.get("entity");
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/customFields`)
    .get();
  let fields = snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldDef, "id">) }),
  );
  if (entity === "contact" || entity === "deal") {
    fields = fields.filter((f) => f.entity === entity);
  }
  fields.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return NextResponse.json({ ok: true, fields });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateFieldDefInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const created = await createCustomField({
    subAccountId,
    createdByUid: access.uid,
    input: validated.value,
  });
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status });
  }
  return NextResponse.json({ ok: true, id: created.id, key: created.key });
}
