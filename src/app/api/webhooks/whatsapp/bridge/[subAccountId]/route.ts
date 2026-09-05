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
import { isGroupJid, isLidJid, isPhoneJid, jidToE164 } from "@/lib/comms/whatsapp/bridge-client";
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

  // The id is interpolated into two Firestore document paths below, and a
  // decoded "%2F" would still satisfy the `[^/]+` pattern that publishes this
  // route in middleware — Next decodes the segment after that match. Nothing
  // exploitable was demonstrated (a nested path simply finds no credentials),
  // but a path segment that reaches `db.doc()` unvalidated is a guard that is
  // absent rather than a guard that holds.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subAccountId)) {
    return ok({ ok: true, ignored: "not_configured" });
  }

  let creds;
  try {
    creds = await getBridgeCreds(subAccountId);
  } catch {
    console.warn(
      `[whatsapp-bridge] inbound for sa=${subAccountId} which has no bridge credentials — dropping`
    );
    // 200, and the SAME body as every other pre-verification drop.
    //
    // This lookup necessarily precedes authentication — the stored secret is
    // what authentication is performed against — so its outcome is observable
    // to a caller holding no credentials. Answering 404 here and 403 for a
    // configured tenant turned that into an oracle: probe ids against a route
    // the middleware does not guard and learn which sub-accounts exist and
    // have the bridge provisioned. The sibling public webhook
    // (webhooks/webinar1/sa/[subAccountId]) already answers
    // `200 {ignored:"not_configured"}` for exactly this condition; diverging
    // from it here was an accident, not a decision.
    return ok({ ok: true, ignored: "not_configured" });
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
  // A LID is not a phone number, however much its user part resembles one.
  // Filing it as one produces a contact whose replies reach a stranger, so it
  // is dropped rather than guessed at.
  //
  // Logged, not silent. The bridge posts at most once and never retries, so an
  // out-of-date bridge in the fleet would otherwise lose real customer
  // messages with nothing to grep for. This names the cause and the fix.
  if (isLidJid(fromJid)) {
    console.warn(
      `[wa-bridge] dropped a LID sender for ${subAccountId}: ${fromJid} — this bridge predates the SenderAlt fix and cannot be replied to`,
    );
    return ok({ ok: true, ignored: "lid" });
  }
  // Everything that is not a 1:1 phone address. An allow-list, because a
  // deny-list only ever catches the shapes somebody remembered: newsletter and
  // bot senders reach here with IsGroup false and would otherwise be filed as
  // contacts with a "+" in front of an id that was never dialled.
  if (!isPhoneJid(fromJid)) {
    console.warn(
      `[wa-bridge] dropped an unsupported sender address for ${subAccountId}: ${fromJid}`,
    );
    return ok({ ok: true, ignored: "unsupported_jid" });
  }
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

  // A redelivery must stop HERE, not merely write the same row twice.
  //
  // The row is idempotent on its own id, but nothing after it is: the
  // conversation upsert bumps the thread again, and the AI auto-reply sends
  // another real WhatsApp message to a real person and spends another LLM
  // call. A signature stays valid for the full five-minute tolerance, so one
  // captured request replayed inside that window produced one outbound per
  // replay — the message row converging while the customer's phone did not.
  //
  // Only a message carrying a real provider id can be deduplicated. An empty
  // id gets a generated one, which is unique per delivery by construction and
  // therefore matches nothing; that is the bridge telling us its transport
  // supplied no id, and it is the pre-existing behaviour of the Twilio rail
  // for the same reason.
  // A redelivery suppresses the two effects that are NOT idempotent, and
  // nothing else. It deliberately does not return early.
  //
  // Returning early was wrong in a way that only shows up on the unhappy path:
  // if a first delivery wrote the message row and then failed before the
  // opt-out flip — a contended `batch.commit()`, say — the bridge would retry,
  // the retry would be swallowed as a duplicate, and the customer's STOP would
  // be dropped permanently. Honouring an opt-out is a POPIA obligation, not a
  // best effort, so the only safe design is one where every delivery re-runs
  // everything idempotent and skips only what is not.
  //
  // Idempotent, so always re-run: the row write (`{merge:true}` on this same
  // doc id) and the STOP/START flip (sets the same boolean, and its activity
  // row now carries a deterministic id for exactly this reason).
  // Not idempotent, so gated: the conversation upsert re-bumps the thread, and
  // the AI auto-reply sends another real WhatsApp message to a real person.
  // Asked of EVERY matched contact, not just the first.
  //
  // One phone number can match several contacts, and the row is written to all
  // of them. Consulting only `contactDocs[0]` made the answer depend on
  // Firestore's `__name__` ordering: a contact created between two deliveries
  // with a lexicographically smaller id becomes the new `[0]`, has no row,
  // and the message reads as fresh — re-running the AI auto-reply and sending
  // the customer a second real message. `some` is the right quantifier
  // because the question is "have we handled this message before", and one
  // stored row answers yes; the row write below still fans out to all of them
  // and merges, so a contact that missed it earlier is filled in regardless.
  let isRedelivery = false;
  if (providerMessageId && contactDocs.length > 0) {
    const seen = await Promise.all(
      contactDocs.map((d) =>
        d.ref.collection("whatsappMessages").doc(docId).get()
      )
    );
    isRedelivery = seen.some((s) => s.exists);
  }

  // `at` is preferred over the server timestamp so a delayed delivery lands in
  // its real place in the thread rather than at the end — but it is the
  // bridge's clock, not ours, and it is written into the same
  // `whatsappMessages` collection that `readLastInboundAt` scans to decide the
  // 24-hour service window for the OTHER two rails. A skewed or hostile value
  // would pin a message at the top or bottom of the thread permanently, and a
  // future-dated one would hold that window open. Outside a day either way we
  // keep the ordering hint we can actually trust.
  // CLAMPED to the boundary, not replaced by `now`.
  //
  // Replacing an out-of-range value with the current time fails open in the
  // one direction that matters. A genuine backfill — the bridge was offline
  // for three days — carries an `at` older than the window, and stamping it
  // `now` makes a stale inbound look like it arrived this second. That value
  // is read by `readLastInboundAt` to decide the 24-hour service window for
  // the Twilio and Cloud rails, so a message that should leave the window shut
  // would hold it open instead. Pinning it to the far edge of the range keeps
  // it old, which is the honest answer and the safe one.
  const at = payload.at ? new Date(payload.at) : null;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let createdAt: Date | FieldValue;
  if (at === null || Number.isNaN(at.getTime())) {
    createdAt = FieldValue.serverTimestamp();
  } else {
    // Future timestamps are pulled back to now — nothing legitimately arrives
    // from the future, and a skewed bridge clock would otherwise pin the
    // message to the top of the thread forever.
    createdAt = new Date(Math.min(Math.max(at.getTime(), now - DAY_MS), now));
  }

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

  // Wrapped for the same reason the message-row write above is: this runs
  // AFTER the row is committed, so an uncaught throw here would 500 a webhook
  // whose message is already stored. The bridge reads any status >= 300 as a
  // failed delivery and logs it, which would report a message that in fact
  // landed. The inbox index is a derived view — losing an entry degrades the
  // unified inbox until the next message on the thread rebuilds it, whereas
  // failing the request loses nothing and reports a lie.
  // Skipped on a redelivery: the row above already carries this message, and
  // re-upserting only re-bumps the thread to the top of the inbox.
  if (!isRedelivery) {
    try {
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
    } catch (err) {
      console.warn("[whatsapp-bridge] conversation upsert failed", err);
    }
  }

  // Runs on EVERY delivery, redelivery included. An opt-out is a POPIA
  // obligation, so the one thing this handler must never do is drop a STOP
  // because it thinks it has seen the message before.
  if (nextOptedOut !== null) {
    const batch = db.batch();
    for (const docSnap of contactDocs) {
      batch.update(docSnap.ref, {
        whatsappOptedOut: nextOptedOut,
        updatedAt: FieldValue.serverTimestamp(),
      });
      // Deterministic id, keyed on the message this opt-out came from, so a
      // retry overwrites its own activity row instead of appending a second
      // one. A generated id made the write non-idempotent, which is what
      // stopped the whole branch from being safe to re-run — and re-running it
      // is exactly what a retry after a failed commit has to do. Falls back to
      // a generated id only when the transport gave us no message id to key
      // on, where there is nothing to be idempotent against anyway.
      const activities = docSnap.ref.collection("activities");
      batch.set(
        providerMessageId
          ? activities.doc(`whatsapp-optout-${providerMessageId}`)
          : activities.doc(),
        {
          type: "automation_step_skipped",
          content: nextOptedOut
            ? `WhatsApp opt-out (${word}) received from ${from}.`
            : `WhatsApp opt-in (${word}) received from ${from}.`,
          createdBy: "bridge_whatsapp_inbound",
          meta: { kind: "whatsapp_opt_out", word, optedOut: nextOptedOut },
          createdAt: FieldValue.serverTimestamp(),
        }
      );
    }
    try {
      await batch.commit();
    } catch (err) {
      // The ONE place this handler deliberately answers non-2xx. Everything
      // else degrades to a logged warning and a 200, because the bridge treats
      // >= 300 as a failed delivery and retrying costs more than the data
      // lost. Here the opposite holds: the customer asked to stop being
      // messaged and we did not record it, so we want the retry — and the
      // retry now honours it, because nothing above returns early on a
      // redelivery any more.
      console.error(
        `[whatsapp-bridge] opt-out commit failed (sa=${subAccountId}) — asking the bridge to retry`,
        err
      );
      return NextResponse.json(
        { ok: false, error: "optout_not_recorded" },
        { status: 503 }
      );
    }
    return ok({ ok: true, persisted: true, optedOut: nextOptedOut });
  }

  // Gated on redelivery: this sends a real WhatsApp message to a real person
  // and spends an LLM call, so it is the effect a replayed request must never
  // repeat. It is also the last step, so skipping it strands nothing.
  if (!isRedelivery && contactDocs.length > 0 && aiIsConfigured()) {
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
