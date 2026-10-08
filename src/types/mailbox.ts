export interface MailboxMeta {
  host: string;
  port: 993;
  username: string;
  sentFolder: string | null;
  verifiedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  enabled: boolean;
  /** Start of the last sync pass that read the INBOX to its end (lib/server/mailbox-sync.ts). */
  inboxCaughtUpAt?: string | null;
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
  /** The mystery-shop reply matcher failing on one message, pass after pass (lib/server/mailbox-match.ts). */
  matchFailure?: { folder: string; uidValidity: string; uid: number; count: number } | null;
  /** The last message passed after MAX_MATCH_FAILURES failed passes. */
  matchSkipped?: { folder: string; uidValidity: string; uid: number; at: string } | null;
}
