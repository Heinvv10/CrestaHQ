import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  BridgeNotConfiguredError,
  resolveBridgeCreds,
} from "@/lib/comms/whatsapp/bridge-credentials";
import { bridgeHealth } from "@/lib/comms/whatsapp/bridge-client";
import {
  clearBridgeConnection,
  storeBridgeConnection,
} from "@/lib/comms/whatsapp/bridge-connection";
import type { WhatsappBridgeMeta } from "@/types/whatsapp-bridge";
import type { SubAccountDoc } from "@/types";

/**
 * Connect / disconnect a sub-account's wa-agent-bridge sender — the `bridge`
 * arm of the WhatsApp provider seam, and the only thing in the product that
 * writes the credentials the rest of that arm reads.
 *
 * POST   — `{ baseUrl, token, webhookSecret }`. Probed against the bridge's
 *          own /v1/health before anything is stored, then written and the
 *          workspace switched onto the bridge rail.
 * DELETE — disconnect: deletes the secret, clears the meta, and returns the
 *          workspace to Twilio.
 *
 * SECURITY — neither `token` nor `webhookSecret` ever goes on the sub-account
 * doc. `subAccounts/{id}` is readable by any active member and Firestore rules
 * are document-level, so a field there is readable by every collaborator seat.
 * Both secrets live at `subAccounts/{id}/private/whatsappBridge`, covered by
 * the generic `match /private/{docId} { allow read, write: if false }` rule —
 * verified in firestore.rules, no rules deploy needed. Only the display number
 * goes on the doc, and no response body ever contains a secret.
 *
 * Unlike the cloud route there is no cross-workspace uniqueness check. The
 * cloud rail needs one because its inbound webhook resolves a workspace by
 * phone_number_id; the bridge webhook is addressed per sub-account in its own
 * URL, so two workspaces on one bridge is unambiguous rather than a routing
 * hazard.
 */

interface PostBody {
  baseUrl?: string;
  token?: string;
  webhookSecret?: string;
}

/**
 * Verify the credentials actually work BEFORE storing them — same reasoning as
 * the cloud route: the first sign of a bad paste is otherwise a customer
 * message that silently fails to send, days later.
 *
 * Reading a bad token off /v1/health takes a little care. That endpoint is
 * deliberately UNauthenticated (a monitor must be able to reach it), so a
 * rejected token still yields 200 with `connected`. What the token gates is the
 * `number` field. A connected bridge always has a paired session and therefore
 * a non-empty number — see wa/whatsmeow.go, where Connected() implies a
 * non-nil session store ID — so `connected && number === null` can only mean
 * the token was refused. That is why the three checks below run in this order,
 * and why a connect can never succeed on a token the bridge does not accept.
 *
 * The one case this cannot separate is a bad token on a bridge whose session is
 * also down: it reports the disconnected session, which is true and actionable,
 * and the token failure surfaces on the retry after re-pairing.
 */
function probeFailure(health: {
  reachable: boolean;
  connected: boolean;
  killed: boolean;
  number: string | null;
}): string | null {
  if (!health.reachable) {
    return "Couldn't reach the bridge at that URL. Check the address and that the bridge process is running.";
  }
  if (!health.connected) {
    return "The bridge is running but its WhatsApp session is disconnected. Re-pair the number, then connect again.";
  }
  if (health.number === null) {
    return "The bridge rejected that token. Check you pasted this workspace's consumer token and not another one.";
  }
  if (health.killed) {
    // Checked here as well as in readiness, because a connect that succeeds
    // against a killed bridge hands the operator a workspace that looks
    // connected and refuses every send — the same "reads as broken rather
    // than as a brake somebody has to release" confusion that readiness was
    // just fixed to avoid, reintroduced one layer up. Connect-time is also
    // the cheaper place to say it: the operator is standing right there.
    return "The bridge's kill switch is on, so it would accept this connection and then refuse every message. Lift the kill switch, then connect again.";
  }
  return null;
}

/** The bridge reports the paired number as bare digits; the CRM stores E.164. */
function toE164(number: string): string {
  return number.startsWith("+") ? number : `+${number}`;
}

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
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (sub.whatsappEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
      },
      { status: 403 },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // `resolveBridgeCreds` is the validator the read path already uses: it trims,
  // rejects blanks, parses the URL and strips trailing slashes. A second
  // validator here would be free to drift from the one that decides whether the
  // stored credentials are usable. Its thrown message is written for the read
  // path ("pair a number and save…"), so the shape failures collapse into one
  // message written for the operator standing in front of this form.
  let creds;
  try {
    creds = resolveBridgeCreds(body, subAccountId);
  } catch (err) {
    if (err instanceof BridgeNotConfiguredError) {
      return NextResponse.json(
        {
          error:
            "Bridge URL, token and webhook secret are all required, and the bridge URL must be a full http:// or https:// address.",
        },
        { status: 400 },
      );
    }
    throw err;
  }

  const health = await bridgeHealth(creds);
  const failure = probeFailure(health);
  if (failure) {
    return NextResponse.json({ error: failure }, { status: 400 });
  }

  const meta: WhatsappBridgeMeta = {
    displayPhoneNumber: health.number ? toE164(health.number) : null,
    connectedAt: FieldValue.serverTimestamp(),
    connectedByUid: auth.uid,
  };

  await storeBridgeConnection(subAccountId, creds, meta);

  return NextResponse.json({
    ok: true,
    provider: "bridge",
    displayPhoneNumber: meta.displayPhoneNumber,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  // Disconnect stays ungated so a workspace can always be cleaned up even
  // after the agency turns the feature off. The fallback-rail reasoning lives
  // in clearBridgeConnection.
  const fallback = await clearBridgeConnection(subAccountId);

  return NextResponse.json({ ok: true, provider: fallback });
}
