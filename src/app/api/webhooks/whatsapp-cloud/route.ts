import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { verifyMetaSignature, metaWebhookVerifyToken } from "@/lib/comms/meta";
import {
  parseCloudInbound,
  parseCloudPhoneNumberId,
  parseCloudStatuses,
} from "@/lib/comms/whatsapp/cloud-payload";
import { hasWhatsappSenderOnRail } from "@/lib/comms/whatsapp/resolve-sender";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { writeInboundMessageActivity } from "@/lib/server/contact-activities";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import {
  firstKeyword,
  WHATSAPP_START_WORDS,
  WHATSAPP_STOP_WORDS,
} from "@/lib/comms/whatsapp/opt-keywords";

export const dynamic = "force-dynamic";

/**
 * Meta WhatsApp Cloud API inbound webhook — the `cloud` arm's receive path.
 *
 * Deliberately mirrors /api/webhooks/twilio/whatsapp/inbound step for step, so
 * flipping a sub-account between rails changes the transport and nothing the
 * operator can see: same contact reconciliation, same `whatsappMessages` rows,
 * same unified-inbox index, same AI dispatch.
 *
 * Differences forced by the provider:
 *   - GET is Meta's subscription handshake (hub.verify_token → hub.challenge).
 *   - Authenticity is `X-Hub-Signature-256` over the RAW body, shared with the
 *     Messenger/IG webhook rather than reimplemented.
 *   - Routing is by `metadata.phone_number_id`, which is why that id is
 *     mirrored onto the member-readable meta field.
 *   - Delivery receipts arrive on this same endpoint and must not be mistaken
 *     for customer messages.
 *
 * Always acks 200 except on a failed signature: a non-2xx makes Meta retry and
 * eventually disable the subscription outright.
 */

const ok = (body: Record<string, unknown> = { ok: true }) =>
  NextResponse.json(body, { status: 200 });

/** Meta sends bare international digits; the CRM stores E.164. */
function toE164(digits: string): string {
  const cleaned = digits.replace(/[^\d]/g, "");
  return cleaned ? `+${cleaned}` : "";
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = metaWebhookVerifyToken();
  if (
    params.get("hub.mode") === "subscribe" &&
    token &&
    params.get("hub.verify_token") === token
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

interface ResolvedRoute {
  subAccountId: string;
  agencyId: string;
  subAccount: SubAccountDoc;
}

/**
 * Find the sub-account owning this sending number. Returns null when nothing
 * matches, when the agency gate is off, or when the workspace has no cloud
 * sender at all — a stale Meta subscription must not resurrect a channel an
 * operator has removed. Having one but sending from another is fine: replies
 * still belong to the number they came in on.
 */
async function resolveRoute(
  phoneNumberId: string,
): Promise<ResolvedRoute | null> {
  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("whatsappCloudMeta.phoneNumberId", "==", phoneNumberId)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const sa = snap.docs[0].data() as SubAccountDoc;
  const id = snap.docs[0].id;

  if (sa.whatsappEnabledByAgency !== true) {
    console.warn(
      `[whatsapp-cloud] inbound for pn=${phoneNumberId} (sa=${id}) but whatsappEnabledByAgency is off — dropping`,
    );
    return null;
  }

  // Membership, not "is cloud the default sender": a workspace whose default
  // sender is another rail still owns this number and still has to receive
  // replies to it.
  if (!hasWhatsappSenderOnRail(sa, "cloud")) {
    console.warn(
      `[whatsapp-cloud] inbound for pn=${phoneNumberId} (sa=${id}) but the workspace has no cloud sender — dropping`,
    );
    return null;
  }

  return { subAccountId: id, agencyId: sa.agencyId, subAccount: sa };
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  // Meta signs with the secret of the app the WABA is subscribed to, which
  // may be a WhatsApp-only app in the portfolio that owns the WABA rather
  // than the Messenger/IG app.
  const signature = request.headers.get("x-hub-signature-256");
  const signedByOurApp = [process.env.WHATSAPP_APP_SECRET, process.env.META_APP_SECRET].some(
    (secret) => verifyMetaSignature(rawBody, signature, secret ?? ""),
  );
  if (!signedByOurApp) {
    console.warn("[whatsapp-cloud] invalid X-Hub-Signature-256");
    return new NextResponse("Invalid signature", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return ok({ ok: true, ignored: "invalid_json" });
  }

  const phoneNumberId = parseCloudPhoneNumberId(payload);
  if (!phoneNumberId) return ok({ ok: true, ignored: "no_phone_number_id" });

  const route = await resolveRoute(phoneNumberId);
  if (!route) return ok({ ok: true, ignored: "unrouted" });

  // Delivery receipts share this endpoint. Ack them before the inbound path so
  // a receipt can never be written into the thread as a customer message.
  const statuses = parseCloudStatuses(payload);
  if (statuses.length > 0) {
    return ok({ ok: true, statuses: statuses.length });
  }

  const inbound = parseCloudInbound(payload);
  if (!inbound) return ok({ ok: true, persisted: false });

  const from = toE164(inbound.fromPhone);
  if (!from) return ok({ ok: true, ignored: "no_sender" });

  const db = getAdminDb();
  const word = firstKeyword(inbound.text);
  let nextOptedOut: boolean | null = null;
  if (WHATSAPP_STOP_WORDS.has(word)) nextOptedOut = true;
  else if (WHATSAPP_START_WORDS.has(word)) nextOptedOut = false;

  const matches = await db
    .collection("contacts")
    .where("phone", "==", from)
    .where("subAccountId", "==", route.subAccountId)
    .limit(5)
    .get();

  // Unknown senders become contacts so a public "message us on WhatsApp" link
  // captures new leads — except a never-seen number whose first word is
  // STOP/START, where minting a contact purely to opt it out is noise.
  let contactDocs: DocumentSnapshot[] = matches.docs;
  if (matches.empty) {
    if (nextOptedOut !== null) return ok({ ok: true, persisted: false });
    try {
      const created = await createContactServerSide({
        subAccountId: route.subAccountId,
        agencyId: route.agencyId,
        createdByUid: "whatsapp-cloud-inbound",
        mode: "live",
        name: inbound.profileName,
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
        `[whatsapp-cloud] failed to auto-create contact for ${from} (sa=${route.subAccountId})`,
        err,
      );
      return ok({ ok: true, persisted: false });
    }
  }

  // A redelivery must stop HERE, not merely write the same row twice.
  //
  // Meta retries a webhook it considers failed. The row below is idempotent on
  // its own doc id, but nothing after it is: the conversation upsert bumps the
  // thread again, and the AI auto-reply sends another real WhatsApp message to
  // a real person and spends another LLM call. This is the same defect the
  // bridge route was already burned by, and this is its guard, ported.
  //
  // A redelivery suppresses the two effects that are NOT idempotent, and
  // nothing else. It deliberately does not return early.
  //
  // Returning early was wrong in a way that only shows up on the unhappy path:
  // if a first delivery wrote the message row and then failed before the
  // opt-out flip, Meta would retry, the retry would be swallowed as a
  // duplicate, and the customer's STOP would be dropped permanently. Honouring
  // an opt-out is a POPIA obligation, not a best effort, so the only safe
  // design is one where every delivery re-runs everything idempotent and skips
  // only what is not.
  //
  // Asked of EVERY matched contact, not just the first. One phone number can
  // match several contacts and the row is written to all of them; consulting
  // only `contactDocs[0]` would make the answer depend on Firestore's
  // `__name__` ordering, so a contact created between two deliveries with a
  // smaller id becomes the new `[0]`, has no row, and the message reads as
  // fresh. `some` is the right quantifier because the question is "have we
  // handled this message before", and one stored row answers yes; the row
  // write below still fans out to all of them and merges.
  let isRedelivery = false;
  if (contactDocs.length > 0) {
    const seen = await Promise.all(
      contactDocs.map((d) =>
        d.ref.collection("whatsappMessages").doc(inbound.providerMessageId).get(),
      ),
    );
    isRedelivery = seen.some((s) => s.exists);
  }

  // Message row first, so it captures what the customer actually sent even
  // when that word is STOP. Doc id is Meta's wamid, which makes a webhook
  // retry idempotent the same way the Twilio MessageSid does.
  const writes = contactDocs.map((d) =>
    d.ref
      .collection("whatsappMessages")
      .doc(inbound.providerMessageId)
      .set(
        {
          agencyId: route.agencyId,
          subAccountId: route.subAccountId,
          contactId: d.id,
          direction: "inbound",
          status: "received",
          body: inbound.text,
          from,
          to: phoneNumberId,
          provider: "cloud",
          providerMessageId: inbound.providerMessageId,
          ...(inbound.buttonPayload ? { buttonPayload: inbound.buttonPayload } : {}),
          twilioMessageSid: null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
  );
  try {
    await Promise.all(writes);
  } catch (err) {
    console.warn("[whatsapp-cloud] message-row write failed", err);
  }

  // Skipped on a redelivery, and the ONLY thing here that is: the upsert
  // increments `unreadCount`, emits a webhook event and resumes waiting
  // workflow runs, none of which converge on a second call.
  if (!isRedelivery) {
    await Promise.all(
      contactDocs.map((d) => {
        const cdata = d.data() as { name?: string; phone?: string } | undefined;
        return upsertConversationForMessage({
          contactId: d.id,
          subAccountId: route.subAccountId,
          agencyId: route.agencyId,
          contactName: cdata?.name ?? "",
          contactPhone: cdata?.phone ?? from,
          channel: "whatsapp",
          direction: "inbound",
          body: inbound.text,
          buttonTap: inbound.buttonPayload !== null,
        });
      }),
    );
  }

  // Runs on EVERY delivery, redelivery included. This is idempotent — it keys
  // the row `inbound_{channel}_{messageId}` and merges — so re-running it is a
  // no-op overwrite, and gating it would buy nothing while risking the row
  // outright: a first delivery that wrote the message row and then died before
  // this call leaves `isRedelivery` true forever after, and a gated write
  // would never be attempted again. Re-run everything idempotent; skip only
  // what is not.
  await Promise.all(
    contactDocs.map((d) =>
      writeInboundMessageActivity(db, {
        contactId: d.id,
        channel: "whatsapp",
        preview: inbound.text,
        messageId: inbound.providerMessageId,
        agencyId: route.agencyId,
        subAccountId: route.subAccountId,
      }),
    ),
  );

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
      // redelivery overwrites its own activity row instead of appending a
      // second one. A generated id made this write non-idempotent, which is
      // what would stop the whole branch from being safe to re-run — and
      // re-running it on every delivery is exactly what the guard above
      // commits us to. No fallback for a missing id: `parseCloudInbound`
      // refuses a payload without a wamid, so there is no such state here.
      batch.set(
        docSnap.ref
          .collection("activities")
          .doc(`whatsapp-optout-${inbound.providerMessageId}`),
        {
          type: "automation_step_skipped",
          content: nextOptedOut
            ? `WhatsApp opt-out (${word}) received from ${from}.`
            : `WhatsApp opt-in (${word}) received from ${from}.`,
          createdBy: "whatsapp_cloud_inbound",
          meta: { kind: "whatsapp_opt_out", word, optedOut: nextOptedOut },
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }
    try {
      await batch.commit();
    } catch (err) {
      // The ONE place this handler deliberately answers non-2xx, and it is
      // stated rather than accidental.
      //
      // Everything else here acks 200 and degrades to a logged warning,
      // because Meta retries anything >= 300 and eventually disables the
      // subscription outright — which would stop ALL inbound WhatsApp for
      // this WABA, not just the message that failed. Here the opposite
      // holds: the customer asked to stop being messaged and we did not
      // record it, so we want the retry — and the retry now honours it,
      // because nothing above returns early on a redelivery and the
      // activity row above is keyed deterministically.
      //
      // 503 rather than letting the throw become a 500: same retry from
      // Meta's side, but it names the condition instead of surfacing as an
      // unhandled exception that reads like a bug in the parser.
      console.error(
        `[whatsapp-cloud] opt-out commit failed (sa=${route.subAccountId}) — asking Meta to retry`,
        err,
      );
      return NextResponse.json(
        { ok: false, error: "optout_not_recorded" },
        { status: 503 },
      );
    }
    return ok({ ok: true, persisted: true, optedOut: nextOptedOut });
  }

  // Gated on redelivery: this sends a real WhatsApp message to a real person
  // and spends an LLM call, so it is the effect a replayed request must never
  // repeat. It is also the last step, so skipping it strands nothing.
  if (!isRedelivery && contactDocs.length > 0 && aiIsConfigured()) {
    try {
      const agent = await resolveAgent(route.subAccountId, "whatsapp");
      if (agent?.effective.enabled) {
        const contactDoc = contactDocs[0];
        const contact = {
          id: contactDoc.id,
          ...(contactDoc.data() as Omit<Contact, "id">),
        };
        await maybeRespondWithAi({
          subAccountId: route.subAccountId,
          subAccount: route.subAccount,
          agent,
          channelId: "whatsapp",
          contact,
          incomingMessage: inbound.text,
          replyTo: from,
        });
      }
    } catch (err) {
      console.error(
        `[whatsapp-cloud] AI reply pipeline failed for sa=${route.subAccountId}`,
        err,
      );
    }
  }

  return ok({ ok: true, persisted: true });
}
