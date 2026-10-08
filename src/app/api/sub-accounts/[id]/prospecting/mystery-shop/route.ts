import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { prospectingAccess } from "@/lib/prospecting/reports";
import {
  MYSTERY_SHOP_CHANNELS,
  RESPONSE_WINDOW_MS,
  TIMER_GRACE_MS,
  mysteryShopCap,
  overdue,
  type MysteryShopChannel,
} from "@/lib/prospecting/mystery-shop/model";
import { allowedTargets, emailDomainTrusted, matchTarget } from "@/lib/prospecting/mystery-shop/targets";
import { jobValueFor } from "@/lib/prospecting/mystery-shop/job-value";
import { serializeShop } from "@/lib/prospecting/mystery-shop/section";
import {
  markSent,
  markUncertain,
  releaseShop,
  reserveShop,
  settleMissed,
  shopsUsed,
} from "@/lib/prospecting/mystery-shop/store";
import { channelStates, sendMysteryShop, type SendResult } from "@/lib/prospecting/mystery-shop/send";
import { enquiryOf, loadContact, queueTimer, type ShopContact } from "@/lib/prospecting/mystery-shop/context";

/**
 * Speed-to-lead mystery shops for one prospect contact (Prospecting PR 5).
 *
 *   GET  ?contactId= → the contact's shops (newest first, member view), each
 *        channel's availability and allowed targets, the month's cap and use,
 *        and the enquiry as it would be sent with its hash. A `sent` shop whose
 *        24 h timer should have fired is settled first (an email one only once
 *        the mailbox sync has read past the window), and a `queued` one stuck
 *        past STUCK_AFTER_MS is treated as an uncertain send.
 *   POST `{ contactId, channel, confirm: true, target, enquiryHash, consentAck? }`
 *        → send one neutral enquiry to the confirmed target. 202 `{ shopId }`.
 *
 * POST refusals, in order: 400 bad body; 403 gate_off; 404 contact (missing
 * or another sub-account's, the reports' body); 403 not_a_prospect; 403
 * confirm_required; 403 consent_required (a call without the operator's
 * consent); 403 channel_unavailable; 403 target_not_allowed (only the
 * contact's own values); 409 enquiry_changed (the hash of the text the dialog
 * showed no longer matches); 409 shop_in_progress; 403 cap_reached; 403 with
 * the compliance code when the send is refused (shop `refused`); 502 when the
 * provider failed (shop `failed`). Both give their cap slot back. A send that
 * MAY have gone out is kept `sent` + `sendUncertain` (slot kept, timer
 * queued, still blocking a second send) and answers 502 with a fixed warning.
 * A shop does not stamp `approachedAt` and does not block outreach workflows.
 */

const CONTACT_NOT_FOUND = { error: "Contact not found" };
const STUCK_AFTER_MS = 10 * 60_000;
const TIMER_DELAY_S = (RESPONSE_WINDOW_MS + TIMER_GRACE_MS) / 1000;
const MAYBE_SENT = "The enquiry may have been sent; check the contact's conversation before trying again.";
const NOT_SENT = "The enquiry could not be sent. Check the channel's settings and try again.";

const isChannel = (v: unknown): v is MysteryShopChannel =>
  typeof v === "string" && (MYSTERY_SHOP_CHANNELS as readonly string[]).includes(v);

const refuse = (code: string, error: string, status = 403) => NextResponse.json({ error, code }, { status });
const notProspect = () => refuse("not_a_prospect", "Mystery shops are for prospects only.");
/**
 * A prospect carries the server-owned `prospecting` map. Stricter than the
 * approach guard's isProspect, which also accepts `source`, a field members
 * can write.
 */
const isProspect = (c: ShopContact) => typeof c.prospecting === "object" && c.prospecting !== null;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const contactId = new URL(request.url).searchParams.get("contactId");
  if (!isDocId(contactId)) return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  const contact = await loadContact(subAccountId, contactId);
  if (!contact) return NextResponse.json(CONTACT_NOT_FOUND, { status: 404 });
  if (!isProspect(contact)) return notProspect();

  // Equality-only, sorted in memory: no composite index.
  const query = getAdminDb()
    .collection("mysteryShops")
    .where("subAccountId", "==", subAccountId)
    .where("contactId", "==", contactId);
  let snap = await query.get();
  let swept = false;
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    const settle = overdue(data, Date.now())
      ? settleMissed(d.id).then((s) => s === "missed" || (s === "awaiting_sync" && data.awaitingSync !== true))
      : data.status === "queued"
        ? markUncertain(d.id, null, { olderThanMs: STUCK_AFTER_MS })
        : null;
    if (!settle) continue;
    swept =
      (await settle.catch((err) => {
        console.error("[prospecting/mystery-shop] sweep failed", d.id, err);
        return false;
      })) || swept;
  }
  if (swept) snap = await query.get();

  const shops = snap.docs
    .map((d) => serializeShop(d.id, d.data() ?? {}))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const country = access.sub.defaultPhoneCountry;
  const states = await channelStates(subAccountId, access.sub);
  const channels = Object.fromEntries(
    MYSTERY_SHOP_CHANNELS.map((c) => [c, { ...states[c], targets: allowedTargets(c, contact, country) }]),
  );
  const { text: _text, hash: enquiryHash, ...enquiry } = enquiryOf(contact, access.sub);
  return NextResponse.json({
    shops,
    channels,
    cap: mysteryShopCap(access.sub),
    used: await shopsUsed(subAccountId),
    enquiry,
    enquiryHash,
  });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { contactId, channel, confirm, target, enquiryHash, consentAck } = body ?? {};
  if (!isDocId(contactId)) return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  if (!isChannel(channel)) return NextResponse.json({ error: "Unknown channel" }, { status: 400 });

  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const contact = await loadContact(subAccountId, contactId);
  if (!contact) return NextResponse.json(CONTACT_NOT_FOUND, { status: 404 });
  if (!isProspect(contact)) return notProspect();
  if (confirm !== true) return refuse("confirm_required", "Confirm the enquiry and its recipient first.");
  if (channel === "call" && consentAck !== true) {
    return refuse("consent_required", "Confirm you have consent to call this number.");
  }

  const state = (await channelStates(subAccountId, access.sub))[channel];
  if (!state.available) return refuse("channel_unavailable", state.reason ?? "This channel is not available.");
  const country = access.sub.defaultPhoneCountry;
  const to = matchTarget(channel, target, allowedTargets(channel, contact, country), country);
  if (!to) return refuse("target_not_allowed", "Only this contact's own address or number can be contacted.");

  const enquiry = enquiryOf(contact, access.sub);
  const kind = channel === "email" ? "email" : "call";
  if (enquiryHash !== enquiry.hash[kind]) {
    return refuse("enquiry_changed", "The enquiry changed — reopen the dialog.", 409);
  }
  let reserved: Awaited<ReturnType<typeof reserveShop>>;
  try {
    reserved = await reserveShop({
      agencyId: access.agencyId,
      subAccountId,
      contactId,
      reportId: contact.prospecting?.lastReportId ?? null,
      uid: access.uid,
      channel,
      target: to,
      targetLabel: to,
      // The server-owned prospecting.website only: a member can edit contact.website.
      targetDomainTrusted: channel === "email" && emailDomainTrusted(to, contact.prospecting?.website),
      enquiryText: enquiry.text[kind],
      ...jobValueFor(contact.prospecting, access.sub.prospectingJobValues),
      cap: mysteryShopCap(access.sub),
    });
  } catch (err) {
    console.error("[prospecting/mystery-shop] reservation failed", err);
    return NextResponse.json({ error: "Could not start the mystery shop. Try again." }, { status: 500 });
  }
  if (reserved === "shop_in_progress") {
    return refuse("shop_in_progress", "A mystery shop on this channel is already waiting for a reply.", 409);
  }
  if (reserved === "cap_reached") return refuse("cap_reached", "This month's mystery-shop limit is used up.");

  const { shopId } = reserved;
  const result: SendResult = await sendMysteryShop({
    shopId, channel, target: to, subAccountId, sub: access.sub, contact, contactId, uid: access.uid, enquiry,
    consentAck: consentAck === true,
  }).catch((err) => ({ ok: false as const, kind: "uncertain" as const, providerRef: null, reason: String(err) }));

  if (!result.ok && result.kind !== "uncertain") {
    if (result.kind === "failed") console.error("[prospecting/mystery-shop] send failed", shopId, result.reason);
    const failure = result.kind === "refused" ? { code: result.code, reason: result.reason } : { code: "send_failed", reason: NOT_SENT };
    await releaseShop(shopId, result.kind, failure).catch((err) =>
      console.error("[prospecting/mystery-shop] release failed", shopId, err),
    );
    return result.kind === "refused" ? refuse(result.code, result.reason) : refuse("send_failed", NOT_SENT, 502);
  }

  // Sent — or maybe sent. A shop that may have gone out is never released: it stays open and timed.
  let recorded = false;
  if (result.ok) {
    recorded = await markSent(shopId, result.providerRef).then(
      (at) => at !== null,
      (err) => (console.error("[prospecting/mystery-shop] sent but not recorded", shopId, err), false),
    );
  } else {
    console.error("[prospecting/mystery-shop] send outcome unknown", shopId, result.reason);
  }
  if (!recorded) {
    const marked = await markUncertain(shopId, result.providerRef).catch((err) => {
      console.error("[prospecting/mystery-shop] uncertain write failed", shopId, err);
      return false;
    });
    if (marked) await queueTimer(shopId, TIMER_DELAY_S, `mystery_shop_${shopId}`);
    return refuse("send_uncertain", MAYBE_SENT, 502);
  }
  await queueTimer(shopId, TIMER_DELAY_S, `mystery_shop_${shopId}`);
  return NextResponse.json({ shopId }, { status: 202 });
}
