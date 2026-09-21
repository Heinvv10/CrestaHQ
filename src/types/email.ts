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
