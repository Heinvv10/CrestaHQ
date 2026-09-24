import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { canSeeTerritory, territoryScopeFor } from "@/lib/ai-suite/territory-scope";

const STATUSES = new Set([
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
  "unsettled",
]);

/**
 * List a sub-account's agent proposals, newest first (optionally one
 * `?status=`), for any member — minus rows whose contact is outside a
 * territory-scoped caller's territories (a preview carries the contact's name
 * and the message). Rows with no contact stay visible.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !STATUSES.has(status)) {
    return NextResponse.json({ error: "Unknown status" }, { status: 400 });
  }
  let q = getAdminDb()
    .collection("agentProposals")
    .where("subAccountId", "==", subAccountId);
  if (status) q = q.where("status", "==", status);
  const snap = await q.orderBy("createdAt", "desc").limit(100).get();
  const scope = await territoryScopeFor({ ...access, subAccountId });
  const contactIds = [
    ...new Set(
      snap.docs
        .map((d) => d.data().contactId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const db = getAdminDb();
  const contacts = contactIds.length
    ? await db.getAll(...contactIds.map((id) => db.doc(`contacts/${id}`)))
    : [];
  const territoryOf = new Map(contacts.map((c) => [c.id, c.data()?.territoryId]));
  const visible = snap.docs.filter((d) => {
    const contactId = d.data().contactId;
    return (
      typeof contactId !== "string" ||
      canSeeTerritory(scope, territoryOf.get(contactId))
    );
  });
  return NextResponse.json({
    proposals: visible.map((d) => ({ id: d.id, ...d.data() })),
  });
}
