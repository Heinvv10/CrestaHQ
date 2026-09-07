import "server-only";

import { NextResponse } from "next/server";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getPairing } from "@/lib/comms/whatsapp/manager-client";
import { hasStoredBridgeCredentials } from "@/lib/comms/whatsapp/bridge-connection";
import { requireWhatsappEnabledByAgency } from "@/lib/comms/whatsapp/bridge-agency-gate";
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
 * THE CODE NEVER LEAVES THE SERVER. It is a write-grade credential — whoever
 * scans it can send as that number — and the admin holding the phone can only
 * scan a picture, not a string, so the string has no reason to cross at all.
 * It is destructured out and stranded in a local rather than merely not being
 * read, so a later `...result.data` spread cannot quietly reintroduce it. The
 * scannable form is the PNG at `../qr`, which the manager renders.
 *
 * This route answers only the QUESTION the screen asks — is a round in flight,
 * is it connected, when does the code lapse. `expiresAt` is passed through as
 * ABSENT when no round is in flight, never coerced to "": "" parses as the
 * epoch, and a caller cannot tell a blank timestamp from a missing one.
 *
 * `credentialsStored` is the fourth thing the screen has to know and the only
 * one the manager cannot answer. A bridge can be running for this workspace
 * with no credentials behind it — the provisioning 201 is the only moment the
 * token exists outside the bridge's `.env`, so any failure after it leaves an
 * orphan the CRM can never address. Derived from the manager alone, the screen
 * shows that state as an ordinary pairing round and invites the admin to link
 * a real number to a rail that can never send. It is a BOOLEAN: only whether
 * the secret document exists, never anything out of it.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  // The agency feature gate, same check and same refusal as ../provision. A
  // workspace whose agency has switched WhatsApp off must not be able to pull
  // a live pairing credential or mint fresh ones; without this the gate only
  // stops NEW bridges and leaves every existing one fully operable.
  const gate = await requireWhatsappEnabledByAgency(subAccountId);
  if (!gate.ok) return gate.response;

  const result = await getPairing(subAccountId);
  if (!result.ok) return managerFailureResponse(result);

  // `code` is named only to strand it in a local the response cannot reach.
  const { pairing, connected, code: _code, expiresAt } = result.data;
  // Read only once the manager has confirmed a bridge exists: with no tenant
  // the route has already answered 404 and the question does not arise.
  const credentialsStored = await hasStoredBridgeCredentials(subAccountId);
  return NextResponse.json({
    pairing,
    connected,
    credentialsStored,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}
