import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import type { LaunchpadCounts } from "@/lib/launchpad/checklist";

/**
 * GET /api/sub-accounts/[id]/launchpad — the counts the Launchpad checklist
 * can't (or shouldn't) read client-side. Any active member.
 *
 * `workflows` denies all client reads (server-only, like every other
 * automation collection), so this route is Admin SDK for every count rather
 * than mixing client Firestore reads with one server exception — one place
 * to read, one shape to test.
 *
 * A per-member Google Calendar connection has no member-readable summary
 * field on the sub-account doc (only the credential-bearing per-uid doc at
 * `private/googleCalendar_{uid}`), so "connected" here means ANY member has
 * one — the point of the checklist item is "can this workspace's bookings
 * reach a Google Calendar", not "did the current caller connect one".
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();

  const [contactsSnap, formsSnap, bookingPagesSnap, workflowsSnap, privateSnap] =
    await Promise.all([
      db.collection("contacts").where("subAccountId", "==", id).count().get(),
      db.collection("forms").where("subAccountId", "==", id).count().get(),
      db.collection(`subAccounts/${id}/bookingPages`).count().get(),
      // No composite index for (subAccountId, status) exists — that pairing
      // isn't queried anywhere else — so this reads status only for every
      // workflow in the sub-account (a small, admin-managed list) and
      // filters in memory rather than requesting a new index.
      db
        .collection("workflows")
        .where("subAccountId", "==", id)
        .select("status")
        .get(),
      db.collection(`subAccounts/${id}/private`).select("status").get(),
    ]);

  const activeWorkflows = workflowsSnap.docs.filter(
    (d) => d.data().status === "active",
  ).length;

  const googleCalendarConnected = privateSnap.docs.some(
    (d) => d.id.startsWith("googleCalendar_") && d.data().status === "connected",
  );

  const counts: LaunchpadCounts = {
    contacts: contactsSnap.data().count,
    forms: formsSnap.data().count,
    activeWorkflows,
    bookingPages: bookingPagesSnap.data().count,
    googleCalendarConnected,
  };

  return NextResponse.json(counts);
}
