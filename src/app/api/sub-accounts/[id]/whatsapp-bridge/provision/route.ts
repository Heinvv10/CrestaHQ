import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  hasStoredBridgeCredentials,
  storeBridgeConnection,
} from "@/lib/comms/whatsapp/bridge-connection";
import {
  managerHasTenant,
  provisionTenant,
} from "@/lib/comms/whatsapp/manager-client";
import { managerFailureResponse } from "@/lib/comms/whatsapp/manager-failure";
import { resolveBridgeCreds } from "@/lib/comms/whatsapp/bridge-credentials";
import { requireWhatsappEnabledByAgency } from "@/lib/comms/whatsapp/bridge-agency-gate";
import { hasCurrentRiskAck } from "@/lib/comms/whatsapp/bridge-risk-ack";
import {
  WA_BRIDGE_RISK_TEXT_ID,
  type WhatsappBridgeMeta,
} from "@/types/whatsapp-bridge";

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
      // The question that separates the two is "does the manager hold a tenant
      // with THIS id", so it is put to the manager. It is NOT inferred from the
      // stored credentials: a bridge can be running for this id with no secret
      // doc behind it — every failure between the manager's 201 and the
      // Firestore commit below leaves exactly that orphan, and the token is
      // unrecoverable, so the orphan is permanent until someone disconnects.
      // Inferring sent that admin to "contact support" for a state Disconnect
      // recovers on its own.
      //
      // Disconnect is therefore the remedy for BOTH tenant-exists cases. It
      // destroys the manager tenant whether or not the CRM has credentials,
      // and clears a rail that may never have been set; the reconnect that
      // follows is a fresh provision of a name that is now free.
      //
      // The manager's own prose is never relayed. Its collision sentence names
      // the other tenant — another customer's sub-account id — so it goes to
      // the server log, where a real collision actually needs to be read, and
      // no further.
      const probe = await managerHasTenant(subAccountId);
      // A manager that cannot be asked leaves the question open, and the two
      // answers are not interchangeable. Falling back to the stored
      // credentials keeps the degraded classification pointed at the case the
      // CRM can still see for itself rather than guessing "collision".
      const theirs = probe.ok
        ? probe.data
        : await hasStoredBridgeCredentials(subAccountId);
      console.error(
        `[whatsapp-bridge/provision] manager 409 for ${subAccountId} (tenantExists=${theirs}, probed=${probe.ok}): ${result.error}`,
      );
      // Three cases, three sentences. The degraded one is its own because the
      // other two each assert something this branch did NOT determine: the
      // probe failed and the CRM holds no credentials, so "you already have a
      // bridge" and "another workspace holds the name" are both guesses. The
      // collision sentence is the more expensive guess to get wrong — it ends
      // in "contact support" and withholds Disconnect, which is what actually
      // recovers the orphan this branch most often really is.
      let error: string;
      if (theirs) {
        error =
          "This workspace already has a bridge on the manager. Disconnect it first, then provision again — that erases the WhatsApp session, so the number has to be re-paired.";
      } else if (probe.ok) {
        // No remedy is offered because the admin has none: the name is held by
        // a workspace they cannot see, let alone disconnect.
        error =
          "This workspace can't be connected right now because its bridge name collides with another workspace. Contact support.";
      } else {
        error =
          "This workspace can't be connected right now, and the bridge manager couldn't be reached to check why — so we can't say whether this workspace already has a bridge or whether another workspace holds its name. Disconnecting this workspace's bridge and connecting again is worth trying: it clears a half-finished connection. It erases the WhatsApp session, so the number has to be re-paired. If that doesn't help, contact support.";
      }
      return NextResponse.json({ error }, { status: 409 });
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
  //
  // Nothing is stored and nothing is destroyed, so the tenant the manager just
  // 201'd is left running with its token discarded — the same unrecoverable
  // loss the store-failure branch below answers, and it needs the same remedy
  // rather than "provision again", which can only 409 from here. Auto-destroy
  // is deliberately NOT done: a destroy on a failure path is how a bridge
  // someone is mid-way through pairing gets deleted.
  let creds;
  try {
    creds = resolveBridgeCreds(raw, subAccountId);
  } catch {
    // The only branch here that used to return without logging, which is
    // exactly the branch a manager too old to return credentials at all falls
    // into: the tenant is created, the CRM stores nothing, and the journal
    // says nothing happened. Presence booleans only — these two values are the
    // credentials themselves and are never written to a log.
    console.error(
      `[whatsapp-bridge/provision] manager 201 for ${subAccountId} carried no usable credentials (token=${Boolean(
        raw.token,
      )}, webhookSecret=${Boolean(
        raw.webhookSecret,
      )}); its tenant is left orphaned`,
    );
    // Which of the two the manager omitted is NOT asserted to the admin. This
    // sentence used to name the webhook secret and send them to configure one,
    // which is the wrong remedy — and the wrong diagnosis — whenever the token
    // is the missing half. The remedy that holds for every shape of this
    // failure is the one given, and the log above carries the detail for
    // whoever can act on it.
    return NextResponse.json(
      {
        error:
          "The bridge manager created this workspace's bridge but didn't return the credentials it needs, so the bridge can't send or receive and those credentials can't be recovered. Disconnect this workspace's bridge and connect again — that erases the WhatsApp session, so the number has to be re-paired. If it happens again, the bridge manager itself needs attention.",
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
    // The ack version is passed because this route GATED on it above — see
    // `hasCurrentRiskAck`. The manual connect route has no such gate and
    // passes nothing, so its record makes no claim about a warning.
    await storeBridgeConnection(subAccountId, creds, meta, {
      riskTextId: WA_BRIDGE_RISK_TEXT_ID,
    });
  } catch (err) {
    console.error(
      `[whatsapp-bridge/provision] storing minted credentials failed for ${subAccountId}; they are unrecoverable:`,
      err,
    );
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
