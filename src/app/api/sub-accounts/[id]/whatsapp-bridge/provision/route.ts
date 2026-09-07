import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { storeBridgeConnection } from "@/lib/comms/whatsapp/bridge-connection";
import { provisionTenant } from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";
import { resolveBridgeCreds } from "@/lib/comms/whatsapp/bridge-credentials";
import type { WhatsappBridgeMeta } from "@/types/whatsapp-bridge";
import type { SubAccountDoc } from "@/types";

/**
 * Provision this sub-account its own wa-agent-bridge, without a human on the
 * box.
 *
 * TENANCY — the manager tenant id is `params.id`, the sub-account segment
 * `requireSubAccountAdmin` has just validated the caller's membership against.
 * It is never read from the body or the query, and this route accepts no body
 * at all. The manager has one global operator token and no notion of tenant
 * ownership (services/wa-manager/api/server.go), so a tenant id taken from the
 * caller would let any workspace admin provision — and then pair a device on —
 * any other workspace's number. The CRM is the tenancy boundary; this line is
 * where it is drawn.
 *
 * The manager's 201 is the ONLY moment the app consumer's token and webhook
 * secret exist outside the bridge's own `.env`. They are stored here, in the
 * same batch that switches the workspace onto the bridge rail, before this
 * handler returns — a dropped response means destroy-and-reprovision, which
 * costs the customer a re-pair.
 *
 * The response carries no credential. Provisioning does not pair: the customer
 * still has to scan a code, which is what GET ../pairing is for.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  // Same gate as the manual connect route: an agency that has not turned
  // WhatsApp on for this workspace must not have a number provisioned for it,
  // let alone billed for it.
  if (sub.whatsappEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
      },
      { status: 403 },
    );
  }

  const result = await provisionTenant(subAccountId, sub.name ?? subAccountId);
  if (!result.ok) {
    if (result.reason === "conflict") {
      // The manager already has a tenant under this id, and its credentials
      // are unrecoverable by design — there is no route that reads a stored
      // token back. Retrying cannot help, so say what actually clears it.
      return NextResponse.json(
        {
          error:
            "This workspace already has a bridge on the manager. Disconnect it first, then provision again — that erases the WhatsApp session, so the number has to be re-paired.",
        },
        { status: 409 },
      );
    }
    return managerFailureResponse(result);
  }

  // The bridge listens on loopback only — the manager renders
  // `LISTEN_ADDR=127.0.0.1:<port>` into every instance's `.env` and addresses
  // them the same way itself (api.New's BridgeBaseURL default). The CRM runs
  // on the same box, so there is no host to configure and deliberately no env
  // var for one: a configurable host here would be a way to point a
  // workspace's sends at something that is not its bridge.
  const raw = {
    baseUrl: `http://127.0.0.1:${result.data.port}`,
    token: result.data.token,
    webhookSecret: result.data.webhookSecret,
  };

  // Validated with the same resolver the read path uses, so a manager that
  // provisioned an UNSIGNED tenant (no webhook-secret generator configured) is
  // caught here rather than at the first inbound message. An unsigned rail
  // accepts anything that can reach the webhook URL.
  let creds;
  try {
    creds = resolveBridgeCreds(raw, subAccountId);
  } catch {
    return NextResponse.json(
      {
        error:
          "The bridge manager provisioned this workspace without a webhook signing secret, so inbound messages could not be verified. Ask your agency to configure the manager's webhook secret, then provision again.",
      },
      { status: 502 },
    );
  }

  const meta: WhatsappBridgeMeta = {
    // Nothing is paired yet — the number is unknown until the customer scans.
    displayPhoneNumber: null,
    connectedAt: FieldValue.serverTimestamp(),
    connectedByUid: auth.uid,
  };
  await storeBridgeConnection(subAccountId, creds, meta);

  return NextResponse.json({
    ok: true,
    provider: "bridge",
    state: result.data.state,
  });
}
