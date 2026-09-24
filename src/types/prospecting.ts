import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Prospecting module (docs/features/prospecting.md). Every doc carries the
 * tenancy keys; all writes are server-only (Admin SDK), members read.
 */

/** The Get Leads search a saved list came from. */
export interface ProspectListQuery {
  businessType: string;
  placeName: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

/** `prospectLists/{listId}` — one per Get Leads result set the operator saves. */
export interface ProspectListDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  name: string;
  query: ProspectListQuery;
  /** Businesses in the result set when it was saved. */
  count: number;
  createdAt: Timestamp | FieldValue | null;
}

export type ProspectReportStatus = "queued" | "running" | "ready" | "failed";

/**
 * `prospectReports/{reportId}` — one audit report for one prospect contact.
 * Type and rules only in PR 1; the runner (PR 2) is the only writer.
 */
export interface ProspectReportDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  status: ProspectReportStatus;
  /** Filled by the runner, one entry per report section. Empty until then. */
  sections: unknown[];
  headline: string | null;
  shareId: string | null;
  generatedAt: Timestamp | FieldValue | null;
}

/**
 * `prospectReportShares/{shareId}` — public share handle for a report. No
 * client may read or write it; the public report route resolves it server-side.
 */
export interface ProspectReportShareDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  reportId: string;
  revokedAt: Timestamp | FieldValue | null;
}

/** `contacts/{id}.prospecting` — the prospect facts a contact carries. */
export interface ContactProspecting {
  /** `prospectLists/{listId}` this contact was imported from. */
  listId?: string;
  /** Google Places id of the imported listing. */
  placeId?: string;
  website?: string;
  rating?: number;
  reviewsCount?: number;
  category?: string;
  /** Stamped by the approach guard (Prospecting PR 4). Null until then. */
  approachedAt?: Timestamp | FieldValue | null;
  /** Latest `prospectReports/{id}` for this contact (PR 2). Null until then. */
  lastReportId?: string | null;
}
