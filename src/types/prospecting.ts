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
 * A sub-account's overrides of the neutral mystery-shop enquiry
 * (lib/prospecting/mystery-shop/enquiry.ts). `{service}`, `{town}` and
 * `{business}` are filled in per contact. Unset fields use the defaults.
 */
export interface MysteryShopTemplates {
  emailSubject?: string;
  emailBody?: string;
  call?: string;
  /** The website form's message; unset = the email body. */
  form?: string;
}

/**
 * Report section keys (docs/programme/prospecting-module.md, "Report
 * sections"). The runner measures business_details, gbp, reputation,
 * listings, tech_stack, ads, lead_capture. website_performance, ai_readiness
 * and ai_presence come from one ApexGEO scan, filled in after the report is
 * ready (PR 3, `ProspectReportDoc.apexgeo`).
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
  | "no_ads_running"
  | "ai_crawlers_blocked"
  | "no_local_business_schema"
  | "no_mobile_viewport"
  | "lcp_needs_improvement"
  | "ai_mentions_partial"
  | "rating_under_4_8"
  | "reviews_under_50";

export interface ProspectFinding {
  code: ProspectFindingCode;
  /** Sentence shown on the report; the top-ranked one is the headline. */
  text: string;
  /**
   * What the finding costs the business, and the call-to-action line tied to
   * it. Written by the scorer (`sections/findings.ts`); absent on reports
   * scored before R0.
   */
  impact?: string;
  cta?: string;
}

export interface ProspectSectionResult {
  key: ProspectSectionKey;
  status: ProspectSectionStatus;
  /**
   * 0–100, 100 minus the findings' deductions (`sections/findings.ts`). Null
   * when the section did not measure (status ≠ ok), or measured but cannot
   * deduct reliably (listings; see `sections/listings.ts`).
   */
  score: number | null;
  findings: ProspectFinding[];
  /** Why the section is failed/unavailable/timeout, for the report page. */
  reason?: string | null;
  /** Section-specific measured values, rendered by the report page. */
  raw: Record<string, unknown>;
  /**
   * ApexGEO sections only: why the section is not (yet) measured, in a form
   * code can act on. `not_connected` sections are hidden on the public page.
   */
  reasonCode?: ApexgeoReasonCode;
}

export type ApexgeoReasonCode =
  | "not_connected"
  | "pending"
  | "missing_input"
  | "out_of_credits"
  | "timeout"
  | "failed"
  | "gate_off";

/**
 * `prospectReports/{id}.apexgeo` — the report's ApexGEO scan (PR 3). Written
 * by the report worker when the scan starts; settled by the ApexGEO poll
 * worker. `attempts` counts polls made, and each poll message carries the
 * number it expects, so a duplicate delivery cannot start a second chain.
 */
export interface ProspectReportApexgeo {
  scanId: string;
  status: "pending" | "done" | "failed" | "timeout" | "stopped";
  attempts: number;
  startedAt: Timestamp | FieldValue | Date | null;
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
  /** The ApexGEO scan behind sections 5/7/8; absent when none was started. */
  apexgeo?: ProspectReportApexgeo | null;
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
  /** The workflow whose send stamped `approachedAt` — the campaign key. */
  approachedWorkflowId?: string | null;
  /** Headline of the latest ready report, for `{{prospecting.headline}}`. */
  lastReportHeadline?: string | null;
  /** Share link to the latest ready report, for `{{prospecting.reportUrl}}`. */
  lastReportUrl?: string | null;
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
  /** ISO country code from the contact, when known (ApexGEO scans default to ZA). */
  countryCode: string | null;
}

/** What `runProspectReport` hands back to the QStash callback. Never throws. */
export interface ProspectReportOutcome {
  status: "ready" | "failed";
  sections: ProspectSectionResult[];
  headline: string | null;
  cost: Record<string, number>;
  /** Set when an ApexGEO scan was started for this report. */
  apexgeo: { scanId: string } | null;
}
