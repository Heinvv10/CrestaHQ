import "server-only";

import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { parseScheduleCreate } from "@/lib/recurring/schedule-input";
import { scheduleCreateDoc } from "@/lib/server/recurring-schedule-write";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Recurring-invoice schedules: list and create.
 *
 * **Admin-only, unlike one-off quotes.** A schedule is a standing instruction
 * to demand money from a customer every month under the client's brand, and
 * it keeps doing so with nobody watching. That is an owner-level act, and
 * requiring admin also keeps territory scoping out of this surface entirely:
 * admins are never territory-scoped, so there is no scoped collaborator who
 * could create a schedule for a contact outside their patch.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  // Equality-only, then sorted in memory: adding `orderBy` here would need a
  // composite index for a collection that holds a handful of documents per
  // workspace. The 500 cap is a runaway guard, not a page size.
  const snap = await getAdminDb()
    .collection("recurringInvoices")
    .where("subAccountId", "==", subAccountId)
    .limit(500)
    .get();

  const schedules = snap.docs
    .map((d) => ({ ...(d.data() as RecurringInvoiceDoc), id: d.id }))
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt));

  return NextResponse.json({ schedules });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contactId =
    typeof body.contactId === "string" ? body.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const db = getAdminDb();
  // The workspace's own zone is the default billing zone, so this read has to
  // happen before the payload can be judged. The contact read waits until the
  // payload is known good — a malformed cadence should not cost a lookup.
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data() as SubAccountDoc | undefined;

  const parsed = parseScheduleCreate(body, sub?.timezone ?? "UTC");
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const fields = parsed.value;

  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  const contact = contactSnap.data();
  if (!contactSnap.exists || contact?.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  // A schedule that cannot email anybody generates invoices nobody receives,
  // every cycle, and only announces it once the first send fails.
  if (typeof contact?.email !== "string" || !contact.email.trim()) {
    return NextResponse.json(
      { error: "That contact has no email address to send invoices to." },
      { status: 400 },
    );
  }

  const ref = db.collection("recurringInvoices").doc();
  const doc = scheduleCreateDoc({
    agencyId: auth.agencyId ?? (contact.agencyId as string),
    subAccountId,
    createdByUid: auth.uid,
    contactId,
    fields,
  });

  try {
    await ref.set(doc);
  } catch (err) {
    console.error("[recurring-invoices/create] write failed", err);
    return NextResponse.json(
      { error: "Failed to create the schedule" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { id: ref.id, nextRunAt: fields.nextRunAt.toISOString() },
    { status: 201 },
  );
}

/** Sort key for a Firestore timestamp that may not have resolved yet. */
function millis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}
