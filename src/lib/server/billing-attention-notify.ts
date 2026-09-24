import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatBillingPrice } from "@/lib/billing/status";

/**
 * Email about a flag that was just written — once per flag.
 *
 * Who: plan-billing flags go to the agency owner (the agency's money); order
 * flags go to the sub-account's active admins (their money, they refund),
 * falling back to the agency owner when the sub-account has none.
 *
 * How: the deployment's shared sender when it is configured; otherwise the
 * SMTP of the sub-account the flag belongs to (for an ambiguous subscription,
 * the first candidate with one). A deployment that sends only through
 * per-sub-account SMTP has no shared sender, and agency-level mail would
 * otherwise go nowhere. No sender at all is logged, never silent.
 *
 * Once: `billingAttention/{flagId}` is created before sending, so a webhook
 * redelivery that re-writes the same flag sends nothing. At most once: a
 * failed send is logged and recorded on that doc, not retried. Never throws —
 * the flag has already been written and must not be rolled back over email.
 */

export type FlagAudience = "agencyOwner" | "subAccountAdmins";

export interface FlagNotice {
  flagId: string;
  agencyId: string;
  subAccountId: string | null;
  /** subscription.flagged: the workspaces the subscription could belong to. */
  candidates?: string[];
  audience: FlagAudience;
  reason: string;
  amountCents: number | null;
  currency: string | null;
  reference: string | null;
}

type Resend = typeof import("@/lib/comms/resend");
type Sender = { smtpSubAccountId: string | null; sub: Record<string, unknown> | null };

async function pickSender(mail: Resend, subAccountIds: string[]): Promise<Sender | null> {
  if (mail.emailIsConfigured()) return { smtpSubAccountId: null, sub: null };
  for (const id of subAccountIds) {
    const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data();
    if (sub?.emailProvider === "smtp" && mail.emailIsConfigured(sub)) return { smtpSubAccountId: id, sub };
  }
  return null;
}

async function agencyOwnerEmail(agencyId: string): Promise<string[]> {
  const db = getAdminDb();
  const agency = (await db.doc(`agencies/${agencyId}`).get()).data() ?? {};
  let to: string | null = null;
  if (typeof agency.ownerUid === "string" && agency.ownerUid) {
    to = ((await db.doc(`users/${agency.ownerUid}`).get()).data()?.email as string | undefined) ?? null;
  }
  to = to ?? (agency.supportEmail as string | undefined) ?? null;
  return to ? [to] : [];
}

async function subAccountAdminEmails(subAccountId: string): Promise<string[]> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/subAccountMembers`)
    .where("role", "==", "admin")
    .where("status", "==", "active")
    .get();
  return [...new Set(snap.docs.map((d) => String(d.data().email ?? "").trim()).filter(Boolean))];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function notifyFlag(input: FlagNotice): Promise<void> {
  const tag = `[billing-attention] flag ${input.flagId}`;
  try {
    if (!input.agencyId) {
      console.error(`${tag}: no agency on the flag — not emailed`);
      return;
    }
    // Dynamic: resend.ts pulls in the conversation + usage services, and the
    // flag writers that call this sit underneath those.
    const mail = await import("@/lib/comms/resend");
    const saIds = [input.subAccountId, ...(input.candidates ?? [])].filter((x): x is string => !!x);
    const sender = await pickSender(mail, saIds);
    if (!sender) {
      console.error(`${tag}: no email sender (no shared sender, no verified SMTP on ${saIds.join(", ") || "any sub-account"}) — not emailed`);
      return;
    }
    let to =
      input.audience === "subAccountAdmins" && input.subAccountId
        ? await subAccountAdminEmails(input.subAccountId)
        : [];
    if (to.length === 0) to = await agencyOwnerEmail(input.agencyId);
    if (to.length === 0) {
      console.error(`${tag}: no recipient email for agency ${input.agencyId} — not emailed`);
      return;
    }

    const ref = getAdminDb().collection("billingAttention").doc(input.flagId);
    try {
      await ref.create({
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
      ? String((await getAdminDb().doc(`subAccounts/${input.subAccountId}`).get()).data()?.name ?? input.subAccountId)
      : "a sub-account";
    const lines: Array<[string, string]> = [
      ["Sub-account", subName],
      ["Reason", input.reason],
      ["Amount", formatBillingPrice(input.amountCents, input.currency)],
      ["Reference", input.reference ?? "—"],
    ];
    const where =
      input.audience === "subAccountAdmins"
        ? "Review it under Reports → Payments, then mark it resolved."
        : "Review it under Agency → Client billing, then mark it resolved.";
    const subject = `A payment needs attention — ${subName.replace(/[\r\n]+/g, " ")}`;
    const intro = "A payment arrived that could not be applied automatically. It may need a refund or a manual fix.";
    const text = [intro, "", ...lines.map(([k, v]) => `${k}: ${v}`), "", where].join("\n");
    const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">A payment needs attention</h2>
      <p>${escapeHtml(intro)}</p>
      <table style="border-collapse:collapse;font-size:14px;">${lines
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</table>
      <p style="color:#6b7280;font-size:13px;margin-top:20px;">${escapeHtml(where)}</p>
    </div>`;

    const via = sender.smtpSubAccountId
      ? { subAccount: sender.sub, meter: { subAccountId: sender.smtpSubAccountId }, archive: false }
      : {};
    const failures: string[] = [];
    for (const recipient of to) {
      try {
        await mail.sendEmail({ to: recipient, subject, text, html, ...via });
      } catch (err) {
        failures.push(`${recipient}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      console.error(`${tag}: email failed`, failures);
      await ref.update({ notifyError: failures.join("; ") });
    }
    if (failures.length < to.length) await ref.update({ notifiedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error(`${tag}: could not notify`, err);
  }
}
