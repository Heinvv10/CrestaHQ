import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { hashShareToken } from "@/lib/snapshots/share";

/**
 * Prospect report share links, on the snapshot-share pattern: the raw token
 * leaves exactly once (in the minted URL); only its sha256 is stored, as the
 * `prospectReportShares/{hash}` doc id and on `prospectReports.shareId`. A
 * report has at most one live share — minting again revokes the old one.
 *
 * While the report is its contact's `prospecting.lastReportId`, the contact's
 * `lastReportUrl` follows the live share in the same transaction: a re-mint
 * re-stamps it, a revoke clears it. The report announce (report-ready.ts) and
 * `{{prospecting.reportUrl}}` read it there, so outreach never sends a link
 * that no longer opens.
 */

type Tenant = { reportId: string; subAccountId: string };

/** The public URL for a minted token — the one place `/report/{token}` is spelled. */
export function reportShareUrl(token: string): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return `${appUrl}/report/${token}`;
}

/**
 * Write a new live share for the report inside `tx` (after all its reads).
 * Returns the raw token and its hash, the report's new `shareId`.
 */
export function createShare(
  tx: FirebaseFirestore.Transaction,
  report: FirebaseFirestore.DocumentData,
  reportId: string,
  uid: string,
): { token: string; shareId: string } {
  const token = randomBytes(32).toString("base64url");
  const shareId = hashShareToken(token);
  tx.create(getAdminDb().doc(`prospectReportShares/${shareId}`), {
    agencyId: report.agencyId,
    subAccountId: report.subAccountId,
    createdByUid: uid,
    reportId,
    revokedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { token, shareId };
}

/** The report's contact, when this report is its latest (`lastReportId`). */
async function contactOfLatest(tx: FirebaseFirestore.Transaction, report: FirebaseFirestore.DocumentData, reportId: string) {
  if (typeof report.contactId !== "string") return null;
  const ref = getAdminDb().doc(`contacts/${report.contactId}`);
  const contact = (await tx.get(ref)).data();
  return contact?.prospecting?.lastReportId === reportId ? ref : null;
}

export async function mintReportShare(
  input: Tenant & { uid: string },
): Promise<{ token: string } | "not_found" | "not_ready"> {
  const db = getAdminDb();
  const reportRef = db.doc(`prospectReports/${input.reportId}`);
  return db.runTransaction(async (tx) => {
    const report = (await tx.get(reportRef)).data();
    if (!report || report.subAccountId !== input.subAccountId) return "not_found" as const;
    if (report.status !== "ready") return "not_ready" as const;
    const oldRef = typeof report.shareId === "string" ? db.doc(`prospectReportShares/${report.shareId}`) : null;
    const old = oldRef ? (await tx.get(oldRef)).data() : undefined;
    const contactRef = await contactOfLatest(tx, report, input.reportId);
    if (oldRef && old && !old.revokedAt) tx.update(oldRef, { revokedAt: FieldValue.serverTimestamp() });
    const { token, shareId } = createShare(tx, report, input.reportId, input.uid);
    tx.update(reportRef, { shareId });
    if (contactRef) tx.update(contactRef, { "prospecting.lastReportUrl": reportShareUrl(token) });
    return { token };
  });
}

/** Revoke the report's live share, if any. False when the report is not this sub-account's. */
export async function revokeReportShare(input: Tenant): Promise<boolean> {
  const db = getAdminDb();
  const reportRef = db.doc(`prospectReports/${input.reportId}`);
  return db.runTransaction(async (tx) => {
    const report = (await tx.get(reportRef)).data();
    if (!report || report.subAccountId !== input.subAccountId) return false;
    if (typeof report.shareId !== "string") return true;
    const shareRef = db.doc(`prospectReportShares/${report.shareId}`);
    const share = (await tx.get(shareRef)).data();
    const contactRef = await contactOfLatest(tx, report, input.reportId);
    if (share && !share.revokedAt) tx.update(shareRef, { revokedAt: FieldValue.serverTimestamp() });
    tx.update(reportRef, { shareId: null });
    if (contactRef) tx.update(contactRef, { "prospecting.lastReportUrl": null });
    return true;
  });
}
