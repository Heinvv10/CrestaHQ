import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { clearBridgeConnection } from "@/lib/comms/whatsapp/bridge-connection";
import { destroyTenant } from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";

/**
 * Disconnect: destroy this workspace's manager tenant AND clear the CRM rail.
 *
 * TENANCY — `params.id`, validated by requireSubAccountAdmin. The manager
 * destroys whatever tenant the path names, so a caller-supplied id here would
 * be a one-request erase of another customer's WhatsApp session.
 *
 * THIS IS IRREVERSIBLE on the manager side: the unit, the instance directory
 * and the WhatsApp session are gone, and the customer must scan a fresh code
 * to come back. The manager enforces that by refusing a delete without
 * `?confirm=<id>`; `destroyTenant` supplies it.
 *
 * Order matters. The manager tenant is destroyed FIRST, and a failure there
 * aborts before the CRM rail is touched: clearing the rail first would delete
 * the only copy of the credentials this deployment has — there is no route
 * that reads a stored token back — leaving a running bridge nothing can
 * address and nothing can tear down through the product.
 *
 * A manager that never had this tenant (404) is treated as success: the rail
 * still needs clearing, and refusing to clean up a workspace because the thing
 * it points at is already gone is how a workspace gets stuck pointed at a
 * bridge that does not exist.
 *
 * NO AGENCY FEATURE GATE HERE, and that is a decision rather than an omission.
 * ../provision, ../pairing, ../restart and ../qr all refuse a workspace whose
 * agency has switched WhatsApp off, because each of them creates a bridge or
 * hands out a device-linking credential. Disconnecting does neither — it only
 * takes one away — and a workspace whose gate was JUST switched off is
 * precisely the one that may need to tear its bridge down. A gate on the
 * off-switch would strand it with a running bridge nothing in the product can
 * address. The tenancy check above still stands: only this workspace's own
 * admins may fire it.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const result = await destroyTenant(subAccountId);
  if (!result.ok && !(result.reason === "refused" && result.status === 404)) {
    return managerFailureResponse(result);
  }

  // The manager tenant is gone by here. If the CRM write fails now, the
  // workspace is left on `whatsappProvider: "bridge"` holding credentials for
  // a bridge that no longer exists, and every outbound WhatsApp send fails
  // until somebody notices. Retrying is safe and is the whole remedy: a
  // manager with no such tenant answers 404, which the guard above treats as
  // success, so a second disconnect goes straight to this write.
  let fallback;
  try {
    fallback = await clearBridgeConnection(subAccountId);
  } catch {
    return NextResponse.json(
      {
        error:
          "The bridge was destroyed but this workspace couldn't be taken off it, so WhatsApp sending stays broken until it is. Disconnect again — the bridge is already gone, and repeating it is safe.",
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, provider: fallback });
}
