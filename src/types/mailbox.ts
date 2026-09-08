export interface MailboxMeta {
  host: string;
  port: 993;
  username: string;
  sentFolder: string | null;
  verifiedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  enabled: boolean;
}
export interface MailboxCursor {
  uidValidity: string;
  uid: number;
  initialComplete: boolean;
}
export interface MailboxConnection extends MailboxMeta {
  nextFolder?: string;
  password: string;
  version: string;
  ownAddresses: string[];
  initialSince: string;
  cursors: Record<string, MailboxCursor>;
  leaseToken: string | null;
  leaseUntil: number;
}
