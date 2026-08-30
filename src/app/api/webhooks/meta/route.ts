import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getMetaUserName,
  metaWebhookVerifyToken,
  verifyMetaSignature,
} from "@/lib/comms/meta";
import { createContactServerSide } from "@/lib/server/contacts-service";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { metaCanInstagramDm } from "@/lib/comms/meta-capabilities";
import type { ConversationChannel } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

/**
 * BETA Meta inbound webhook — Facebook Messenger + Instagram DM.
 *
 *   GET  /api/webhooks/meta   → verification handshake (Meta echoes hub.challenge)
 *   POST /api/webhooks/meta   → message events from the Meta cloud
 *
 * Security: the POST verifies Meta's `X-Hub-Signature-256` (HMAC of the raw
 * body with the app secret) before doing anything. Public path (no session) —
 * the signature IS the credential, same model as the Twilio/Vapi webhooks.
 *
 * Routing mirrors the WhatsApp inbound route: resolve the sub-account that owns
 * the receiving Page (Messenger) or IG account (Instagram), enforce the agency
 * gate (`metaInboxEnabledByAgency`), reconcile/create a Contact by the Meta
 * user id, persist the inbound to `contacts/{id}/metaMessages`, and update the
 * unified-inbox index. Always returns 200 so Meta doesn't retry-storm.
 *
 * Phase B (Meta DM Agent v1): after the message is stored, the shared AI
 * agent may auto-reply — gated on the agency's `metaAgentEnabledByAgency`
 * (via `aiChannelGateOn(sa, "meta")`), the `aiAgent/meta` channel doc's
 * enabled flag, `aiIsConfigured()`, and — for Instagram — the
 * `instagram_manage_messages` capability on the stored token. The reply
 * mirrors the platform the DM arrived on. AI failures never break the
 * webhook contract (log + 200). Echoes + non-text events are ignored.
 */

interface MetaMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
}

interface MetaEntry {
  id?: string;
  messaging?: MetaMessaging[];
}

interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

interface ResolvedRoute {
  subAccountId: string;
  agencyId: string;
  pageAccessToken: string;
  /** Full sub-account doc — the AI dispatch needs gates + metaConfig +
   *  bookingLink without a second read. */
  subAccount: SubAccountDoc;
}

/**
 * Resolve the sub-account receiving this event. `object: "instagram"` routes by
 * the linked IG business-account id; everything else (page) routes by Page id.
 * Returns null when no sub-account matches OR the agency gate is off.
 */
async function resolveRoute(
  object: string,
  entryId: string,
): Promise<ResolvedRoute | null> {
  const field =
    object === "instagram"
      ? "metaConfig.instagramBusinessAccountId"
      : "metaConfig.pageId";

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where(field, "==", entryId)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const sa = snap.docs[0].data() as SubAccountDoc;
  if (sa.metaInboxEnabledByAgency !== true) {
    console.warn(
      `[webhooks/meta] event for ${entryId} (sa=${snap.docs[0].id}) but metaInboxEnabledByAgency is off — dropping`,
    );
    return null;
  }
  const token = sa.metaConfig?.pageAccessToken;
  if (!token) return null;

  return {
    subAccountId: snap.docs[0].id,
    agencyId: sa.agencyId,
    pageAccessToken: token,
    subAccount: sa,
  };
}

/**
 * Phase B — AI auto-reply dispatch for one just-stored inbound DM. All
 * gate checks live here so the store/index path above never depends on AI
 * state. Any failure is logged and swallowed — the webhook's 200 contract
 * must hold regardless.
 */
async function maybeDispatchAiReply(input: {
  route: ResolvedRoute;
  contactId: string;
  channel: "messenger" | "instagram";
  senderId: string;
  text: string;
}): Promise<void> {
  const { route, contactId, channel, senderId, text } = input;
  const sa = route.subAccount;
  try {
    if (!aiIsConfigured()) return;
    // Agency AI gate (opt-in) — separate from the inbox gate resolveRoute
    // already enforced. Manual replies from the inbox are unaffected.
    if (!aiChannelGateOn(sa, "meta")) return;
    // A token without the Instagram messaging scope can't send IG replies —
    // skip BEFORE spending LLM tokens. Messenger keeps working.
    if (channel === "instagram" && !metaCanInstagramDm(sa.metaConfig)) return;

    const agent = await resolveAgent(route.subAccountId, "meta");
    if (!agent?.effective.enabled) return;

    const contactSnap = await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .get();
    if (!contactSnap.exists) return;
    const contact: Contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    };

    await maybeRespondWithAi({
      subAccountId: route.subAccountId,
      subAccount: sa,
      agent,
      channelId: "meta",
      metaChannel: channel,
      contact,
      incomingMessage: text,
      replyTo: senderId,
    });
  } catch (err) {
    console.error(
      `[webhooks/meta] AI reply pipeline failed sa=${route.subAccountId}`,
      err,
    );
  }
}

/**
 * Find an existing contact for this Meta user id within the sub-account, else
 * create one (name fetched best-effort from the Graph API). `seen` dedupes
 * within a single webhook payload so two events from the same sender don't mint
 * two contacts.
 */
async function reconcileContact(
  route: ResolvedRoute,
  senderId: string,
  channel: ConversationChannel,
  seen: Map<string, string>,
): Promise<{ id: string; name: string } | null> {
  const cached = seen.get(senderId);
  const db = getAdminDb();
  if (cached) {
    const snap = await db.collection("contacts").doc(cached).get();
    return { id: cached, name: (snap.data()?.name as string) ?? "" };
  }

  // Single-field equality (auto-indexed) + in-code tenancy filter — avoids a
  // declared composite index.
  const matches = await db
    .collection("contacts")
    .where("metaUserId", "==", senderId)
    .limit(5)
    .get();
  const existing = matches.docs.find(
    (d) => (d.data().subAccountId as string) === route.subAccountId,
  );
  if (existing) {
    seen.set(senderId, existing.id);
    return { id: existing.id, name: (existing.data().name as string) ?? "" };
  }

  const profileName = await getMetaUserName(senderId, route.pageAccessToken);
  try {
    const created = await createContactServerSide({
      subAccountId: route.subAccountId,
      agencyId: route.agencyId,
      createdByUid: "meta-inbound",
      mode: "live",
      name: profileName ?? "",
      email: "",
      phone: "",
      company: "",
      address: "",
      source: channel === "instagram" ? "instagram" : "facebook",
      tags: [],
    });
    // Stamp the Meta user id so subsequent messages reconcile to this contact.
    await db
      .collection("contacts")
      .doc(created.id)
      .update({ metaUserId: senderId });
    seen.set(senderId, created.id);
    return { id: created.id, name: profileName ?? "" };
  } catch (err) {
    console.error(
      `[webhooks/meta] contact create failed sa=${route.subAccountId} sender=${senderId}`,
      err,
    );
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verify = metaWebhookVerifyToken();
  if (mode === "subscribe" && verify && token === verify) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  let payload: MetaWebhookBody;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const object = payload.object ?? "page";
  // Narrower than ConversationChannel — the AI dispatch needs the platform
  // union specifically; it widens fine everywhere ConversationChannel is
  // expected.
  const channel: "messenger" | "instagram" =
    object === "instagram" ? "instagram" : "messenger";
  const seen = new Map<string, string>();
  const db = getAdminDb();

  for (const entry of payload.entry ?? []) {
    const entryId = entry.id;
    if (!entryId) continue;

    let route: ResolvedRoute | null = null;
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      // Phase A: text messages only. Skip echoes (our own sends), reactions,
      // postbacks, read receipts, and any event without a sender/body.
      if (!senderId || !text || event.message?.is_echo) continue;

      // Resolve + gate-check once per entry, lazily (only when there's real work).
      if (!route) {
        route = await resolveRoute(object, entryId);
        if (!route) break; // unknown page/IG id or gate off → ignore this entry
      }

      const contact = await reconcileContact(route, senderId, channel, seen);
      if (!contact) continue;

      const mid = event.message?.mid || db.collection("contacts").doc().id;
      try {
        await db
          .collection("contacts")
          .doc(contact.id)
          .collection("metaMessages")
          .doc(mid)
          .set(
            {
              agencyId: route.agencyId,
              subAccountId: route.subAccountId,
              contactId: contact.id,
              channel,
              direction: "inbound",
              status: "received",
              body: text,
              from: senderId,
              to: entryId,
              metaMessageId: event.message?.mid ?? null,
              error: null,
              readAt: null,
              createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true }, // Meta retries on the same mid → idempotent
          );
      } catch (err) {
        console.warn("[webhooks/meta] message-row write failed", err);
      }

      await upsertConversationForMessage({
        contactId: contact.id,
        subAccountId: route.subAccountId,
        agencyId: route.agencyId,
        contactName: contact.name,
        contactPhone: null,
        channel,
        direction: "inbound",
        body: text,
      });

      // Phase B — AI auto-reply. Awaited (serverless can't fire-and-forget)
      // but every failure is swallowed inside; Meta's timeout comfortably
      // covers a Haiku reply (1-3s typical).
      await maybeDispatchAiReply({
        route,
        contactId: contact.id,
        channel,
        senderId,
        text,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
