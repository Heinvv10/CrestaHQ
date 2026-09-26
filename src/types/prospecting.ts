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
 * Report section keys (docs/programme/prospecting-module.md, "Report
 * sections"). PR 2 runs business_details, gbp, reputation, listings,
 * tech_stack, ads, lead_capture. website_performance, ai_readiness and
 * ai_presence are ApexGEO sections (PR 3); only their keys exist here.
 */
export type ProspectSectionKey =
  | "business_details"
  | "gbp"
  | "reputation"
  | "listings"
  | "website_performance"
  | "tech_stack"
  | "ai_readiness"
  | "ai_presence"
  | "ads"
  | "lead_capture";

/**
 * `ok` = measured. `failed` = the section threw. `timeout` = it ran past its
 * budget. `unavailable` = it cannot be measured honestly (no source, no
 * website) — never a guessed negative.
 */
export type ProspectSectionStatus = "ok" | "failed" | "unavailable" | "timeout";

/** Finding codes, ranked for the report headline by `severity.ts`. */
export type ProspectFindingCode =
  | "no_website"
  | "no_https"
  | "not_in_ai_answers"
  | "gbp_unclaimed"
  | "slow_mobile"
  | "no_whatsapp_cta"
  | "no_reviews"
  | "low_rating"
  | "few_reviews"
  | "no_booking"
  | "no_contact_form"
  | "no_phone_link"
  | "gbp_no_hours"
  | "gbp_no_photos"
  | "gbp_no_description"
  | "gbp_no_phone"
  | "listing_missing"
  | "no_analytics"
  | "no_chat_widget"
  | "no_ads_running";

export interface ProspectFinding {
  code: ProspectFindingCode;
  /** Sentence shown on the report; the top-ranked one is the headline. */
  text: string;
}

export interface ProspectSectionResult {
  key: ProspectSectionKey;
  status: ProspectSectionStatus;
  /** 0–100, null when the section did not measure (status ≠ ok). */
  score: number | null;
  findings: ProspectFinding[];
  /** Why the section is failed/unavailable/timeout, for the report page. */
  reason?: string | null;
  /** Section-specific measured values, rendered by the report page. */
  raw: Record<string, unknown>;
}

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
  sections: ProspectSectionResult[];
  headline: string | null;
  /** sha256 of the live share token (`prospectReportShares` doc id), or null. */
  shareId: string | null;
  generatedAt: Timestamp | FieldValue | null;
  createdAt?: Timestamp | FieldValue | null;
  /** `usage/{YYYY-MM}` month the report was charged to (quota release on failure). */
  usageMonth?: string;
  /** Provider calls made, per provider (e.g. `{ placesDetails: 1, http: 9 }`). */
  cost?: Record<string, number>;
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

/**
 * What the report runner knows about the business: the contact's stored
 * facts and its `prospecting` map. No Text Search is made by the runner.
 */
export interface ProspectReportInput {
  name: string;
  phone: string | null;
  address: string | null;
  website: string | null;
  placeId: string | null;
  rating: number | null;
  reviewsCount: number | null;
  category: string | null;
  /** Town/city, used by listing searches when known. */
  city: string | null;
}

/** What `runProspectReport` hands back to the QStash callback. Never throws. */
export interface ProspectReportOutcome {
  status: "ready" | "failed";
  sections: ProspectSectionResult[];
  headline: string | null;
  cost: Record<string, number>;
}
