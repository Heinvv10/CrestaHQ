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
 */

type Tenant = { reportId: string; subAccountId: string };

/** The public URL for a minted token — the one place `/report/{token}` is spelled. */
export function reportShareUrl(token: string): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return `${appUrl}/report/${token}`;
}

export async function mintReportShare(
  input: Tenant & { uid: string },
): Promise<{ token: string } | "not_found" | "not_ready"> {
  const db = getAdminDb();
  const reportRef = db.doc(`prospectReports/${input.reportId}`);
  const token = randomBytes(32).toString("base64url");
  const shareId = hashShareToken(token);
  return db.runTransaction(async (tx) => {
    const report = (await tx.get(reportRef)).data();
    if (!report || report.subAccountId !== input.subAccountId) return "not_found" as const;
    if (report.status !== "ready") return "not_ready" as const;
    const oldRef = typeof report.shareId === "string" ? db.doc(`prospectReportShares/${report.shareId}`) : null;
    const old = oldRef ? (await tx.get(oldRef)).data() : undefined;
    if (oldRef && old && !old.revokedAt) tx.update(oldRef, { revokedAt: FieldValue.serverTimestamp() });
    tx.create(db.doc(`prospectReportShares/${shareId}`), {
      agencyId: report.agencyId,
      subAccountId: report.subAccountId,
      createdByUid: input.uid,
      reportId: input.reportId,
      revokedAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(reportRef, { shareId });
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
    if (share && !share.revokedAt) tx.update(shareRef, { revokedAt: FieldValue.serverTimestamp() });
    tx.update(reportRef, { shareId: null });
    return true;
  });
}
