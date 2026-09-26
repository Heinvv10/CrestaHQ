import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { commitWithProration } from "@/lib/server/recurring-prorate";
import { afterScheduleEdit, planScheduleEdit } from "@/lib/server/recurring-schedule-write";
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

  const now = new Date();
  const planned = planScheduleEdit(schedule, body, now);
  if (!planned.ok) {
    return NextResponse.json({ error: planned.error }, { status: 400 });
  }
  const { edit } = planned;
  const { updates, proration } = edit;
  try {
    if (!proration) await ref.update(updates);
    else if (!(await commitWithProration(ref, schedule, updates))) {
      return NextResponse.json(
        { error: "The schedule changed while you were editing it. Reload it and try again." },
        { status: 409 },
      );
    }
  } catch (err) {
    console.error("[recurring-invoices/patch] write failed", err);
    return NextResponse.json(
      { error: "Failed to update the schedule" },
      { status: 500 },
    );
  }

  await afterScheduleEdit(ref, schedule, edit, now);
  return NextResponse.json({ ok: true });
}
