import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { prospectingEnabled, prospectingGateOff } from "@/lib/prospecting/gate";
import { usageMonthKey } from "@/lib/server/usage-meter";
import { REPORT_DEADLINE_MS } from "@/lib/prospecting/report-runner";
import { MEMBER_RAW_KEYS, publicSection } from "@/lib/prospecting/public-sections";
import { displaySections } from "@/lib/prospecting/apexgeo-sections";
import type {
  ContactProspecting,
  ProspectReportInput,
  ProspectSectionResult,
  SubAccountDoc,
} from "@/types";

/**
 * Prospect reports: quota reservation, failure release, and the member view.
 *
 * The monthly quota lives on the usage ledger (`subAccounts/{id}/usage/{month}`,
 * field `prospectReports`). A report is charged when it is REQUESTED — the
 * counter increment and the report doc are one transaction, so concurrent
 * requests cannot overshoot and a request that fails writes neither. A report
 * that produced nothing (queue unavailable, runner failed) is released again.
 */

export const REPORT_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * A `running` report older than this was interrupted: the process died (e.g.
 * a blue/green cut-over's 60 s drain is shorter than the 100 s deadline) and
 * QStash's retry of a `running` report is otherwise a no-op.
 */
export const INTERRUPTED_AFTER_MS = REPORT_DEADLINE_MS + 60_000;

/** A queued/running report this old is swept `failed` by the list route. */
export const STALE_AFTER_MS = 10 * 60_000;

const IN_PROGRESS = new Set(["queued", "running"]);

type Access = { uid: string; agencyId: string; sub: SubAccountDoc };

/** Member (or agency owner) of the sub-account, with the Prospecting gate on. */
export async function prospectingAccess(
  request: Request,
  subAccountId: string,
): Promise<Access | NextResponse> {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = (snap.data() ?? {}) as SubAccountDoc;
  if (!prospectingEnabled(sub)) return prospectingGateOff();
  return { uid: access.uid, agencyId: sub.agencyId, sub };
}

const usedOf = (data: FirebaseFirestore.DocumentData | undefined): number =>
  (data?.prospectReports as number | undefined) ?? 0;

export async function reportsUsed(subAccountId: string): Promise<number> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/usage/${usageMonthKey()}`).get();
  return usedOf(snap.data());
}

/**
 * Charge one report against the month and create it `queued`, atomically.
 * Refuses while the contact already has a queued/running report. Throws on
 * any Firestore error — the caller fails closed.
 *
 * The in-progress check is a query inside the transaction. Every reservation
 * also reads then writes the month's usage doc, so two concurrent ones
 * conflict on it and the retry sees the other's report; the one gap is two
 * reservations for one contact straddling a month boundary.
 */
export async function reserveReport(input: {
  agencyId: string;
  subAccountId: string;
  uid: string;
  contactId: string;
  quota: number;
}): Promise<{ reportId: string } | "quota_exhausted" | "report_in_progress"> {
  const db = getAdminDb();
  const usageMonth = usageMonthKey();
  const usageRef = db.doc(`subAccounts/${input.subAccountId}/usage/${usageMonth}`);
  const reportRef = db.collection("prospectReports").doc();
  const contactReports = db
    .collection("prospectReports")
    .where("subAccountId", "==", input.subAccountId)
    .where("contactId", "==", input.contactId);
  return db.runTransaction(async (tx) => {
    const used = usedOf((await tx.get(usageRef)).data());
    const existing = await tx.get(contactReports);
    if (existing.docs.some((d) => IN_PROGRESS.has(d.data()?.status))) return "report_in_progress" as const;
    if (used >= input.quota) return "quota_exhausted" as const;
    tx.set(usageRef, { prospectReports: FieldValue.increment(1) }, { merge: true });
    tx.create(reportRef, {
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: input.uid,
      contactId: input.contactId,
      status: "queued",
      sections: [],
      headline: null,
      shareId: null,
      generatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      usageMonth,
    });
    return { reportId: reportRef.id };
  });
}

/** Milliseconds since the report last moved (claimed, else created); null if unknown. */
export function reportAgeMs(report: FirebaseFirestore.DocumentData, now = Date.now()): number | null {
  const at = toIso(report.startedAt) ?? toIso(report.createdAt);
  return at ? now - Date.parse(at) : null;
}

/**
 * Mark a queued/running report `failed` (with `patch`) and give its quota back
 * — a report that produced nothing is not charged. A report already settled is
 * left alone, so a repeat call cannot release twice. Floors the counter at 0.
 * With `olderThanMs`, only a report that has not moved for that long (checked
 * inside the transaction, so a report claimed meanwhile is left alone).
 */
export async function failAndRelease(
  reportId: string,
  patch: Record<string, unknown> = {},
  opts: { olderThanMs?: number } = {},
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`prospectReports/${reportId}`);
  return db.runTransaction(async (tx) => {
    const report = (await tx.get(ref)).data();
    if (!report || !IN_PROGRESS.has(report.status)) return false;
    if (opts.olderThanMs !== undefined) {
      const age = reportAgeMs(report);
      if (age === null || age <= opts.olderThanMs) return false;
    }
    const usageRef = db.doc(`subAccounts/${report.subAccountId}/usage/${report.usageMonth}`);
    const used = usedOf((await tx.get(usageRef)).data());
    tx.update(ref, { ...patch, status: "failed" });
    if (typeof report.usageMonth === "string" && used > 0) {
      tx.set(usageRef, { prospectReports: used - 1 }, { merge: true });
    }
    return true;
  });
}

/** What the runner knows about the business, from the contact doc alone. */
export function reportInputOf(contact: FirebaseFirestore.DocumentData): ProspectReportInput {
  const p = (contact.prospecting ?? {}) as ContactProspecting;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    // Get Leads imports set company = the business name; fall back to name.
    name: str(contact.company) ?? str(contact.name) ?? "",
    phone: str(contact.phone),
    address: str(contact.address),
    website: str(p.website),
    placeId: str(p.placeId),
    rating: num(p.rating),
    reviewsCount: num(p.reviewsCount),
    category: str(p.category),
    city: str(contact.city),
    countryCode: typeof contact.countryCode === "string" && /^[A-Za-z]{2}$/.test(contact.countryCode)
      ? contact.countryCode.toUpperCase()
      : null,
  };
}

export function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  const ts = v as { toDate?: () => Date } | null;
  return typeof ts?.toDate === "function" ? ts.toDate().toISOString() : null;
}

/**
 * The member view of a report: timestamps ISO-ified, sections through the
 * member whitelist (the public keys plus the models asked; no `raw`), with the
 * business name kept. Unlike the public page it keeps the not-measured,
 * could-not-check and manual-check rows and the ads section (C6).
 */
export function serializeReport(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    contactId: d.contactId as string,
    createdByUid: d.createdByUid as string,
    status: d.status as string,
    sections: displaySections((d.sections ?? []) as ProspectSectionResult[], d.apexgeo).map((s) =>
      publicSection(s, { showName: true, keys: MEMBER_RAW_KEYS }),
    ),
    headline: (d.headline ?? null) as string | null,
    shared: typeof d.shareId === "string",
    cost: (d.cost ?? {}) as Record<string, number>,
    usageMonth: (d.usageMonth ?? null) as string | null,
    createdAt: toIso(d.createdAt),
    startedAt: toIso(d.startedAt),
    generatedAt: toIso(d.generatedAt),
  };
}
