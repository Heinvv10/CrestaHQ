import type { Timestamp, FieldValue } from "firebase/firestore";
import type { ActivityType } from "@/types/contacts";

export type ActivityMeta = {
  dealId?: string;
  fromStageId?: string;
  toStageId?: string;
  bookingId?: string;
  /** Quote lifecycle rows (sent / viewed / accepted / declined / paid)
   *  carry the source quote's id + human-readable number. Written by
   *  src/lib/quotes/lifecycle.ts so the timeline can surface a "View
   *  quote" link in v2 polish. */
  quoteId?: string;
  quoteNumber?: string;
  /** Territory retag rows. `null` id resolves to "Global". Cascade
   *  counts (how many child records moved) sit alongside so the
   *  timeline can read "Account moved from California to Utah (3
   *  deals, 1 quote)" without re-querying. */
  fromTerritoryId?: string | null;
  toTerritoryId?: string | null;
  movedDeals?: number;
  movedQuotes?: number;
  movedTasks?: number;
  movedEvents?: number;
  /** Booking lifecycle rows carry the source event + booking page slug
   *  so the timeline can deep-link to the calendar event + the page
   *  that produced it. `paymentAmount` / `paymentCurrency` populate on
   *  `booking_payment_received` so the row reads as
   *  "Payment received: $150 AUD". */
  eventId?: string;
  bookingPageSlug?: string;
  paymentAmount?: number;
  paymentCurrency?: string;
  /** Follow-up task minted alongside this row (watchdog, captures). */
  taskId?: string;
  /** `task_created` rows: the task's due date as ISO, or null. */
  dueAt?: string | null;
  /** `*_received` rows: the persisted message row's id + its channel. */
  messageId?: string;
  channel?: "sms" | "whatsapp" | "email" | "messenger" | "instagram" | "webchat";
  /** Rows written by the workflow engine carry the run they belong to so
   *  the timeline can link to the workflow's run history. */
  workflowId?: string;
  runId?: string;
  /** Bulk-email send rows carry the parent broadcast for deep-linking. */
  broadcastId?: string;
  /** Webinar1 rows (`webinar_*`) carry the source webinar + registration so
   *  the timeline can name the webinar and link its public page. */
  webinarId?: string;
  webinarSlug?: string;
  webinarRegistrationId?: string;
  /** `webinar_completed` rows: high-water watch percentage at completion. */
  webinarWatchPercent?: number;
  /** `call_placed` rows: the Twilio recording of a dialer call, when the
   *  sub-account records calls. UNTRUSTED like the rest of `meta` — link it
   *  only through `ownRecordingUrl` (lib/comms/dialer-shared.ts). */
  recordingUrl?: string;
} | null;

export interface ActivityDoc {
  id: string;
  type: ActivityType;
  content: string;
  createdBy: string;
  createdAt: Timestamp | FieldValue | null;
  meta: ActivityMeta;
}
