import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { parseScheduleUpdate } from "@/lib/recurring/schedule-input";
import { toDate } from "@/lib/server/recurring-invoice-cycle";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

export const dynamic = "force-dynamic";

/**
 * One schedule: read it, edit it, pause, resume or cancel it.
 *
 * There is no DELETE. A schedule that has billed somebody is the record of
 * why those invoices exist, and `cancelled` stops it just as dead — the row
 * stays so the invoices it raised still lead somewhere.
 */

async function load(
  request: Request,
  subAccountId: string,
  recurringId: string,
) {
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return { error: auth };

  const ref = getAdminDb().doc(`recurringInvoices/${recurringId}`);
  const snap = await ref.get();
  const data = snap.data() as RecurringInvoiceDoc | undefined;
  // A wrong-tenant id reads as "not found", not "forbidden": telling a caller
  // which ids exist in another workspace is itself the leak.
  if (!snap.exists || data?.subAccountId !== subAccountId) {
    return {
      error: NextResponse.json({ error: "Schedule not found" }, { status: 404 }),
    };
  }
  return { ref, schedule: { ...data, id: snap.id } };
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; recurringId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, recurringId } = await ctx.params;
  const found = await load(request, subAccountId, recurringId);
  if (found.error) return found.error;
  return NextResponse.json({ schedule: found.schedule });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; recurringId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, recurringId } = await ctx.params;
  const found = await load(request, subAccountId, recurringId);
  if (found.error) return found.error;
  const { ref, schedule } = found;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseScheduleUpdate(
    body,
    {
      cadence: schedule.cadence,
      anchorDay: schedule.anchorDay,
      timezone: schedule.timezone,
      status: schedule.status,
      nextRunAt: toDate(schedule.nextRunAt),
      lastRunAt: toDate(schedule.lastRunAt),
    },
    new Date(),
  );
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { recomputeNextRunFrom, endAt, ...rest } = parsed.value;
  const updates: Record<string, unknown> = {
    ...rest,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (endAt !== undefined) {
    updates.endAt = endAt ? Timestamp.fromDate(endAt) : null;
  }
  if (recomputeNextRunFrom) {
    updates.nextRunAt = Timestamp.fromDate(recomputeNextRunFrom);
  }
  // Editing a schedule is the operator answering whatever the last run
  // complained about, so the stale complaint goes with the edit.
  if (Object.keys(rest).length > 0) updates.lastError = null;

  try {
    await ref.update(updates);
  } catch (err) {
    console.error("[recurring-invoices/patch] write failed", err);
    return NextResponse.json(
      { error: "Failed to update the schedule" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
