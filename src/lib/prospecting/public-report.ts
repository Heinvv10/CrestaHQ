import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { hashShareToken } from "@/lib/snapshots/share";
import { toIso } from "@/lib/prospecting/reports";
import { publicSection, type PublicReportSection } from "@/lib/prospecting/public-sections";
import type { AppTheme, ProspectSectionResult } from "@/types";

export type { PublicReportSection };

/**
 * Resolve a public report share token (`/report/[token]` and
 * `/api/public/prospecting/report/[token]`). Every refusal — unknown,
 * malformed, revoked, report gone, not ready, tenancy mismatch — is the same
 * `null`, so a caller learns nothing about which. The payload is built field
 * by field: nothing reaches the public that is not named here (sections via
 * `public-sections.ts`).
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface PublicReport {
  businessName: string | null;
  headline: string | null;
  generatedAt: string | null;
  sections: PublicReportSection[];
  agency: { name: string | null; logoUrl: string | null; appTheme: AppTheme | null };
  /** The sub-account's booking page path, or null when it has none published. */
  cta: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Oldest published booking page — deterministic, as there is no "default" page. */
async function bookingCta(subAccountId: string): Promise<string | null> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/bookingPages`)
    .where("status", "==", "published")
    .get();
  const ms = (v: unknown) => (toIso(v) ? Date.parse(toIso(v)!) : Number.MAX_SAFE_INTEGER);
  const first = snap.docs
    .map((d) => ({ id: d.id, at: ms(d.data()?.createdAt) }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0];
  return first ? `/b/${subAccountId}/${first.id}` : null;
}

export async function resolvePublicReport(token: string): Promise<PublicReport | null> {
  const db = getAdminDb();
  // Hash and read even for a malformed token, so it takes the same path.
  const shareSnap = await db.doc(`prospectReportShares/${hashShareToken(token)}`).get();
  const share = shareSnap.data();
  if (!TOKEN.test(token) || !share || share.revokedAt) return null;

  const report = (await db.doc(`prospectReports/${share.reportId}`).get()).data();
  if (
    !report ||
    report.status !== "ready" ||
    report.shareId !== shareSnap.id ||
    report.subAccountId !== share.subAccountId ||
    report.agencyId !== share.agencyId
  ) {
    return null;
  }

  const [agencySnap, contactSnap, cta] = await Promise.all([
    db.doc(`agencies/${report.agencyId}`).get(),
    db.doc(`contacts/${report.contactId}`).get(),
    bookingCta(report.subAccountId),
  ]);
  const agency = agencySnap.data() ?? {};
  const contact = contactSnap.data();
  const ownContact = contact?.subAccountId === report.subAccountId ? contact : undefined;
  const logoUrl = str(agency.logoUrl);

  return {
    businessName: str(ownContact?.company) ?? str(ownContact?.name),
    headline: str(report.headline),
    generatedAt: toIso(report.generatedAt),
    sections: ((report.sections ?? []) as ProspectSectionResult[]).map(publicSection),
    agency: {
      name: str(agency.name),
      logoUrl: logoUrl && /^https:\/\//i.test(logoUrl) ? logoUrl : null,
      appTheme: (str(agency.appTheme) as AppTheme | null) ?? null,
    },
    cta,
  };
}
