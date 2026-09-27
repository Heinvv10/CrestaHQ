import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { runProspectReport } from "@/lib/prospecting/report-runner";
import { prospectingEnabled } from "@/lib/prospecting/gate";
import { readApexgeoConnection } from "@/lib/prospecting/apexgeo-connection";
import { schedulePoll, settleApexgeo } from "@/lib/prospecting/apexgeo-report";
import { announceReadyReport } from "@/lib/prospecting/report-ready";
import { APEXGEO_REASON, apexgeoPlaceholders } from "@/lib/prospecting/apexgeo-sections";
import {
  INTERRUPTED_AFTER_MS,
  REPORT_ID,
  failAndRelease,
  reportInputOf,
} from "@/lib/prospecting/reports";

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
 * A process that dies mid-run (e.g. a blue/green cut-over) leaves the report
 * `running`. A delivery that finds it `running` within INTERRUPTED_AFTER_MS
 * answers 503 so QStash keeps retrying; once older, it settles it `failed`
 * ("interrupted") with the quota released. QStash's default schedule (3
 * retries, backoff ~12 s, ~2.5 min, ~30 min) puts the third retry well past
 * the window, and the list route sweeps anything stuck past STALE_AFTER_MS
 * regardless. The final write only lands on a report still `running`, so a
 * report settled meanwhile (swept, interrupted) keeps its state. A thrown error is
 * caught and settles the report `failed` with the quota released. A report
 * whose sub-account's Prospecting gate went off is not run, and released.
 *
 * When the runner started an ApexGEO scan, the ready write records it
 * (`apexgeo`, pending) and the first poll of `/api/automations/prospecting/apexgeo`
 * is queued after it. A poll that cannot be queued settles the three ApexGEO
 * sections `failed` at once, rather than leaving them "in progress".
 *
 * A ready report then gets its share link, is stamped on the contact and
 * fires `prospecting.report.ready` (lib/prospecting/report-ready.ts). The
 * claim above is what makes that once per report. A failed report fires nothing.
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
  if (!claimed) {
    const interrupted = await failAndRelease(
      reportId,
      { failureReason: "interrupted" },
      { olderThanMs: INTERRUPTED_AFTER_MS },
    );
    if (interrupted) return NextResponse.json({ ok: true, status: "failed" });
    if ((await reportRef.get()).data()?.status === "running") {
      // Possibly still running elsewhere, possibly killed: ask QStash to come back.
      return NextResponse.json({ error: "report_running" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, skipped: true });
  }

  try {
    const contactRef = db.doc(`contacts/${claimed.contactId}`);
    const [contact, sub] = await Promise.all([
      contactRef.get().then((s) => s.data()),
      db.doc(`subAccounts/${claimed.subAccountId}`).get().then((s) => s.data()),
    ]);
    if (!contact || contact.subAccountId !== claimed.subAccountId || !prospectingEnabled(sub ?? {})) {
      await failAndRelease(reportId);
      return NextResponse.json({ ok: true, status: "failed" });
    }

    const connection = await readApexgeoConnection(claimed.subAccountId);
    const outcome = await runProspectReport(reportInputOf(contact), { apexgeo: { connection, reportId } });
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
    const written = await db.runTransaction(async (tx) => {
      if ((await tx.get(reportRef)).data()?.status !== "running") return false;
      tx.update(reportRef, {
        ...result,
        status: "ready",
        apexgeo: outcome.apexgeo
          ? { scanId: outcome.apexgeo.scanId, status: "pending", attempts: 0, startedAt: new Date() }
          : null,
      });
      return true;
    });
    if (!written) {
      console.error("[prospecting/report] report settled during the run; result dropped", reportId);
      return NextResponse.json({ ok: true, status: "settled" });
    }
    // Before anything else can throw: a retry of this delivery finds the
    // report settled and skips, so an unqueued poll would never be queued.
    if (outcome.apexgeo && !(await schedulePoll(reportId, 0))) {
      console.error("[prospecting/report] ApexGEO poll not queued", reportId);
      await settleApexgeo(reportId, {
        sections: apexgeoPlaceholders("failed", APEXGEO_REASON.failed),
        status: "failed",
      });
    }
    // The report is settled: share link, contact stamp and the
    // prospecting.report.ready trigger. Never throws; failures are logged.
    await announceReadyReport({
      reportId,
      subAccountId: claimed.subAccountId,
      agencyId: claimed.agencyId,
      contactId: claimed.contactId,
      createdByUid: claimed.createdByUid,
      headline: outcome.headline,
    });
    return NextResponse.json({ ok: true, status: "ready" });
  } catch (err) {
    console.error("[prospecting/report] run failed", reportId, err);
    await failAndRelease(reportId).catch((e) =>
      console.error("[prospecting/report] release after failure failed", reportId, e),
    );
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
}
