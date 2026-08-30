import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Web-push data model (PWA v1).
 *
 * Subscriptions are PER DEVICE/BROWSER and belong to a user, not a
 * sub-account: `users/{uid}/pushSubscriptions/{subId}` where the doc id is
 * the SHA-256 hex of the push endpoint (natural dedupe — re-subscribing
 * the same browser overwrites its own row). Created/updated server-side by
 * /api/push/subscriptions; self-read + self-delete via rules so the
 * settings UI can list and remove devices directly.
 *
 * Preferences are PER USER at `users/{uid}/settings/notifications` — one
 * doc, a `subAccounts` map of subAccountId → enabled. Semantics enforced
 * by the send helper (lib/push/send.ts):
 *   - explicit sub-account members: missing key = ON (opt-out)
 *   - agency owner without a membership row: missing key = OFF (opt-in —
 *     implicit-admin-everywhere would otherwise mean every event in every
 *     sub-account buzzes the owner's phone)
 */

export interface PushSubscriptionDoc {
  id: string;
  uid: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Rough device label for the settings device list. */
  userAgent: string | null;
  createdAt: Timestamp | FieldValue | null;
}

export interface NotificationPrefsDoc {
  subAccounts?: Record<string, boolean>;
  updatedAt?: Timestamp | FieldValue | null;
}
