import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { verifyMetaSignature, metaWebhookVerifyToken } from "@/lib/comms/meta";
import { fetchCloudMedia } from "@/lib/comms/whatsapp/cloud-media";
import {
  parseCloudInbounds,
  parseCloudPhoneNumberId,
  parseCloudStatuses,
  type CloudInbound,
  type CloudStatus,
  type CloudMediaRef,
} from "@/lib/comms/whatsapp/cloud-payload";
import {
  putWhatsappMedia,
  whatsappMediaPath,
} from "@/lib/comms/whatsapp/media-storage";
import { hasWhatsappSenderOnRail } from "@/lib/comms/whatsapp/resolve-sender";
import {
  normalizeDeliveryStatus,
  recordWhatsappDeliveryStatus,
} from "@/lib/comms/whatsapp/delivery-status";
import { createContactServerSide } from "@/lib/server/contacts-service";
import {
  matchMysteryShopWhatsApp,
  recordMysteryShopWhatsAppStatus,
} from "@/lib/prospecting/mystery-shop/inbound";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { writeInboundMessageActivity } from "@/lib/server/contact-activities";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import {
  isAllowedWhatsappMediaMime,
  mediaPreviewLabel,
  parseWhatsappMedia,
  type WhatsappMedia,
  type WhatsappMediaDropped,
} from "@/types/whatsapp-media";
import { locationPreviewLabel } from "@/types/whatsapp-location";
import {
  optKeyword,
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

/** A hung `file.save` must not hold the handler open indefinitely. */
const STORE_TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Fetch, store and attach an inbound file to message rows that are ALREADY
 * written.
 *
 * Never throws: any failure becomes `mediaDropped` on the row, and the text
 * the customer sent is never lost to a file we could not keep.
 */
async function attachInboundMedia(opts: {
  db: Firestore;
  route: ResolvedRoute;
  messageId: string;
  ref: CloudMediaRef;
  contactDocs: DocumentSnapshot[];
  seen: DocumentSnapshot[];
  rowWritten: ReadonlySet<string>;
}): Promise<void> {
  const rowRef = (d: DocumentSnapshot) =>
    d.ref.collection("whatsappMessages").doc(opts.messageId);

  // Only rows that exist: merged onto a row whose write failed, `media` or
  // `mediaDropped` would create a ghost doc — no body, no direction, no
  // createdAt — that every later delivery then reads as "seen". A row an
  // EARLIER delivery wrote counts as existing, so a retry whose own row merge
  // failed transiently still re-attempts the attachment.
  //
  // And never downgrade: a row that already holds media is left alone — no
  // re-fetch, and no `mediaDropped` from a retry whose download failed.
  const pending = opts.contactDocs.filter(
    (d, i) =>
      (opts.rowWritten.has(d.id) || opts.seen[i]?.exists === true) &&
      !parseWhatsappMedia(opts.seen[i]?.data()?.media),
  );
  if (pending.length === 0) return;

  // In a transaction, because `seen` predates the download: a concurrent
  // retry may have landed the file since, and a drop decided from the stale
  // snapshot would overwrite it.
  const drop = (reason: WhatsappMediaDropped) =>
    Promise.all(
      pending.map((d) =>
        opts.db.runTransaction(async (tx) => {
          const current = await tx.get(rowRef(d));
          if (parseWhatsappMedia(current.data()?.media)) return;
          tx.set(rowRef(d), { mediaDropped: reason }, { merge: true });
        }),
      ),
    );

  try {
    if (!isAllowedWhatsappMediaMime(opts.ref.mimeType)) {
      await drop("unsupported_type");
      return;
    }
    const fetched = await fetchCloudMedia({
      subAccountId: opts.route.subAccountId,
      mediaId: opts.ref.id,
    });
    if (!fetched.ok) {
      await drop(fetched.reason);
      return;
    }
    for (const d of pending) {
      const storagePath = whatsappMediaPath({
        agencyId: opts.route.agencyId,
        subAccountId: opts.route.subAccountId,
        contactId: d.id,
        messageDocId: opts.messageId,
      });
      // Stored BEFORE the row references it, so a row never points at an
      // object that is not there.
      const put = await withTimeout(
        putWhatsappMedia({
          path: storagePath,
          bytes: fetched.bytes,
          contentType: opts.ref.mimeType,
        }),
        STORE_TIMEOUT_MS,
        "media store",
      );
      if (!put.ok) throw new Error(`media store failed: ${put.reason}`);
      const media: WhatsappMedia = {
        kind: opts.ref.kind,
        mimeType: opts.ref.mimeType,
        filename: opts.ref.filename,
        sizeBytes: fetched.bytes.length,
        storagePath,
      };
      await rowRef(d).set(
        { media, mediaDropped: FieldValue.delete() },
        { merge: true },
      );
    }
  } catch (err) {
    console.warn(
      `[whatsapp-cloud] media attach failed (sa=${opts.route.subAccountId}) — keeping the text`,
      err,
    );
    // Rows this attempt already gave media keep it: `drop` re-reads each one.
    await drop("fetch_failed").catch((dropErr: unknown) =>
      console.warn("[whatsapp-cloud] could not record mediaDropped", dropErr),
    );
  }
}

/**
 * Delivery receipts onto their outbound rows, so a message Meta refused after
 * the send (131047, 131026…) shows as failed instead of "sent" forever. Each
 * receipt routes by its own block's number. Never throws: a non-2xx makes Meta
 * retry and eventually disable the subscription, which would stop inbound
 * messages too.
 */
async function recordStatuses(
  statuses: CloudStatus[],
  routeFor: (phoneNumberId: string) => Promise<ResolvedRoute | null>,
): Promise<{ routed: number; recorded: number }> {
  let routed = 0;
  let recorded = 0;
  for (const s of statuses) {
    if (!s.phoneNumberId) continue;
    try {
      const route = await routeFor(s.phoneNumberId);
      if (!route) continue;
      routed++;
      const status = normalizeDeliveryStatus(s.status);
      if (!status) continue;
      // A prospecting mystery shop sent as this message (PR 5b): undeliverable,
      // or delivered/read for its card. Its own catch, so it never costs the row.
      // Skipped while Prospecting is off for the sub-account.
      try {
        if (route.subAccount.prospectingEnabledByAgency === true) await recordMysteryShopWhatsAppStatus(
          route.subAccountId,
          s.providerMessageId,
          status,
          s.timestampMs ?? Date.now(),
          [s.errorCode, s.errorTitle].filter(Boolean).join(": ") || null,
        );
      } catch (err) {
        console.error(`[whatsapp-cloud] mystery-shop status ${s.status} not recorded`, err);
      }
      const r = await recordWhatsappDeliveryStatus({
        db: getAdminDb(),
        subAccountId: route.subAccountId,
        recipientPhone: toE164(s.recipientId ?? ""),
        providerMessageId: s.providerMessageId,
        status,
        errorCode: s.errorCode,
        errorTitle: s.errorTitle,
      });
      recorded += r.updated;
    } catch (err) {
      console.warn(`[whatsapp-cloud] status ${s.status} not recorded`, err);
    }
  }
  return { routed, recorded };
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

  // One resolution per number for the whole delivery.
  const routes = new Map<string, Promise<ResolvedRoute | null>>();
  const routeFor = (phoneNumberId: string) => {
    let route = routes.get(phoneNumberId);
    if (!route) {
      route = resolveRoute(phoneNumberId);
      routes.set(phoneNumberId, route);
    }
    return route;
  };

  // Meta may batch several messages — and receipts beside them — into one
  // delivery, across entries and changes. Every message is handled; reading
  // only the first would drop the rest, a STOP among them.
  const inbounds = parseCloudInbounds(payload);
  if (inbounds.length === 0) {
    // Delivery receipts share this endpoint. The parser reads messages from
    // `messages[]` alone, so a receipt can never be written into the thread
    // as a customer message. Each receipt routes by its own block, so an
    // unknown number in the first block does not drop the rest.
    const statuses = parseCloudStatuses(payload);
    if (statuses.length > 0) {
      const { routed, recorded } = await recordStatuses(statuses, routeFor);
      return routed > 0
        ? ok({ ok: true, statuses: statuses.length, recorded })
        : ok({ ok: true, ignored: "unrouted" });
    }

    const phoneNumberId = parseCloudPhoneNumberId(payload);
    if (!phoneNumberId) return ok({ ok: true, ignored: "no_phone_number_id" });
    const route = await routeFor(phoneNumberId);
    if (!route) return ok({ ok: true, ignored: "unrouted" });
    return ok({ ok: true, persisted: false });
  }

  // Receipts batched beside the messages are recorded too.
  await recordStatuses(parseCloudStatuses(payload), routeFor);

  // Each message routes by its own block's number. Sequential, so two
  // messages from one sender land in order. A failure on one — answered or
  // thrown — does not stop the rest (a later one may be a STOP); the first
  // non-2xx is answered, and Meta's retry of the whole delivery is safe
  // because every message dedups on its own wamid.
  const results: NextResponse[] = [];
  for (const inbound of inbounds) {
    try {
      const resolved = await routeFor(inbound.phoneNumberId);
      results.push(
        resolved
          ? await handleInbound(resolved, inbound)
          : ok({ ok: true, ignored: "unrouted" }),
      );
    } catch (err) {
      console.error(
        `[whatsapp-cloud] inbound ${inbound.providerMessageId} failed — continuing the batch, asking Meta to retry`,
        err,
      );
      results.push(
        NextResponse.json({ ok: false, error: "message_failed" }, { status: 500 }),
      );
    }
  }
  const failed = results.find((r) => r.status >= 300);
  if (failed) return failed;
  return results.length === 1
    ? results[0]
    : ok({ ok: true, messages: results.length });
}

async function handleInbound(
  route: ResolvedRoute,
  inbound: CloudInbound,
): Promise<NextResponse> {
  const from = toE164(inbound.fromPhone);
  if (!from) return ok({ ok: true, ignored: "no_sender" });

  // Coordinates are the customer's personal data: the log names the sub-account
  // and never the values.
  if (inbound.locationRejected) {
    console.warn(
      `[whatsapp-cloud] location message with unusable coordinates (sa=${route.subAccountId}) — stored without them`,
    );
  }
  // A shared location carries no text. The row gets a readable body so no
  // reader sees an empty message; `inbound.text` stays empty, which is what
  // keeps the AI from replying to it (see the AI gate below).
  const locationLabel = inbound.location
    ? locationPreviewLabel(inbound.location)
    : "";

  const db = getAdminDb();
  const word = optKeyword(inbound.text);
  let nextOptedOut: boolean | null = null;
  if (WHATSAPP_STOP_WORDS.has(word)) nextOptedOut = true;
  else if (WHATSAPP_START_WORDS.has(word)) nextOptedOut = false;

  // A reply to a prospecting mystery shop (PR 5b), timed at Meta's own
  // timestamp. As soon as the sender is known, so nothing below (a contact
  // that cannot be created) can drop it; on every delivery (first response
  // wins, so a redelivery changes nothing); never able to fail the message —
  // a failure is logged and the handler carries on. Always, even with
  // Prospecting switched off since: a shop already sent still needs its reply.
  try {
    await matchMysteryShopWhatsApp(route.subAccountId, {
      from,
      atMs: inbound.timestampMs ?? Date.now(),
      text: inbound.text,
      type: inbound.type,
      optOut: nextOptedOut,
    });
  } catch (err) {
    console.error(`[whatsapp-cloud] mystery-shop match failed (sa=${route.subAccountId})`, err);
  }

  const matches = await db
    .collection("contacts")
    .where("phone", "==", from)
    .where("subAccountId", "==", route.subAccountId)
    .limit(5)
    .get();

  // Unknown senders become contacts so a public "message us on WhatsApp" link
  // captures new leads. That includes a never-seen number whose message is
  // STOP: the opt-out below lands on the new contact, so a later bulk send to
  // that number is refused instead of the STOP having been silently dropped.
  let contactDocs: DocumentSnapshot[] = matches.docs;
  if (matches.empty) {
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
        // A STOP from a never-seen number: written opted out, announcing
        // nothing, so no contact.created automation can message them.
        optedOutOnWhatsapp: nextOptedOut === true,
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
  let seen: DocumentSnapshot[] = [];
  let isRedelivery = false;
  if (contactDocs.length > 0) {
    seen = await Promise.all(
      contactDocs.map((d) =>
        d.ref.collection("whatsappMessages").doc(inbound.providerMessageId).get(),
      ),
    );
    isRedelivery = seen.some((s) => s.exists);
  }

  // Message row first, so it captures what the customer actually sent even
  // when that word is STOP. Doc id is Meta's wamid, which makes a webhook
  // retry idempotent the same way the Twilio MessageSid does.
  const rowWritten = new Set<string>();
  const writes = contactDocs.map(async (d) => {
    await d.ref
      .collection("whatsappMessages")
      .doc(inbound.providerMessageId)
      .set(
        {
          agencyId: route.agencyId,
          subAccountId: route.subAccountId,
          contactId: d.id,
          direction: "inbound",
          status: "received",
          body: inbound.text || locationLabel,
          from,
          to: inbound.phoneNumberId,
          provider: "cloud",
          providerMessageId: inbound.providerMessageId,
          ...(inbound.buttonPayload ? { buttonPayload: inbound.buttonPayload } : {}),
          ...(inbound.location ? { location: inbound.location } : {}),
          twilioMessageSid: null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    rowWritten.add(d.id);
  });
  try {
    await Promise.all(writes);
  } catch (err) {
    console.warn("[whatsapp-cloud] message-row write failed", err);
  }

  // What the inbox list and the timeline show for a caption-less file. Built
  // from Meta's declaration, not from the download, so it neither waits on the
  // file nor depends on whether storing it worked for this particular contact.
  const preview =
    inbound.text ||
    locationLabel ||
    (inbound.media
      ? mediaPreviewLabel({
          kind: inbound.media.kind,
          mimeType: inbound.media.mimeType,
          filename: inbound.media.filename,
          sizeBytes: 0,
          storagePath: "",
        })
      : "");

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
          body: preview,
          buttonTap: inbound.buttonPayload !== null,
          optOut: nextOptedOut === true,
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
        preview,
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
    // No early return. Everything below must still run for an opt-out — the
    // file a customer sent with their STOP is part of what they sent — and an
    // early return is how that ordering silently regresses.
  }

  // Gated on redelivery: this sends a real WhatsApp message to a real person
  // and spends an LLM call, so it is the effect a replayed request must never
  // repeat. Never for an opt-out, and never for an empty message: a
  // caption-less photo would otherwise have the AI send a real reply about
  // nothing. The inbox entry and the file still land. Same rule as the bridge
  // route. Runs before the media step so it never waits on a download.
  //
  // A shared location is skipped by the same test — its row body is a label,
  // but `inbound.text` is empty. Deliberate: the location is for the team (a
  // technician finding the house), there is nothing in it for the AI to
  // answer, and replying would send the customer's coordinates to the LLM.
  if (
    nextOptedOut === null &&
    !isRedelivery &&
    inbound.text.trim() !== "" &&
    contactDocs.length > 0 &&
    aiIsConfigured()
  ) {
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
          inboundProvider: "cloud",
        });
      }
    } catch (err) {
      console.error(
        `[whatsapp-cloud] AI reply pipeline failed for sa=${route.subAccountId}`,
        err,
      );
    }
  }

  // LAST, after every effect that does not need the file.
  //
  // Writing the row first is not enough on its own. A handler that dies in
  // the download — a deploy restart, an OOM — would leave the row written and
  // the inbox entry and AI reply not yet run; Meta's retry is then a
  // redelivery that skips both, and they are lost for good. With them already
  // done, a death here strands only the attachment, which that same retry
  // re-attempts: this step is not gated on redelivery.
  if (inbound.media) {
    await attachInboundMedia({
      db,
      route,
      messageId: inbound.providerMessageId,
      ref: inbound.media,
      contactDocs,
      seen,
      rowWritten,
    });
  }

  return ok(
    nextOptedOut === null
      ? { ok: true, persisted: true }
      : { ok: true, persisted: true, optedOut: nextOptedOut },
  );
}
