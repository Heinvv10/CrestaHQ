import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Bulk email broadcasts.
 *
 * Schema:
 *   broadcasts/{broadcastId}                  — the broadcast doc
 *   broadcasts/{broadcastId}/sends/{contactId} — per-recipient row
 *
 * The broadcast doc tracks the audience as a whole (totals, status, who
 * triggered it). The per-recipient subcollection rows are the unit of work
 * fanned out via QStash — one row, one /step callback, one Resend API
 * call. Status transitions on the row drive the totals on the parent doc
 * via FieldValue.increment().
 *
 * Channel is email-only in v1. SMS broadcasts come in a follow-up that adds
 * compliance scaffolding (consent capture, A2P 10DLC throughput awareness).
 */

export type BroadcastChannel = "email";

export type BroadcastStatus =
  /** Audience computed, sends queued, QStash messages published. */
  | "queued"
  /** First send has fired; at least one row has flipped from queued. */
  | "sending"
  /** Every row has settled (sent / skipped / failed). */
  | "completed"
  /** Hard-failed during creation (e.g. QStash misconfigured). */
  | "failed"
  /** Stopped by the operator; rows still queued settle as skipped. */
  | "cancelled";

/**
 * Audience filter applied at fan-out time. v1 supports three modes — full
 * sub-account contacts, a single tag, or a single pipeline stage. v2 will
 * stack filters and add saved Smart Lists.
 */
export type BroadcastAudienceFilter =
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "pipeline_stage"; stage: string };

export interface BroadcastTotals {
  /** Total contacts the audience query returned (before opt-out / missing-email skip). */
  audienceSize: number;
  /** Recipients fanned out to QStash. */
  queued: number;
  /** Recipients confirmed delivered to Resend (their API accepted the send). */
  sent: number;
  /** Recipients dropped pre-send (opted out, no email address, etc.). */
  skipped: number;
  /** Recipients where the Resend API call returned an error. */
  failed: number;
  // Engagement (our own pixel / click redirect, lib/broadcasts/engagement.ts);
  // absent on older docs = 0. Each counts recipients once, not events.
  opened?: number;
  clicked?: number;
  // Resend delivery events (lib/comms/email-events.ts); never set for SMTP
  // sends, which report no delivery events. Recipients, counted once.
  delivered?: number;
  bounced?: number;
  complained?: number;
}

export interface BroadcastDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  channel: BroadcastChannel;
  templateId: string;
  /** Snapshot of the template name at send time — survives template renames. */
  templateName: string;
  /** Snapshot of the resolved subject (after merge tags). Useful for the list view. */
  subjectPreview: string;
  audienceFilter: BroadcastAudienceFilter;
  status: BroadcastStatus;
  totals: BroadcastTotals;
  /** UID of the user who triggered the send. */
  createdByUid: string;
  /** Display name + email of the trigger user — survives user deletion. */
  createdBy: {
    displayName: string;
    email: string;
  };
  createdAt: Timestamp | FieldValue | null;
  startedAt: Timestamp | FieldValue | null;
  completedAt: Timestamp | FieldValue | null;
  /** Populated when status === "failed". */
  errorMessage: string | null;
  /**
   * False while the fanout step is still paging through the audience; the
   * broadcast cannot complete before it turns true. Absent on broadcasts
   * created before paged fan-out — those were fully fanned out at creation.
   */
  fanoutDone?: boolean;
  /** An API agent's broadcast, as a person approved it: the template's
   *  fingerprint (lib/broadcasts/approved.ts) and the recipient count shown. */
  approved?: { templateFingerprint: string; audienceCap: number; at: Date | Timestamp } | null;
  /** Click-tracked link docs under `links/`, capped (lib/broadcasts/email-tracking.ts). */
  trackedLinkCount?: number;
}

/** Reasons the step executor skips a recipient WITHOUT calling Resend. */
export type BroadcastSkipReason =
  /** contact.emailOptedOut === true at send time. */
  | "opt_out"
  /** Contact has no email address (defensive — pre-filter usually catches this). */
  | "no_email"
  /** Send window outside the sub-account's configured hours (will defer + retry). */
  | "send_window_deferred"
  /** Contact was deleted between fan-out and send. */
  | "contact_missing"
  /** Address is on the sub-account's email suppression list at send time. */
  | "suppressed"
  /** The operator cancelled the broadcast before this row sent. */
  | "cancelled"
  /** Beyond the recipient count a person approved for an API agent's broadcast. */
  | "over_approved_audience"
  /** An API agent edited the contact after the agent's broadcast was approved. */
  | "edited_by_agent_after_approval"
  /** The sub-account's automations kill switch was on at send time. */
  | "automations_paused"
  /** The agency turned broadcasts off for the sub-account mid-send. */
  | "agency_disabled";

export type BroadcastSendStatus =
  | "queued"
  | "sent"
  | "skipped"
  | "failed";

export interface BroadcastSendDoc {
  id: string; // === contactId
  broadcastId: string;
  agencyId: string;
  subAccountId: string;
  contactId: string;
  /** Snapshot of the contact's email at fan-out time — audit even if contact deleted. */
  toEmail: string;
  /** Snapshot of the contact's display name. */
  toName: string;
  status: BroadcastSendStatus;
  skippedReason: BroadcastSkipReason | null;
  /** Resend message id once the send succeeds. */
  resendMessageId: string | null;
  /** Resend API error message when status === "failed". */
  error: string | null;
  /** Number of step-executor attempts for this row (capped to prevent retry storms). */
  attempts: number;
  queuedAt: Timestamp | FieldValue | null;
  sentAt: Timestamp | FieldValue | null;
  /** Set when a step claims the row for sending — a redelivery never sends twice. */
  claimedAt?: Timestamp | FieldValue | null;
  /** Token of the claim holder; only that holder's settle lands. */
  claimId?: string;
  // Engagement, absent until it happens (lib/broadcasts/engagement.ts).
  /** First open — an estimate: privacy proxies preload images. */
  openedAt?: Timestamp | FieldValue | null;
  /** First click. */
  clickedAt?: Timestamp | FieldValue | null;
  /** Capped at ENGAGEMENT_COUNT_CAP. */
  opens?: number;
  clicks?: number;
  // Resend delivery events, absent until reported (lib/comms/email-events.ts).
  deliveredAt?: Timestamp | FieldValue | null;
  /** A bounced row takes no further events. */
  bouncedAt?: Timestamp | FieldValue | null;
  /** Resend's bounce type · subtype · message, capped at 300 characters. */
  bounceReason?: string;
  /** A permanent bounce (also one reported after a transient bounce). */
  hardBounce?: boolean;
  complainedAt?: Timestamp | FieldValue | null;
}

/**
 * `emailEvents/{resendEmailId}` — written by the send step when Resend (not
 * SMTP) accepted a broadcast email, in the transaction that stamps the id on
 * the row, so the events webhook resolves an event to its send row in one read. Server-only; pruned by api-cleanup after
 * `expiresAt`.
 */
export interface EmailEventLookupDoc {
  kind: "broadcast";
  broadcastId: string;
  contactId: string;
  subAccountId: string;
  agencyId: string;
  /** The address the step actually sent to (the live contact email, not the fan-out snapshot). */
  toEmail: string;
  sentAt: Timestamp | FieldValue | null;
  expiresAt: Timestamp | FieldValue | Date;
}

/**
 * `broadcasts/{broadcastId}/links/{linkKey}` — a click-tracked destination,
 * written by the send step before the email goes out. The `/t/c/` redirect
 * reads only this. `linkKey` is a hash of `url`. Server-only.
 */
export interface BroadcastLinkDoc {
  url: string;
  agencyId: string;
  subAccountId: string;
  createdAt: Timestamp | FieldValue | null;
}
