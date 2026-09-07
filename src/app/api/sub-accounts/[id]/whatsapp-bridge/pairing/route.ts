import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getPairing } from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";

/**
 * Live pairing state for this workspace's bridge, so the settings screen can
 * render a QR the admin scans with their own phone.
 *
 * TENANCY — the manager tenant id is `params.id` and nothing else. The manager
 * accepts one global operator token and will relay the pairing code of ANY
 * tenant the path names (services/wa-manager/api/pair.go), so a tenant id read
 * from a query parameter here would hand any workspace admin a code that links
 * a device to another customer's WhatsApp number.
 *
 * THE CODE LEAVES THE SERVER, DELIBERATELY. It is a write-grade credential —
 * whoever scans it can send as that number — and it is nevertheless returned,
 * because the only person who can complete a pairing is the admin holding the
 * phone, and they cannot scan what they cannot see. What makes that acceptable
 * is that it goes to an authenticated admin OF THIS WORKSPACE, over the
 * session, for their own number, and that it expires in seconds. What is not
 * acceptable is it reaching a log: nothing here logs the response, and the
 * manager client is written not to log a body for the same reason.
 *
 * `code` and `expiresAt` are passed through as ABSENT when no pairing round is
 * in flight, never coerced to "". A blank code renders as a QR of nothing and
 * is indistinguishable from a missing one.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const result = await getPairing(subAccountId);
  if (!result.ok) return managerFailureResponse(result);

  const { pairing, connected, code, expiresAt } = result.data;
  return NextResponse.json({
    pairing,
    connected,
    ...(code === undefined ? {} : { code }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}
