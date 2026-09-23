import "server-only";

import type { Firestore } from "firebase-admin/firestore";

/**
 * Delivery receipts after a send, for both Meta rails (Cloud webhook `statuses`
 * and Twilio's per-message statusCallback). Without them a message Meta later
 * refused (131047 re-engagement, 131026 undeliverable, 63016 outside the
 * window…) sat in the thread as "sent" forever.
 *
 * Only an outbound row that already exists is touched — a receipt never
 * creates a row — and only one under a contact of the sub-account the webhook
 * resolved, whose own `subAccountId` agrees. Receipts arrive out of order, so a
 * status only ever moves a row forward: a late "delivered" never overwrites
 * "read" or "failed".
 */

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

/** Maps either rail's vocabulary onto the row's. Null = not a state we keep
 *  (Twilio's queued/sending/accepted). */
export function normalizeDeliveryStatus(raw: string): DeliveryStatus | null {
  switch (raw.trim().toLowerCase()) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
    case "undelivered":
      return "failed";
    default:
      return null;
  }
}

export async function recordWhatsappDeliveryStatus(opts: {
  db: Firestore;
  subAccountId: string;
  /** The customer's number, E.164 — how the row's contact is found. */
  recipientPhone: string;
  providerMessageId: string;
  status: DeliveryStatus;
  errorCode?: string | null;
  errorTitle?: string | null;
}): Promise<{ updated: number }> {
  if (!opts.recipientPhone || !opts.providerMessageId) return { updated: 0 };
  const contacts = await opts.db
    .collection("contacts")
    .where("phone", "==", opts.recipientPhone)
    .where("subAccountId", "==", opts.subAccountId)
    .limit(5)
    .get();

  const error =
    opts.status === "failed"
      ? [opts.errorCode, opts.errorTitle].filter(Boolean).join(": ") ||
        "Delivery failed"
      : null;

  let updated = 0;
  for (const contact of contacts.docs) {
    const ref = contact.ref
      .collection("whatsappMessages")
      .doc(opts.providerMessageId);
    const moved = await opts.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const row = snap.data() as
        | { subAccountId?: string; direction?: string; status?: string }
        | undefined;
      // A receipt that beats its row (the row is written just after the
      // provider call returns) is dropped: receipts never create rows. Rare,
      // and by design — a ghost row would have no body or direction.
      if (!snap.exists || !row) return false;
      if (row.subAccountId !== opts.subAccountId) return false;
      if (row.direction !== "outbound") return false;
      if ((RANK[row.status ?? ""] ?? 0) >= RANK[opts.status]) return false;
      tx.update(ref, {
        status: opts.status,
        ...(error ? { error } : {}),
      });
      return true;
    });
    if (moved) updated++;
  }
  return { updated };
}
