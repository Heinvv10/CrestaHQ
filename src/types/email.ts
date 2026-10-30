import type { Timestamp, FieldValue } from "firebase/firestore";

export interface SmtpMeta {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromEmail: string;
  fromName: string;
  verifiedAt: string;
}

export interface SmtpConnection extends SmtpMeta {
  password: string;
}

export interface EmailMessageDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  direction: "inbound" | "outbound";
  subject: string;
  body: string;
  from: string;
  to: string[];
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  status: "sent" | "received";
  createdAt: Timestamp | FieldValue | null;
  sentByUid: string | null;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** Why an address is on a sub-account's suppression list. */
export type EmailSuppressionReason = "hard_bounce" | "complaint" | "manual";

/**
 * `subAccounts/{id}/emailSuppressions/{sha256(email)}` — an address this
 * sub-account never emails again until an admin removes it.
 */
export interface EmailSuppressionDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  /** Normalised (trimmed, lower-case). */
  email: string;
  reason: EmailSuppressionReason;
  note: string | null;
  createdAt: Timestamp | FieldValue | null;
}
