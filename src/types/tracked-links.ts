import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Tracked links — the GHL-equivalent "Trigger Link". An operator creates a
 * link with a destination; a per-contact token is minted when the link is
 * sent, and `/l/{token}` records the click, fires `link.clicked`, and 302s
 * to the destination.
 *
 * Tenancy: every link carries `agencyId / subAccountId / createdByUid`, the
 * same shape as `quotes` / `socialPosts`. Rules are member-read (the
 * workflow builder's link picker reads them from the browser) and
 * server-only write — clicks are counted by the public redirect route via
 * the Admin SDK, so a browser must never be able to assert one.
 *
 * `mode` mirrors the public API's live/test wall: links created through
 * `/api/v1/links` inherit the key's mode, dashboard-created links are
 * always `live`. A click on a test-mode link is recorded but fires no
 * workflow — a sandbox call must never message a real person.
 */

export interface TrackedLink {
  id: string;

  // ── Tenancy ───────────────────────────────────────────────────────
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  mode: "live" | "test";

  /** Operator-facing label, e.g. "Audit — EDC Engineers". */
  name: string;
  /** Absolute http(s) URL. Validated at write time — never trusted on read. */
  destinationUrl: string;

  // ── Click stats ──────────────────────────────────────────────────
  clickCount: number;
  lastClickedAt: Timestamp | FieldValue | null;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/**
 * `trackedLinks/{linkId}/recipients/{contactId}` — one row per contact the
 * link was minted for. The doc id IS the contact id, so minting twice for
 * the same contact is idempotent.
 */
export interface TrackedLinkRecipient {
  /** Per-recipient destination override. Null = use the link's destination.
   *  This is what carries a campaign's one-report-per-prospect URLs. */
  destinationUrl: string | null;
  clickCount: number;
  firstClickedAt: Timestamp | FieldValue | null;
  lastClickedAt: Timestamp | FieldValue | null;
  createdAt: Timestamp | FieldValue | null;
}

/** `trackedLinks/{linkId}/clicks/{autoId}` — the raw click log. */
export interface TrackedLinkClick {
  /** Null for a tokenless `/l/{linkId}` click — attributed to the link only. */
  contactId: string | null;
  clickedAt: Timestamp | FieldValue | null;
  userAgent: string | null;
  referer: string | null;
}

/** Fields the create routes fill in beyond tenancy + name + destination. */
export const DEFAULT_TRACKED_LINK: Pick<
  TrackedLink,
  "clickCount" | "lastClickedAt"
> = {
  clickCount: 0,
  lastClickedAt: null,
};
