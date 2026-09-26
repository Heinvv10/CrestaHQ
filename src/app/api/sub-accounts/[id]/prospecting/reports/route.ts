import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import { prospectReportQuota } from "@/lib/prospecting/quota";
import {
  REPORT_ID,
  STALE_AFTER_MS,
  failAndRelease,
  prospectingAccess,
  reportAgeMs,
  reportsUsed,
  reserveReport,
  toIso,
} from "@/lib/prospecting/reports";

/**
 * Prospect reports for one contact.
 *
 *   GET  ?contactId= → that contact's reports (newest first) + `{ quota, used }`
 *        for this month, so the UI can disable Generate. A queued/running
 *        report older than STALE_AFTER_MS is settled `failed` (quota
 *        released) first, so a polling card always settles.
 *   POST `{ contactId }` → reserve one report against the monthly quota and
 *        queue it on QStash (`/api/automations/prospecting/report`). 202 `{ reportId }`;
 *        409 `report_in_progress` while the contact has a queued/running one.
 *
 * Any active member (or the agency owner); 403 `gate_off` while the gate is
 * off. A contact that is missing or belongs to another sub-account is the
 * same 404. The reservation fails CLOSED: any error is a 500 with no report.
 */

const CONTACT_NOT_FOUND = { error: "Contact not found" };

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const contactId = new URL(request.url).searchParams.get("contactId");
  if (!contactId || !REPORT_ID.test(contactId)) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  // Equality-only, sorted in memory: no composite index.
  const snap = await getAdminDb()
    .collection("prospectReports")
    .where("subAccountId", "==", subAccountId)
    .where("contactId", "==", contactId)
    .get();
  const swept = new Set<string>();
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    const age = reportAgeMs(data);
    if ((data.status !== "queued" && data.status !== "running") || age === null || age <= STALE_AFTER_MS) continue;
    const failed = await failAndRelease(d.id, { failureReason: "stale" }, { olderThanMs: STALE_AFTER_MS }).catch(
      (err) => {
        console.error("[prospecting/reports] stale sweep failed", d.id, err);
        return false;
      },
    );
    if (failed) swept.add(d.id);
  }
  const used = await reportsUsed(subAccountId);
  const reports = snap.docs
    .map((d) => {
      const data = d.data() ?? {};
      return {
        id: d.id,
        status: swept.has(d.id) ? "failed" : (data.status as string),
        headline: (data.headline ?? null) as string | null,
        shared: typeof data.shareId === "string",
        createdAt: toIso(data.createdAt),
        generatedAt: toIso(data.generatedAt),
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return NextResponse.json({ reports, quota: prospectReportQuota(access.sub), used });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await prospectingAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const contactId = body?.contactId;
  if (typeof contactId !== "string" || !REPORT_ID.test(contactId)) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const contact = await getAdminDb().doc(`contacts/${contactId}`).get();
  if (!contact.exists || contact.data()?.subAccountId !== subAccountId) {
    return NextResponse.json(CONTACT_NOT_FOUND, { status: 404 });
  }

  let reserved: Awaited<ReturnType<typeof reserveReport>>;
  try {
    reserved = await reserveReport({
      agencyId: access.agencyId,
      subAccountId,
      uid: access.uid,
      contactId,
      quota: prospectReportQuota(access.sub),
    });
  } catch (err) {
    console.error("[prospecting/reports] reservation failed", err);
    return NextResponse.json({ error: "Could not start the report. Try again." }, { status: 500 });
  }
  if (reserved === "report_in_progress") {
    return NextResponse.json(
      { error: "A report for this contact is already in progress.", code: "report_in_progress" },
      { status: 409 },
    );
  }
  if (reserved === "quota_exhausted") {
    return NextResponse.json(
      { error: "This month's report quota is used up.", code: "quota_exhausted" },
      { status: 429 },
    );
  }

  const { reportId } = reserved;
  const published = await publishCallback({
    pathname: "/api/automations/prospecting/report",
    body: { reportId },
    delaySeconds: 0,
    deduplicationId: `prospect_report_${reportId}`,
  }).catch(() => null);
  if (!published) {
    await failAndRelease(reportId).catch((err) =>
      console.error("[prospecting/reports] release after publish failure failed", reportId, err),
    );
    return NextResponse.json({ error: "The report queue is unavailable. Try again." }, { status: 503 });
  }
  return NextResponse.json({ reportId }, { status: 202 });
}
