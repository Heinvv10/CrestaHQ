import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runProspectReport } from "@/lib/prospecting/report-runner";
import { REPORT_ID, failAndRelease, reportInputOf } from "@/lib/prospecting/reports";

/**
 * Prospect report worker — one QStash message per report, published by
 * `POST /api/sub-accounts/[id]/prospecting/reports` with `{ reportId }`.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. The quota was charged when the report was requested; this
 * worker never charges. It claims the report `queued → running` in a
 * transaction, so a QStash retry or duplicate delivery of a report that is
 * running or settled is a 200 no-op: the runner runs at most once per report.
 *
 * Known gap: if the process dies mid-run the report stays `running` and its
 * quota stays charged — nothing sweeps it. A thrown error (not a crash) is
 * caught and settles the report `failed` with the quota released.
 */

export const dynamic = "force-dynamic";

const PATH = "/api/automations/prospecting/report";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let reportId: unknown;
  try {
    reportId = (JSON.parse(rawBody) as { reportId?: unknown }).reportId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof reportId !== "string" || !REPORT_ID.test(reportId)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const db = getAdminDb();
  const reportRef = db.doc(`prospectReports/${reportId}`);
  const claimed = await db.runTransaction(async (tx) => {
    const report = (await tx.get(reportRef)).data();
    if (!report || report.status !== "queued") return null;
    tx.update(reportRef, { status: "running", startedAt: FieldValue.serverTimestamp() });
    return report;
  });
  if (!claimed) return NextResponse.json({ ok: true, skipped: true });

  try {
    const contactRef = db.doc(`contacts/${claimed.contactId}`);
    const contact = (await contactRef.get()).data();
    if (!contact || contact.subAccountId !== claimed.subAccountId) {
      await failAndRelease(reportId);
      return NextResponse.json({ ok: true, status: "failed" });
    }

    const outcome = await runProspectReport(reportInputOf(contact));
    const result = {
      sections: outcome.sections,
      headline: outcome.headline,
      cost: outcome.cost,
      generatedAt: FieldValue.serverTimestamp(),
    };
    if (outcome.status === "failed") {
      // A report that produced nothing is not charged: release its quota.
      await failAndRelease(reportId, result);
      return NextResponse.json({ ok: true, status: "failed" });
    }
    await reportRef.update({ ...result, status: "ready" });
    await contactRef.update({ "prospecting.lastReportId": reportId });
    return NextResponse.json({ ok: true, status: "ready" });
  } catch (err) {
    console.error("[prospecting/report] run failed", reportId, err);
    await failAndRelease(reportId).catch((e) =>
      console.error("[prospecting/report] release after failure failed", reportId, e),
    );
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
}
