import "server-only";

import { NextResponse } from "next/server";

import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { recheckStaleAutoCharges } from "@/lib/server/auto-charge-stale-sweep";
import { runRecurringInvoiceSweep } from "@/lib/server/recurring-invoice-service";

/**
 * Daily sweep that raises every recurring invoice that has come due.
 *
 * Public path — the QStash signature is the authentication, as it is for every
 * other cron route here. The schedule itself is auto-registered on cold start
 * (`register-schedules.ts`), so a buyer never clicks into the QStash dashboard.
 *
 * A batch cap plus self-continuation keeps one invocation well under the
 * serverless timeout; the same shape `api-cleanup` uses. The continuation
 * matters more here than there, because the work being deferred is a customer
 * not being invoiced today.
 */

const CONTINUATION_DELAY_SEC = 60;

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await runRecurringInvoiceSweep();
  } catch (err) {
    // 500 so QStash retries. Every schedule claims its own cycle in a
    // transaction before any work, so a retry re-runs only what never ran.
    console.error("[cron/recurring-invoices] sweep failed", err);
    return NextResponse.json(
      {
        error: "sweep_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 },
    );
  }

  let continued = false;
  if (result.hasMore) {
    continued = await publishCallback({
      pathname: "/api/cron/recurring-invoices",
      body: {},
      delaySeconds: CONTINUATION_DELAY_SEC,
      // Minute-bucketed so several continuations in one minute collapse,
      // while a healthy run can still schedule its next.
      deduplicationId: `recurring-invoices_continuation_${Math.floor(
        Date.now() / 1000 / 60,
      )}`,
    })
      .then(() => true)
      .catch((err) => {
        // A dropped continuation delays the remaining schedules to tomorrow's
        // sweep; it must not fail the invoices already raised this run.
        console.error("[cron/recurring-invoices] continuation failed", err);
        return false;
      });
  }

  // Card charges still unconfirmed: once, on the final page (or this one,
  // if no continuation could be queued), and never failing the sweep.
  let staleCharges = null;
  if (!continued) {
    try {
      staleCharges = await recheckStaleAutoCharges(new Date());
    } catch (err) {
      console.error("[cron/recurring-invoices] stale card-charge re-check failed", err);
    }
  }

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    ...result,
    continuationScheduled: result.hasMore,
    staleCharges,
  });
}
