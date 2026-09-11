import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  updateContactServerSide,
  type UpdateContactPatch,
} from "@/lib/server/contacts-service";
import {
  deleteContactServerSide,
  findContactBlockers,
} from "@/lib/server/contact-delete";
import { isAssignableMember, parseAssignedToUid } from "@/lib/server/assignee";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import type { Contact } from "@/types/contacts";
import type { MemberStatus, Role } from "@/types";

/**
 * Delete a contact — but ONLY when nothing else points at it.
 *
 * Auth model: caller must be a sub-account ADMIN of the contact's
 * sub-account (or the agency owner). Collaborators can edit but not
 * delete — matches the rule for `contacts/{id}` where delete requires
 * canAdminSub.
 *
 * Reference guard: the delete is refused with 409 when the contact is
 * still linked to a deal, task, calendar event / booking, quote / invoice,
 * web-chat conversation, or voice call. The 409 body carries a `blockers`
 * list (type + count) so the UI can explain what to clear first. A GET on
 * this route runs the same check as a read-only dry-run (200 with
 * `deletable` + `blockers`, no writes) for the confirm modal.
 *
 * Form submissions deliberately do NOT block — they cascade with the
 * contact (a submission is the inbound event that created the contact,
 * same category as its notes/activities, and no per-submission delete
 * exists anywhere else).
 *
 * When allowed, a recursive delete wipes the contact + its own
 * subcollections (notes / activities / messages), sweeps the contact's
 * form submissions, and fires contact.deleted.
 */

interface CallerClaims {
  status?: MemberStatus;
  agencyId?: string | null;
  agencyRole?: "owner" | "staff" | null;
  role?: Role;
}

async function readCaller(request: Request): Promise<
  | { uid: string; email: string; claims: CallerClaims }
  | NextResponse
> {
  const uid = request.headers.get("x-user-uid");
  if (!uid) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const auth = getAdminAuth();
  const record = await auth.getUser(uid).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const claims = (record.customClaims ?? {}) as CallerClaims;
  if (claims.status !== "active") {
    return NextResponse.json({ error: "Account inactive" }, { status: 403 });
  }
  return { uid, email: record.email ?? "", claims };
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Update a contact's plain fields + emit `contact.updated`. Any active
 * member may edit (matches the old client-SDK write rule). Territory moves
 * are NOT handled here — the dashboard routes those through the dedicated
 * territory fan-out endpoint.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const data = snap.data() as Omit<Contact, "id">;

  const access = await requireSubAccountMember(request, data.subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: UpdateContactPatch = {};
  if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 200);
  if (typeof body.email === "string") patch.email = str(body.email);
  if (typeof body.phone === "string") {
    // Lenient E.164 normalization against the workspace's default country
    // (one extra doc read, only when the phone is actually being edited).
    const rawPhone = str(body.phone);
    if (rawPhone) {
      const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
      patch.phone = normalizePhoneLenient(
        rawPhone,
        (subSnap.data()?.defaultPhoneCountry as string) ?? null,
      );
    } else {
      patch.phone = "";
    }
  }
  if (typeof body.company === "string") patch.company = str(body.company);
  if (typeof body.address === "string") patch.address = str(body.address);
  if (typeof body.source === "string") patch.source = str(body.source);
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (body.pipelineStage === null || typeof body.pipelineStage === "string") {
    patch.pipelineStage =
      typeof body.pipelineStage === "string" ? body.pipelineStage : null;
  }
  // Validate only a CHANGED assignee: the edit form echoes the stored uid,
  // and a member removed since must not lock every other field's edit.
  const assignedToUid = parseAssignedToUid(body);
  if (
    typeof assignedToUid === "string" &&
    assignedToUid !== (data.assignedToUid ?? null) &&
    !(await isAssignableMember(data.subAccountId, assignedToUid))
  ) {
    return NextResponse.json(
      { error: "assignedToUid is not a member of this sub-account" },
      { status: 400 },
    );
  }
  if (assignedToUid !== undefined) patch.assignedToUid = assignedToUid;
  // customFields is a full replacement of the value map when provided,
  // validated against the sub-account's live contact definitions.
  if (body.customFields !== undefined) {
    const defs = await loadCustomFieldDefs(data.subAccountId, "contact");
    const cf = validateCustomFieldValues(body.customFields, defs);
    if (!cf.ok) {
      return NextResponse.json({ error: cf.error }, { status: 400 });
    }
    patch.customFields = cf.value;
  }

  const result = await updateContactServerSide({
    contactId: id,
    patch,
    mode: (data as { mode?: "live" | "test" }).mode ?? "live",
  });
  if (!result) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return NextResponse.json({ contact: result.contact });
}

/**
 * Shared authorisation for the deletability check + the delete itself: the
 * caller must be the agency owner of the contact's agency OR an admin of its
 * sub-account. Returns a 403 NextResponse when not allowed, else null.
 */
async function ensureContactAdmin(
  db: FirebaseFirestore.Firestore,
  caller: { uid: string; claims: CallerClaims },
  agencyId: string,
  subAccountId: string,
): Promise<NextResponse | null> {
  const isAgencyOwner =
    caller.claims.agencyRole === "owner" && caller.claims.agencyId === agencyId;
  if (isAgencyOwner) return null;

  const memberSnap = await db
    .doc(`subAccounts/${subAccountId}/subAccountMembers/${caller.uid}`)
    .get();
  const member = memberSnap.data();
  const isSubAccountAdmin =
    memberSnap.exists &&
    member?.status === "active" &&
    member?.role === "admin";
  if (isSubAccountAdmin) return null;

  return NextResponse.json(
    { error: "Only sub-account admins can delete contacts." },
    { status: 403 },
  );
}

/**
 * Read-only deletability check for the confirm modal. The client calls this
 * (GET) before showing the confirm/blocked state: it reports whether the
 * contact can be deleted and, if not, what's still linked to it. No writes.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await readCaller(request);
  if (caller instanceof NextResponse) return caller;

  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const { agencyId, subAccountId } = snap.data() as Omit<Contact, "id">;

  const denied = await ensureContactAdmin(db, caller, agencyId, subAccountId);
  if (denied) return denied;

  const { blockers } = await findContactBlockers(db, subAccountId, id);
  return NextResponse.json({ deletable: blockers.length === 0, blockers });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const caller = await readCaller(request);
  if (caller instanceof NextResponse) return caller;

  const db = getAdminDb();
  const snap = await db.doc(`contacts/${id}`).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  const { agencyId, subAccountId } = snap.data() as Omit<Contact, "id">;

  const denied = await ensureContactAdmin(db, caller, agencyId, subAccountId);
  if (denied) return denied;

  const result = await deleteContactServerSide({ contactId: id });
  if (result.status === "blocked") {
    return NextResponse.json(
      {
        error:
          "This contact is linked to other records and can't be deleted. Remove or reassign them first.",
        blockers: result.blockers,
      },
      { status: 409 },
    );
  }
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, contactId: id });
}
