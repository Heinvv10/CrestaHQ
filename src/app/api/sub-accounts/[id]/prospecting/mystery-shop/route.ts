import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { REPORT_ID, prospectingAccess } from "@/lib/prospecting/reports";
import {
  MYSTERY_SHOP_CHANNELS,
  RESPONSE_WINDOW_MS,
  TIMER_GRACE_MS,
  mysteryShopCap,
  overdue,
  type MysteryShopChannel,
} from "@/lib/prospecting/mystery-shop/model";
import { allowedTargets, matchTarget } from "@/lib/prospecting/mystery-shop/targets";
import { enquiryVars, renderEnquiries } from "@/lib/prospecting/mystery-shop/enquiry";
import { jobValueFor } from "@/lib/prospecting/mystery-shop/job-value";
import { serializeShop } from "@/lib/prospecting/mystery-shop/section";
import { markSent, releaseShop, reserveShop, settleMissed, shopsUsed } from "@/lib/prospecting/mystery-shop/store";
import { channelStates, sendMysteryShop, type SendResult } from "@/lib/prospecting/mystery-shop/send";
import type { ContactProspecting, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Speed-to-lead mystery shops for one contact (Prospecting PR 5).
 *
 *   GET  ?contactId= → the contact's shops (newest first, member view), each
 *        channel's availability and allowed targets, the month's cap and use,
 *        and the enquiry as it would be sent. A `sent` shop whose 24 h timer
 *        should have fired is settled first, and a `queued` one stuck past
 *        STUCK_AFTER_MS (the send never finished) is released `failed`.
 *   POST `{ contactId, channel, confirm: true, target }` → send one neutral
 *        enquiry to the confirmed target. 202 `{ shopId }`.
 *
 * POST refusals, in order: 400 bad body; 403 gate_off; 404 contact (missing
 * or another sub-account's, the reports' body); 403 confirm_required; 403
 * channel_unavailable; 403 target_not_allowed (only the contact's own
 * values); 409 shop_in_progress; 403 cap_reached; 403 with the compliance
 * code when the send is refused (shop `refused`); 502 when the provider fails
 * (shop `failed`). Refused and failed shops give their cap slot back. A shop
 * does not stamp `approachedAt` and does not block outreach workflows.
 */

const CONTACT_NOT_FOUND = { error: "Contact not found" };
const STUCK_AFTER_MS = 10 * 60_000;
const TIMER_DELAY_S = (RESPONSE_WINDOW_MS + TIMER_GRACE_MS) / 1000;

const isChannel = (v: unknown): v is MysteryShopChannel =>
  typeof v === "string" && (MYSTERY_SHOP_CHANNELS as readonly string[]).includes(v);

const refuse = (code: string, error: string, status = 403) => NextResponse.json({ error, code }, { status });

async function loadContact(subAccountId: string, contactId: string): Promise<Contact | null> {
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  const data = snap.data();
  return snap.exists && data?.subAccountId === subAccountId ? ({ ...data, id: snap.id } as Contact) : null;
}

const prospectingOf = (c: Contact) => (c as Contact & { prospecting?: ContactProspecting }).prospecting;
const enquiryFor = (c: Contact, sub: SubAccountDoc) =>
  renderEnquiries(sub.prospectingMysteryShopTemplates, enquiryVars({ ...c, prospecting: prospectingOf(c) }, sub.name));

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: subAccountId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const contactId = new URL(request.url).searchParams.get("contactId");
  if (!contactId || !REPORT_ID.test(contactId)) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }
  const contact = await loadContact(subAccountId, contactId);
  if (!contact) return NextResponse.json(CONTACT_NOT_FOUND, { status: 404 });

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
      ? settleMissed(d.id).then((s) => s === "missed")
      : data.status === "queued"
        ? releaseShop(d.id, "failed", { code: "stuck", reason: "The send did not complete." }, { olderThanMs: STUCK_AFTER_MS })
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
  return NextResponse.json({
    shops,
    channels,
    cap: mysteryShopCap(access.sub),
    used: await shopsUsed(subAccountId),
    enquiry: enquiryFor(contact, access.sub),
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
  const { contactId, channel, confirm, target } = body ?? {};
  if (typeof contactId !== "string" || !REPORT_ID.test(contactId)) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }
  if (!isChannel(channel)) return NextResponse.json({ error: "Unknown channel" }, { status: 400 });

  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const contact = await loadContact(subAccountId, contactId);
  if (!contact) return NextResponse.json(CONTACT_NOT_FOUND, { status: 404 });
  if (confirm !== true) return refuse("confirm_required", "Confirm the enquiry and its recipient first.");

  const state = (await channelStates(subAccountId, access.sub))[channel];
  if (!state.available) return refuse("channel_unavailable", state.reason ?? "This channel is not available.");
  const country = access.sub.defaultPhoneCountry;
  const to = matchTarget(channel, target, allowedTargets(channel, contact, country), country);
  if (!to) return refuse("target_not_allowed", "Only this contact's own address or number can be contacted.");

  const enquiry = enquiryFor(contact, access.sub);
  const value = jobValueFor(prospectingOf(contact), access.sub.prospectingJobValues);
  let reserved: Awaited<ReturnType<typeof reserveShop>>;
  try {
    reserved = await reserveShop({
      agencyId: access.agencyId,
      subAccountId,
      contactId,
      reportId: prospectingOf(contact)?.lastReportId ?? null,
      uid: access.uid,
      channel,
      target: to,
      targetLabel: to,
      enquiryText: channel === "email" ? `${enquiry.email.subject}\n\n${enquiry.email.body}` : enquiry.call,
      ...value,
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
  }).catch((err) => ({ ok: false as const, kind: "failed" as const, reason: err instanceof Error ? err.message : "Send failed" }));
  if (!result.ok) {
    const failure = result.kind === "refused" ? { code: result.code, reason: result.reason } : { code: "send_failed", reason: result.reason };
    await releaseShop(shopId, result.kind, failure).catch((err) =>
      console.error("[prospecting/mystery-shop] release failed", shopId, err),
    );
    return result.kind === "refused"
      ? refuse(result.code, result.reason)
      : refuse("send_failed", `The enquiry could not be sent: ${result.reason}`, 502);
  }

  try {
    await markSent(shopId, result.providerRef);
  } catch (err) {
    console.error("[prospecting/mystery-shop] sent but not recorded", shopId, err);
    return NextResponse.json({ error: "The enquiry was sent but could not be recorded. Do not send it again." }, { status: 500 });
  }
  const timer = await publishCallback({
    pathname: "/api/automations/prospecting/mystery-shop",
    body: { shopId },
    delaySeconds: TIMER_DELAY_S,
    deduplicationId: `mystery_shop_${shopId}`,
  }).catch(() => null);
  if (!timer) {
    // The send already happened; the GET sweep settles the shop instead.
    await getAdminDb()
      .doc(`mysteryShops/${shopId}`)
      .update({ timerError: "The 24 h timer could not be queued." })
      .catch((err) => console.error("[prospecting/mystery-shop] timerError write failed", shopId, err));
  }
  return NextResponse.json({ shopId }, { status: 202 });
}
