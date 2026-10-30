import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { grantForOrder, orderDeliverable } from "@/lib/server/entitlements-service";
import type { Order } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * POST: staff "Re-send delivery". Re-runs every delivery on a paid product
 * order. Community grants are idempotent, so this only re-sends the emails
 * and retries anything that failed. Revoked (refunded) deliveries are
 * skipped. Sub-account admins and the agency owner only, like resolving an
 * order flag (order-attention). A held or flagged order is refused.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  const { id: subAccountId, orderId } = await params;
  if (!isDocId(subAccountId) || !isDocId(orderId)) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`orders/${orderId}`).get();
  const order = snap.exists ? ({ id: snap.id, ...snap.data() } as Order) : null;
  if (!order || order.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (!order.deliveries?.length) {
    return NextResponse.json({ error: "This order has nothing to deliver." }, { status: 400 });
  }
  if (!orderDeliverable(order)) {
    return NextResponse.json(
      { error: "Only paid orders that aren't held or flagged can be delivered." },
      { status: 409 },
    );
  }

  try {
    const result = await grantForOrder({ orderId, subAccountId }, { resend: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      `[orders/redeliver] failed order=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Couldn't re-send the delivery." }, { status: 500 });
  }
}
