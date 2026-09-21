import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import type { EmailSuppressionDoc, EmailSuppressionReason } from "@/types/email";

/**
 * Per-sub-account email suppression list (W4 PR1). An address on the list is
 * refused by `sendEmail` for every send that names the sub-account, so no send
 * path can skip it. Spec: docs/programme/w4-email-tracking.md.
 */

export const SUPPRESSION_REASONS: readonly EmailSuppressionReason[] = [
  "hard_bounce",
  "complaint",
  "manual",
];

const REASON_LABEL: Record<EmailSuppressionReason, string> = {
  hard_bounce: "hard bounce",
  complaint: "spam complaint",
  manual: "added manually",
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Doc id = sha256 of the normalised address: one `get()` per send, no escaping. */
export function suppressionDocPath(subAccountId: string, email: string): string {
  const id = createHash("sha256").update(normalizeEmail(email)).digest("hex");
  return `subAccounts/${subAccountId}/emailSuppressions/${id}`;
}

export async function findEmailSuppression(
  subAccountId: string,
  email: string
): Promise<EmailSuppressionDoc | null> {
  const snap = await getAdminDb().doc(suppressionDocPath(subAccountId, email)).get();
  return snap.exists ? (snap.data() as EmailSuppressionDoc) : null;
}

/** Thrown by `sendEmail` before any provider is called. */
export class EmailSuppressedError extends Error {
  readonly code = "email_suppressed";
  constructor(
    readonly email: string,
    readonly reason: EmailSuppressionReason
  ) {
    super(
      `Not sent: ${email} is on this workspace's email suppression list (${REASON_LABEL[reason] ?? reason}). ` +
        "An admin can remove it under Settings → Messaging → Email suppression list."
    );
    this.name = "EmailSuppressedError";
  }
}

export function isEmailSuppressedError(err: unknown): err is EmailSuppressedError {
  return err instanceof EmailSuppressedError;
}

/** Throws when `to` is suppressed for `subAccountId`. A failed lookup throws too: the send must not go out unchecked. */
export async function assertNotSuppressed(subAccountId: string, to: string): Promise<void> {
  const hit = await findEmailSuppression(subAccountId, to);
  if (hit) throw new EmailSuppressedError(normalizeEmail(to), hit.reason);
}

/**
 * When `err` is a suppression refusal, records it on the contact's activity
 * timeline so the host can see the email never went out, and returns true.
 * For sends with no human sender to show an error to (booking mail).
 */
export async function recordSuppressedEmail(
  err: unknown,
  a: { contactId: string | null | undefined; what: string; createdBy: string; eventId?: string }
): Promise<boolean> {
  if (!isEmailSuppressedError(err)) return false;
  if (!a.contactId) return true;
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(a.contactId)
      .collection("activities")
      .add({
        type: "email_suppressed",
        content: `${a.what} not sent: ${err.message}`,
        createdBy: a.createdBy,
        meta: { email: err.email, reason: err.reason, ...(a.eventId ? { eventId: a.eventId } : {}) },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (writeErr) {
    console.warn("[email-suppression] activity write failed", writeErr);
  }
  return true;
}
