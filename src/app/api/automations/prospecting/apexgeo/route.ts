import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyQStashSignature } from "@/lib/automations/qstash";
import { prospectingEnabled } from "@/lib/prospecting/gate";
import { REPORT_ID } from "@/lib/prospecting/reports";
import { getScan } from "@/lib/prospecting/apexgeo-client";
import { readApexgeoConnection } from "@/lib/prospecting/apexgeo-connection";
import {
  APEXGEO_POLL_PATH,
  POLL_DELAYS_S,
  advancePoll,
  isPendingAt,
  schedulePoll,
  settleApexgeo,
} from "@/lib/prospecting/apexgeo-report";
import { APEXGEO_REASON, apexgeoFromScan, apexgeoPlaceholders } from "@/lib/prospecting/apexgeo-sections";

/**
 * ApexGEO poll worker (Prospecting PR 3, decision D1) — one QStash message
 * per poll, `{ reportId, attempt }`, first queued by the report worker.
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. Each poll re-reads the gate and the key: a gate turned off
 * or a key removed mid-scan stops the chain and says so on the report.
 *
 *   completed → sections 5/7/8 filled, headline recomputed, `done`
 *   queued/running → the next poll is queued (longer delay), then `attempts`
 *     advances; the last attempt instead settles the sections `timeout`
 *   a transient ApexGEO error (network, 429, 5xx) → treated like running:
 *     the scan is charged and still finishing, so the next poll retries it
 *   failed, or any other ApexGEO error → sections `failed` with a generic
 *     reason (the real one is logged)
 *
 * Every settle is a transaction that lands only on a report still `ready`
 * whose scan is `pending` at this poll's attempt, so a replay, a duplicate
 * delivery or a stale poll is a 200 no-op and two concurrent deliveries fill
 * once. The next poll is queued BEFORE `attempts` advances, under a dedup id
 * per attempt: a crash in between is retried by QStash and republishes the
 * same message, never a second chain. A publish that fails answers 503 so
 * QStash retries this poll.
 */

export const dynamic = "force-dynamic";

/** Errors that say nothing about the scan itself: poll again. */
const TRANSIENT: ReadonlySet<string> = new Set(["network", "rate_limited", "server"]);

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${APEXGEO_POLL_PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { reportId?: unknown; attempt?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { reportId, attempt } = body;
  if (
    typeof reportId !== "string" ||
    !REPORT_ID.test(reportId) ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    attempt >= POLL_DELAYS_S.length
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    const report = (await db.doc(`prospectReports/${reportId}`).get()).data();
    if (!isPendingAt(report, attempt)) return NextResponse.json({ ok: true, skipped: true });
    const subAccountId = report!.subAccountId as string;

    // A settle that lost its race to another delivery answers "skipped".
    const settled = (written: boolean, status: string) =>
      NextResponse.json(written ? { ok: true, status } : { ok: true, skipped: true });
    const stop = async (code: "gate_off" | "not_connected", reason: string) =>
      settled(
        await settleApexgeo(reportId, { attempt, sections: apexgeoPlaceholders(code, reason), status: "stopped" }),
        "stopped",
      );
    const sub = (await db.doc(`subAccounts/${subAccountId}`).get()).data();
    if (!prospectingEnabled(sub ?? {})) return stop("gate_off", APEXGEO_REASON.gate_off);
    const connection = await readApexgeoConnection(subAccountId);
    if (!connection) return stop("not_connected", "ApexGEO was disconnected before the scan finished.");

    const res = await getScan(connection, report!.apexgeo.scanId as string);
    const failed = async (why: unknown) => {
      console.error("[prospecting/apexgeo] scan failed", reportId, why);
      const written = await settleApexgeo(reportId, {
        attempt,
        sections: apexgeoPlaceholders("failed", APEXGEO_REASON.failed),
        status: "failed",
      });
      return settled(written, "failed");
    };
    if (!res.ok && !TRANSIENT.has(res.error.kind)) return failed(res.error);
    const scan = res.ok ? res.scan : null;
    if (!res.ok) console.warn("[prospecting/apexgeo] poll error, will retry", reportId, res.error);

    if (scan?.status === "completed") {
      const written = await settleApexgeo(reportId, {
        attempt,
        sections: apexgeoFromScan(scan),
        status: "done",
        credits: scan.credits_charged,
      });
      return settled(written, "done");
    }
    if (scan?.status === "failed") return failed({ scanStatus: "failed", error: scan.error });

    const next = attempt + 1;
    if (next >= POLL_DELAYS_S.length) {
      const written = await settleApexgeo(reportId, {
        attempt,
        sections: apexgeoPlaceholders("timeout", APEXGEO_REASON.timeout),
        status: "timeout",
      });
      return settled(written, "timeout");
    }
    if (!(await schedulePoll(reportId, next))) {
      return NextResponse.json({ error: "poll_not_queued" }, { status: 503 });
    }
    return settled(await advancePoll(reportId, attempt), "polling");
  } catch (err) {
    console.error("[prospecting/apexgeo] poll failed", reportId, err);
    return NextResponse.json({ error: "poll_failed" }, { status: 500 });
  }
}
