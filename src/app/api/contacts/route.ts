import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { isAssignableMember, parseAssignedToUid } from "@/lib/server/assignee";
import { resolveCompanyLink } from "@/lib/server/companies-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import {
  CONTACT_IDENTITY_ERROR,
  hasContactIdentity,
} from "@/lib/contacts/display-name";

/**
 * Dashboard-facing contact creation. The "Add contact" modal used to write
 * straight to Firestore from the browser (no server code → no webhook).
 * It now POSTs here so the create runs server-side and fires
 * `contact.created` through the shared service.
 *
 * Auth: any active member of the sub-account (collaborators included —
 * matches the Firestore rule that let members create contacts directly).
 */

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = str(body.subAccountId, 200);
  if (!subAccountId) {
    return NextResponse.json({ error: "subAccountId is required" }, { status: 400 });
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const name = str(body.name, 200);
  const email = str(body.email);
  const phone = str(body.phone);
  if (!hasContactIdentity({ name, email, phone })) {
    return NextResponse.json({ error: CONTACT_IDENTITY_ERROR }, { status: 400 });
  }

  // The sub-account doc is the source of truth for which agency to stamp.
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string) ?? access.agencyId ?? "";

  // Validate custom-field values against the sub-account's contact
  // definitions (same pattern as the deal routes).
  const defs = await loadCustomFieldDefs(subAccountId, "contact");
  const cf = validateCustomFieldValues(body.customFields, defs);
  if (!cf.ok) {
    return NextResponse.json({ error: cf.error }, { status: 400 });
  }

  const assignedToUid = parseAssignedToUid(body);
  if (
    typeof assignedToUid === "string" &&
    !(await isAssignableMember(subAccountId, assignedToUid))
  ) {
    return NextResponse.json(
      { error: "assignedToUid is not a member of this sub-account" },
      { status: 400 },
    );
  }
  // A linked company must belong to this sub-account; its name overrides
  // the free-text `company` so the two never disagree.
  let company = str(body.company);
  let companyId: string | null = null;
  if (typeof body.companyId === "string" && body.companyId) {
    const link = await resolveCompanyLink(getAdminDb(), subAccountId, body.companyId);
    if (!link.ok) {
      return NextResponse.json({ error: link.error }, { status: 400 });
    }
    company = link.company;
    companyId = link.companyId;
  }

  const { id, contact } = await createContactServerSide({
    subAccountId,
    agencyId,
    createdByUid: access.uid,
    // Dashboard writes are always live data — test-mode contacts only
    // come through the public API with a `lsk_test_*` key.
    mode: "live",
    name,
    email,
    phone,
    phoneCountry: (subSnap.data()?.defaultPhoneCountry as string) ?? null,
    company,
    companyId,
    address: str(body.address),
    source: str(body.source),
    tags: strArray(body.tags),
    territoryId: typeof body.territoryId === "string" ? body.territoryId : null,
    assignedToUid: assignedToUid ?? null,
    customFields: cf.value,
  });

  return NextResponse.json({ id, contact }, { status: 201 });
}
