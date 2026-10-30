import "server-only";

import { formatBillingPrice } from "@/lib/billing/status";
import { formatUsageMonth } from "@/lib/billing/usage";
import {
  noPlatformSender,
  resolvePlatformSender,
  sendPlatformEmail,
  type PlatformSender,
} from "@/lib/comms/platform-email";
import { renderSystemEmail } from "@/lib/comms/system-email";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import type { UsageChargeLine } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

export type UsageEmailKind = "invoice" | "beforeDue" | "onDue" | "overdue";

/**
 * The sender usage mail goes out through, or null (logged) when there is none.
 * Resolved BEFORE a pay link is staged, so no link work is done for a send that
 * cannot go.
 */
export async function resolveUsageSender(subAccountId: string): Promise<PlatformSender | null> {
  const sender = await resolvePlatformSender(subAccountId);
  if (!sender) noPlatformSender("[usage-close] usage email", subAccountId);
  return sender;
}

/**
 * One usage-charge email (the invoice, then reminders) through the platform
 * sender. Returns whether it went out; never throws, since the charge is
 * already minted and must not be rolled back over email.
 */
export async function sendUsageEmail(input: {
  sender: PlatformSender;
  kind: UsageEmailKind;
  to: string;
  sub: SubAccountDoc;
  month: string;
  amountCents: number;
  currency: string;
  lineItems: UsageChargeLine[];
  payUrl: string;
  dueAt: Date;
}): Promise<boolean> {
  if (!input.payUrl) return false;
  try {
    const ws = input.sub.name || "Your workspace";
    const monthLabel = formatUsageMonth(input.month);
    const total = formatBillingPrice(input.amountCents, input.currency);
    const due = input.dueAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const subject = {
      invoice: `${ws}: usage for ${monthLabel} — ${total}`,
      beforeDue: `Reminder: ${ws} usage for ${monthLabel} is due ${due}`,
      onDue: `${ws} usage for ${monthLabel} is due today`,
      overdue: `${ws} usage for ${monthLabel} is overdue`,
    }[input.kind];
    const intro = {
      invoice: `Here is the usage for ${ws} in ${monthLabel}.`,
      beforeDue: `A friendly reminder: the usage charge for ${ws} (${monthLabel}) is due on ${due}.`,
      onDue: `The usage charge for ${ws} (${monthLabel}) is due today.`,
      overdue: `The usage charge for ${ws} (${monthLabel}) was due on ${due} and is now overdue.`,
    }[input.kind];
    const lines = input.lineItems.map(
      (l) => `${l.label}${l.detail ? ` (${l.detail})` : ""}: ${formatBillingPrice(l.amountCents, input.currency)}`,
    );
    const { text, html } = renderSystemEmail({
      brand: await resolveCustomBrand(),
      heading: `Usage for ${monthLabel}`,
      paragraphs: [intro, ...lines, [{ bold: `Total: ${total}` }, ` — due ${due}`]],
      button: { label: "Pay now", url: input.payUrl },
      note: "Payment is handled securely by our payment provider. Your card isn't saved.",
    });
    await sendPlatformEmail(input.sender, { to: input.to, subject, text, html });
    return true;
  } catch (err) {
    console.warn(`[usage-close] ${input.kind} email failed sa=${input.sub.id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
