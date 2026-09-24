import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatBillingPrice } from "@/lib/billing/status";
import type { AttentionItem } from "@/types/billing";

/**
 * Flagged payments — money that arrived but settled nothing, so a person must
 * act (refund, or reconcile by hand). Two writers already exist:
 *   - `billingEvents` rows of type payment.flagged / subscription.flagged
 *     (agency ↔ sub-account plan billing), and
 *   - `orders.attention` (a sub-account's own Stripe orders).
 * This module is the read side: it lists the unresolved ones, resolves them,
 * and emails the agency owner once per flag.
 *
 * `billingAttention/{flagId}` (server-only, default-deny in rules) holds, per
 * flag, the owner-notice claim and the resolution. It is kept apart from the
 * flag itself because both writers overwrite their flag on a redelivery.
 */

export const FLAGGED_BILLING_EVENTS = ["payment.flagged", "subscription.flagged"];

interface Resolver {
  uid: string;
  email: string;
}

const noticeRef = (flagId: string) => getAdminDb().collection("billingAttention").doc(flagId);

export const subscriptionFlagReason = (matches: number) =>
  `A new subscription matches ${matches} workspaces, so it was not linked to any of them.`;

export const billingEventFlagId = (eventDocId: string) => `event-${eventDocId}`;

/** A new note on the same order is a new flag; a replayed note is the same one. */
export const orderFlagId = (orderId: string, note: string) =>
  `order-${orderId}-${createHash("sha256").update(note).digest("hex").slice(0, 16)}`;

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number } | null | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : null;
}

async function resolvedIds(flagIds: string[]): Promise<Set<string>> {
  if (flagIds.length === 0) return new Set();
  const snaps = await getAdminDb().getAll(...flagIds.map(noticeRef));
  return new Set(snaps.filter((s) => s.exists && s.data()?.resolvedAt).map((s) => s.id));
}

function billingEventItem(id: string, data: Record<string, unknown>): AttentionItem {
  const detail = (data.detail ?? {}) as Record<string, unknown>;
  const isSubscription = data.event === "subscription.flagged";
  const candidates = Array.isArray(detail.candidates) ? detail.candidates.map(String) : [];
  return {
    flagId: billingEventFlagId(id),
    orderId: null,
    subAccountId: typeof data.subAccountId === "string" ? data.subAccountId : null,
    candidates,
    reason: isSubscription
      ? subscriptionFlagReason(candidates.length)
      : String(detail.reason ?? "Payment could not be applied."),
    amountCents: typeof detail.amountCents === "number" ? detail.amountCents : null,
    currency: typeof detail.currency === "string" ? detail.currency : null,
    reference: String((isSubscription ? detail.subscriptionId : detail.reference) ?? "") || null,
    createdAtMs: toMillis(data.createdAt),
  };
}

const newestFirst = (a: AttentionItem, b: AttentionItem) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);

/** Unresolved flagged billing events for every sub-account of one agency. */
export async function listAgencyBillingFlags(agencyId: string): Promise<AttentionItem[]> {
  const snap = await getAdminDb()
    .collection("billingEvents")
    .where("agencyId", "==", agencyId)
    .where("event", "in", FLAGGED_BILLING_EVENTS)
    .get();
  const items = snap.docs.map((d) => billingEventItem(d.id, d.data()));
  const done = await resolvedIds(items.map((i) => i.flagId));
  return items.filter((i) => !done.has(i.flagId)).sort(newestFirst);
}

/** Unresolved `attention` notes on one sub-account's orders. */
export async function listOrderFlags(subAccountId: string): Promise<AttentionItem[]> {
  const snap = await getAdminDb().collection("orders").where("subAccountId", "==", subAccountId).get();
  const items = snap.docs
    .filter((d) => typeof d.data().attention === "string" && d.data().attention)
    .map((d): AttentionItem => {
      const o = d.data();
      return {
        flagId: orderFlagId(d.id, o.attention as string),
        orderId: d.id,
        subAccountId,
        candidates: [],
        reason: o.attention as string,
        amountCents: typeof o.totalCents === "number" ? o.totalCents : null,
        currency: typeof o.currency === "string" ? o.currency : null,
        reference: (o.stripePaymentIntentId as string | null) ?? (o.stripeCheckoutSessionId as string | null) ?? null,
        createdAtMs: toMillis(o.paidAt) ?? toMillis(o.createdAt),
      };
    });
  const done = await resolvedIds(items.map((i) => i.flagId));
  return items.filter((i) => !done.has(i.flagId)).sort(newestFirst);
}

/** First resolution wins; resolving again is a no-op. */
async function markResolved(flagId: string, owner: { agencyId: string; subAccountId: string | null }, by: Resolver) {
  const db = getAdminDb();
  const ref = noticeRef(flagId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.resolvedAt) return;
    tx.set(
      ref,
      {
        ...owner,
        resolvedAt: FieldValue.serverTimestamp(),
        resolvedByUid: by.uid,
        resolvedByEmail: by.email || null,
      },
      { merge: true },
    );
  });
}

/** False when the flag does not exist or belongs to another agency. */
export async function resolveAgencyBillingFlag(agencyId: string, flagId: string, by: Resolver): Promise<boolean> {
  if (!flagId.startsWith("event-")) return false;
  const snap = await getAdminDb().collection("billingEvents").doc(flagId.slice("event-".length)).get();
  const data = snap.data();
  if (!snap.exists || !data || data.agencyId !== agencyId || !FLAGGED_BILLING_EVENTS.includes(String(data.event))) {
    return false;
  }
  await markResolved(flagId, { agencyId, subAccountId: (data.subAccountId as string | null) ?? null }, by);
  return true;
}

/**
 * "not_found" when the order is not this sub-account's or carries no note;
 * "stale" when its note changed since the caller listed it (the caller would
 * be resolving a flag it has not seen).
 */
export async function resolveOrderFlag(
  subAccountId: string,
  orderId: string,
  flagId: string,
  by: Resolver,
): Promise<"ok" | "not_found" | "stale"> {
  const snap = await getAdminDb().doc(`orders/${orderId}`).get();
  const o = snap.data();
  if (!snap.exists || !o || o.subAccountId !== subAccountId || typeof o.attention !== "string" || !o.attention) {
    return "not_found";
  }
  if (orderFlagId(orderId, o.attention) !== flagId) return "stale";
  await markResolved(flagId, { agencyId: String(o.agencyId ?? ""), subAccountId }, by);
  return "ok";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Email the agency owner about a flag that was just written — once per flag.
 * The `billingAttention` doc is created before sending, so a webhook
 * redelivery that re-writes the same flag finds it and sends nothing. At most
 * once: a send that fails is logged, not retried. Never throws — the flag
 * itself has already been written and must not be rolled back over an email.
 */
export async function notifyAgencyOwnerOfFlag(input: {
  flagId: string;
  agencyId: string;
  subAccountId: string | null;
  reason: string;
  amountCents: number | null;
  currency: string | null;
  reference: string | null;
}): Promise<void> {
  try {
    // Dynamic: resend.ts pulls in the conversation + usage services, and the
    // flag writers that call this sit underneath those.
    const { emailIsConfigured, sendEmail } = await import("@/lib/comms/resend");
    if (!emailIsConfigured() || !input.agencyId) return;
    const db = getAdminDb();
    const agency = (await db.doc(`agencies/${input.agencyId}`).get()).data() ?? {};
    let to: string | null = null;
    if (typeof agency.ownerUid === "string" && agency.ownerUid) {
      to = ((await db.doc(`users/${agency.ownerUid}`).get()).data()?.email as string | undefined) ?? null;
    }
    to = to ?? (agency.supportEmail as string | undefined) ?? null;
    if (!to) {
      console.error(`[billing-attention] no owner email for agency ${input.agencyId} — flag ${input.flagId} not emailed`);
      return;
    }
    try {
      await noticeRef(input.flagId).create({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        notifiedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if ((err as { code?: unknown })?.code === 6) return; // already emailed (or resolved)
      throw err;
    }
    const subName = input.subAccountId
      ? String((await db.doc(`subAccounts/${input.subAccountId}`).get()).data()?.name ?? input.subAccountId)
      : "a sub-account";
    const amount = formatBillingPrice(input.amountCents, input.currency);
    const lines: Array<[string, string]> = [
      ["Sub-account", subName],
      ["Reason", input.reason],
      ["Amount", amount],
      ["Reference", input.reference ?? "—"],
    ];
    const subject = `A payment needs attention — ${subName.replace(/[\r\n]+/g, " ")}`;
    const text = [
      "A payment arrived that could not be applied automatically. It may need a refund or a manual fix.",
      "",
      ...lines.map(([k, v]) => `${k}: ${v}`),
      "",
      "Review it under Client billing (plan payments) or the sub-account's Reports → Payments (orders), then mark it resolved.",
    ].join("\n");
    const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">A payment needs attention</h2>
      <p>A payment arrived that could not be applied automatically. It may need a refund or a manual fix.</p>
      <table style="border-collapse:collapse;font-size:14px;">${lines
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</table>
      <p style="color:#6b7280;font-size:13px;margin-top:20px;">Review it under Client billing (plan payments) or the sub-account's Reports → Payments (orders), then mark it resolved.</p>
    </div>`;
    try {
      await sendEmail({ to, subject, text, html });
      await noticeRef(input.flagId).update({ notifiedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      console.error(`[billing-attention] owner email for flag ${input.flagId} failed`, err);
      await noticeRef(input.flagId).update({ notifyError: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    console.error(`[billing-attention] could not notify for flag ${input.flagId}`, err);
  }
}
