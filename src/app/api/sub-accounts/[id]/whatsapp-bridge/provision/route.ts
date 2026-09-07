import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  hasStoredBridgeCredentials,
  storeBridgeConnection,
} from "@/lib/comms/whatsapp/bridge-connection";
import { provisionTenant } from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";
import { resolveBridgeCreds } from "@/lib/comms/whatsapp/bridge-credentials";
import { requireWhatsappEnabledByAgency } from "@/lib/comms/whatsapp/bridge-agency-gate";
import { hasCurrentRiskAck } from "@/lib/comms/whatsapp/bridge-risk-ack";
import type { WhatsappBridgeMeta } from "@/types/whatsapp-bridge";

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
 * still has to scan a code, which is what GET ../qr renders.
 *
 * THE RISK ACKNOWLEDGEMENT IS ENFORCED HERE, not in the card. This rail is an
 * unofficial WhatsApp connection and the number can be banned, so a recorded
 * acknowledgement is a condition of provisioning rather than a checkbox. A
 * client-side check refuses nobody — this endpoint is one `curl` away from
 * anyone holding an admin session — and the record is worthless if the thing
 * it gates can happen without it.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  // Same gate as the manual connect route: an agency that has not turned
  // WhatsApp on for this workspace must not have a number provisioned for it,
  // let alone billed for it.
  const gate = await requireWhatsappEnabledByAgency(subAccountId);
  if (!gate.ok) return gate.response;
  const sub = gate.sub;

  // Checked AFTER the agency gate and BEFORE the manager is touched: a refusal
  // must not leave a half-provisioned tenant behind for someone to tear down.
  if (!(await hasCurrentRiskAck(subAccountId))) {
    return NextResponse.json(
      {
        error:
          "Accept the WhatsApp connection risks before connecting a number.",
      },
      { status: 403 },
    );
  }

  const result = await provisionTenant(subAccountId, sub.name ?? subAccountId);
  if (!result.ok) {
    if (result.reason === "conflict") {
      // A 409 is NOT always "this workspace already has a bridge". The manager
      // also refuses when a DIFFERENT tenant holds the instance name this id
      // derives (provision.checkInstanceFree and the SetTenantIdentity race),
      // and telling that caller to disconnect sends them somewhere useless:
      // the disconnect 404s, is treated as success, clears a rail that was
      // never set, and the retry fails identically.
      //
      // Classified from the CRM's OWN state, never from the manager's prose.
      // The manager's collision sentence names the other tenant — which is
      // another customer's sub-account id — so relaying it would hand this
      // workspace's admin the identity of a workspace they have no business
      // knowing exists. It goes to the server log, where a real collision
      // actually needs to be read, and no further.
      //
      // Stored credentials are the whole test: this workspace has a bridge if
      // and only if its secret doc is there.
      const ours = await hasStoredBridgeCredentials(subAccountId);
      console.error(
        `[whatsapp-bridge/provision] manager 409 for ${subAccountId} (ours=${ours}): ${result.error}`,
      );
      return NextResponse.json(
        {
          error: ours
            ? "This workspace already has a bridge on the manager. Disconnect it first, then provision again — that erases the WhatsApp session, so the number has to be re-paired."
            : // No remedy is offered because the admin has none: the name is
              // held by a workspace they cannot see, let alone disconnect.
              "This workspace can't be connected right now because its bridge name collides with another workspace. Contact support.",
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
  // The 201 above is the only moment these credentials exist outside the
  // bridge's own `.env`: the manager keeps no readable copy and there is no
  // rotation route. If the write fails they are gone, so say that and say the
  // remedy — an opaque 500 leaves an operator retrying a provision that will
  // now 409 forever. Nothing is cleaned up automatically on purpose: a destroy
  // on a failure path is how a bridge someone is mid-way through pairing gets
  // deleted.
  try {
    await storeBridgeConnection(subAccountId, creds, meta);
  } catch {
    return NextResponse.json(
      {
        error:
          "The bridge was created but its credentials couldn't be saved, and they can't be recovered. Disconnect this workspace's bridge and connect again — that erases the WhatsApp session, so the number has to be re-paired.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    provider: "bridge",
    state: result.data.state,
  });
}
