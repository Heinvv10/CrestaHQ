import "server-only";

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyWebhookSignature } from "@/lib/api/webhooks/signing";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { getBridgeCreds } from "@/lib/comms/whatsapp/bridge-credentials";
import { isGroupJid, jidToE164 } from "@/lib/comms/whatsapp/bridge-client";
import { resolveProviderForSubAccount } from "@/lib/comms/whatsapp/resolve-provider";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * wa-agent-bridge inbound webhook —
 * `POST /api/webhooks/whatsapp/bridge/{subAccountId}`.
 *
 * Deliberately mirrors /api/webhooks/whatsapp-cloud step for step, so flipping
 * a sub-account between rails changes the transport and nothing the operator
 * can see: same contact reconciliation, same rows, same inbox index, same AI.
 *
 * Differences forced by the transport:
 *   - Routing is the sub-account id in the URL: untrusted routing info that
 *     only picks WHICH stored credentials to check (per-SA Stripe's model).
 *   - Authenticity is BOTH the `LeadStack-Signature` HMAC over the raw body
 *     (our own scheme, verified by lib/api/webhooks/signing.ts) AND the bearer
 *     token. The signature proves the body; the token proves the caller — a
 *     bridge pointed at another workspace's URL fails the second even when it
 *     signs the first correctly.
 *   - Senders are WhatsApp JIDs carrying a device suffix, and there is no
 *     ProfileName, so an auto-created contact is phone-only.
 *
 * Answers 200 on every accepted path: the bridge warns on any status >= 300.
 */

const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

const ok = (body: Record<string, unknown> = { ok: true }) =>
  NextResponse.json(body, { status: 200 });

interface BridgeInbound {
  from?: string;
  text?: string;
  messageId?: string;
  at?: string;
}

/** Constant-time bearer comparison. Length is checked first because
 *  `timingSafeEqual` throws on a mismatch instead of returning false. */
function bearerMatches(header: string | null, expected: string): boolean {
  const presented = /^Bearer (.+)$/.exec(header ?? "")?.[1].trim() ?? "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> }
) {
  const { subAccountId } = await ctx.params;
  // Raw text FIRST: the HMAC is over the exact bytes, so a parse-then-restringify
  // would verify a body the bridge never signed.
  const rawBody = await request.text();

  let creds;
  try {
    creds = await getBridgeCreds(subAccountId);
  } catch {
    console.warn(
      `[whatsapp-bridge] inbound for sa=${subAccountId} which has no bridge credentials — dropping`
    );
    return NextResponse.json(
      { ok: false, error: "not_configured" },
      { status: 404 }
    );
  }

  const sigHeader = request.headers.get("leadstack-signature");
  const sig = verifyWebhookSignature({
    secret: creds.webhookSecret,
    rawBody,
    header: sigHeader,
  });
  if (!sig.ok) {
    console.warn(
      `[whatsapp-bridge] invalid signature (sa=${subAccountId}) reason=${sig.reason}`
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }
  if (!bearerMatches(request.headers.get("authorization"), creds.token)) {
    console.warn(`[whatsapp-bridge] invalid bearer token (sa=${subAccountId})`);
    return new NextResponse("Invalid token", { status: 403 });
  }

  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const subAccount = saSnap.data() as SubAccountDoc | undefined;
  if (!subAccount) return ok({ ok: true, ignored: "unrouted" });

  if (subAccount.whatsappEnabledByAgency !== true) {
    console.warn(
      `[whatsapp-bridge] inbound for sa=${subAccountId} but whatsappEnabledByAgency is off — dropping`
    );
    return ok({ ok: true, ignored: "channel_disabled" });
  }

  const { provider } = resolveProviderForSubAccount(subAccount);
  if (provider !== "bridge") {
    // A bridge left running against a switched-back workspace must not keep
    // writing into its threads.
    console.warn(
      `[whatsapp-bridge] inbound for sa=${subAccountId} but the workspace is on the ${provider} rail — dropping`
    );
    return ok({ ok: true, ignored: "wrong_rail" });
  }

  let payload: BridgeInbound;
  try {
    payload = JSON.parse(rawBody) as BridgeInbound;
  } catch {
    return ok({ ok: true, ignored: "invalid_json" });
  }

  // 1:1 only: a group message has no single contact to file it under.
  const fromJid = payload.from?.trim() ?? "";
  if (isGroupJid(fromJid)) return ok({ ok: true, ignored: "group" });
  const from = jidToE164(fromJid);
  if (!from) return ok({ ok: true, ignored: "no_sender" });

  const agencyId = subAccount.agencyId ?? "";
  const body = payload.text ?? "";
  const word = body.trim().toUpperCase().split(/\s+/)[0] ?? "";
  let nextOptedOut: boolean | null = null;
  if (STOP_WORDS.has(word)) nextOptedOut = true;
  else if (START_WORDS.has(word)) nextOptedOut = false;

  const matches = await db
    .collection("contacts")
    .where("phone", "==", from)
    .where("subAccountId", "==", subAccountId)
    .limit(5)
    .get();

  // Unknown senders become contacts so a "message us on WhatsApp" flow
  // captures new leads — except a never-seen number whose first word is
  // STOP/START, where minting a contact purely to opt it out is noise. No
  // ProfileName on this rail, so the new contact has no name.
  let contactDocs: DocumentSnapshot[] = matches.docs;
  if (matches.empty) {
    if (nextOptedOut !== null) return ok({ ok: true, persisted: false });
    try {
      const created = await createContactServerSide({
        subAccountId,
        agencyId,
        createdByUid: "bridge-whatsapp-inbound",
        mode: "live",
        name: "",
        email: "",
        phone: from,
        company: "",
        address: "",
        source: "whatsapp",
        tags: [],
      });
      contactDocs = [await db.collection("contacts").doc(created.id).get()];
    } catch (err) {
      console.error(
        `[whatsapp-bridge] failed to auto-create contact for ${from} (sa=${subAccountId})`,
        err
      );
      return ok({ ok: true, persisted: false });
    }
  }

  // Message row first, so it captures what the customer actually sent even
  // when that word is STOP. Doc id is WhatsApp's own message id, which makes a
  // redelivery idempotent the same way the Cloud wamid does; the bridge sends
  // it empty when the transport supplied none, and a generated id is then the
  // only option. `at` is preferred over the server timestamp for createdAt so a
  // delayed delivery lands in its real place in the thread, not at the end.
  const providerMessageId = payload.messageId?.trim() ?? "";
  const docId = providerMessageId || db.collection("contacts").doc().id;
  const at = payload.at ? new Date(payload.at) : null;
  const createdAt =
    at && !Number.isNaN(at.getTime()) ? at : FieldValue.serverTimestamp();

  const writes = contactDocs.map((d) =>
    d.ref
      .collection("whatsappMessages")
      .doc(docId)
      .set(
        {
          agencyId,
          subAccountId,
          contactId: d.id,
          direction: "inbound",
          status: "received",
          body,
          from,
          to: subAccount.whatsappBridgeMeta?.displayPhoneNumber ?? null,
          provider: "bridge",
          providerMessageId: providerMessageId || null,
          twilioMessageSid: null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt,
        },
        { merge: true }
      )
  );
  try {
    await Promise.all(writes);
  } catch (err) {
    console.warn("[whatsapp-bridge] message-row write failed", err);
  }

  await Promise.all(
    contactDocs.map((d) => {
      const cdata = d.data() as { name?: string; phone?: string } | undefined;
      return upsertConversationForMessage({
        contactId: d.id,
        subAccountId,
        agencyId,
        contactName: cdata?.name ?? "",
        contactPhone: cdata?.phone ?? from,
        channel: "whatsapp",
        direction: "inbound",
        body,
      });
    })
  );

  if (nextOptedOut !== null) {
    const batch = db.batch();
    for (const docSnap of contactDocs) {
      batch.update(docSnap.ref, {
        whatsappOptedOut: nextOptedOut,
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(docSnap.ref.collection("activities").doc(), {
        type: "automation_step_skipped",
        content: nextOptedOut
          ? `WhatsApp opt-out (${word}) received from ${from}.`
          : `WhatsApp opt-in (${word}) received from ${from}.`,
        createdBy: "bridge_whatsapp_inbound",
        meta: { kind: "whatsapp_opt_out", word, optedOut: nextOptedOut },
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return ok({ ok: true, persisted: true, optedOut: nextOptedOut });
  }

  if (contactDocs.length > 0 && aiIsConfigured()) {
    try {
      const agent = await resolveAgent(subAccountId, "whatsapp");
      if (agent?.effective.enabled) {
        const contactDoc = contactDocs[0];
        const contact = {
          id: contactDoc.id,
          ...(contactDoc.data() as Omit<Contact, "id">),
        };
        await maybeRespondWithAi({
          subAccountId,
          subAccount,
          agent,
          channelId: "whatsapp",
          contact,
          incomingMessage: body,
          replyTo: from,
        });
      }
    } catch (err) {
      console.error(
        `[whatsapp-bridge] AI reply pipeline failed for sa=${subAccountId}`,
        err
      );
    }
  }

  return ok({ ok: true, persisted: true });
}
