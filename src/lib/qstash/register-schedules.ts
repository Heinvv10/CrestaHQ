import "server-only";

import { Client } from "@upstash/qstash";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { gbpSyncScheduled } from "@/lib/gbp/sync/schedule";

/**
 * Auto-register the LeadStack daily cron schedules on cold start.
 *
 * Removes the manual "click into the QStash dashboard, create a
 * schedule" step from buyer onboarding. The buyer sets QStash env vars
 * and the schedules appear on the next cold start.
 *
 * Idempotent via stable `scheduleId`s — QStash treats a `create()` with
 * an existing id as a replace, so calling on every cold start is safe.
 *
 * Cost reduction:
 *   - A 24-hour Firestore marker (`system/scheduleRegistration`) caches
 *     "we registered already" so the steady-state cold start drops to a
 *     single Firestore read (~10ms) instead of 2 QStash API calls
 *     (~200ms). The marker also stores the `baseUrl` it registered
 *     against, so a redeploy that changes `NEXT_PUBLIC_APP_URL` blows
 *     the cache and re-registers immediately.
 *
 * Failure mode:
 *   - QStash down / network failure: log + skip. The next cold start
 *     retries. Schedules that already exist in QStash continue running.
 *   - Marker doc write fails: log + skip. Worst case we re-register on
 *     the next cold start instead of using the cache. No correctness
 *     impact.
 *
 * To add a new schedule: append to `SCHEDULES`. Stable scheduleId is
 * required (no random ids — that's how you end up with duplicates).
 */

interface ScheduleSpec {
  scheduleId: string;
  path: string;
  cron: string;
  description: string;
}

const SCHEDULES: ScheduleSpec[] = [
  {
    scheduleId: "leadstack-email-sync",
    path: "/api/cron/email-sync",
    cron: "*/15 * * * *",
    description: "Read-only mailbox sync for connected sub-accounts.",
  },
  {
    scheduleId: "leadstack-gitpage-heartbeat",
    path: "/api/cron/gitpage-heartbeat",
    cron: "0 3 * * *",
    description: "Daily gitpage telemetry + subscription status cache.",
  },
  {
    scheduleId: "leadstack-api-cleanup",
    path: "/api/cron/api-cleanup",
    cron: "0 4 * * *",
    description:
      "Daily sweep of expired apiRequestLogs / apiIdempotency / webhookEvents.",
  },
  {
    // Always on, unlike the GBP sync below: Google's 30-day storage limit
    // must not depend on whether the sync is scheduled. Firestore only.
    scheduleId: "leadstack-gbp-retention",
    path: "/api/cron/gbp-retention",
    cron: "30 4 * * *",
    description:
      "Daily GBP review-cache retention (Google's 30-day storage limit); no Google API calls.",
  },
  {
    scheduleId: "leadstack-recurring-invoices",
    path: "/api/cron/recurring-invoices",
    // 05:00 UTC — after api-cleanup, and early enough that a schedule due
    // today is raised on its own local day across most of the world.
    cron: "0 5 * * *",
    description:
      "Daily sweep raising every recurring invoice that has come due.",
  },
  {
    scheduleId: "leadstack-agents-watchdog",
    path: "/api/agents/watchdog/step",
    cron: "0 * * * *",
    description: "Hourly Inbox Follow-up Watchdog sweep (Labs custom agent).",
  },
  {
    scheduleId: "leadstack-whatsapp-quality",
    path: "/api/cron/whatsapp-quality",
    // :15 so it never lands on the same minute as the watchdog above.
    cron: "15 * * * *",
    description:
      "Hourly WhatsApp Cloud sender quality-rating poll; alerts on a drop from GREEN.",
  },
  {
    scheduleId: "leadstack-whatsapp-staging-cleanup",
    path: "/api/cron/whatsapp-staging-cleanup",
    cron: "45 4 * * *",
    description:
      "Daily delete of abandoned WhatsApp composer uploads (whatsapp-staging/ objects over an hour old).",
  },
  {
    scheduleId: "leadstack-ai-models",
    path: "/api/cron/ai-models",
    cron: "20 3 * * *",
    description:
      "Daily refresh of the cached OpenRouter model list (AI model allow-list).",
  },
  {
    scheduleId: "leadstack-prospect-announce",
    path: "/api/automations/prospecting/announce-sweep",
    // 96 messages a day per deployment (the QStash cap has been hit before).
    cron: "*/15 * * * *",
    description:
      "Prospect report announce sweep: times out lost ApexGEO polls and announces due reports.",
  },
];

const BASE_SCHEDULE_VERSION = "2026-09-28-prospect-announce";

/**
 * The Google Business Profile review sync is OPT-IN per deployment
 * (`GBP_SYNC_SCHEDULE_ENABLED=1`): creating a production schedule is an
 * owner decision, not a side effect of a deploy. The flag is folded into the
 * version so turning it on re-registers at the next cold start instead of
 * waiting out a fresh 24h marker. Turning it OFF does not delete a schedule
 * already in QStash: the cron route answers `not_scheduled` and does nothing
 * while the flag is off, so a leftover schedule is harmless (delete it in the
 * QStash console to stop the calls altogether).
 */
const GBP_SYNC_SCHEDULE: ScheduleSpec = {
  scheduleId: "leadstack-gbp-sync",
  path: "/api/cron/gbp-sync",
  cron: "0 */6 * * *",
  description: "6-hourly Google Business Profile review sync.",
};

function activeSchedules(): ScheduleSpec[] {
  return gbpSyncScheduled() ? [...SCHEDULES, GBP_SYNC_SCHEDULE] : SCHEDULES;
}

function scheduleVersion(): string {
  return gbpSyncScheduled() ? `${BASE_SCHEDULE_VERSION}+gbp-sync` : BASE_SCHEDULE_VERSION;
}
const MARKER_PATH = "system/scheduleRegistration";
const SKIP_AGE_MS = 24 * 60 * 60 * 1000;

function tsToDate(ts: Timestamp | Date | null | undefined): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof (ts as Timestamp).toDate === "function") {
    return (ts as Timestamp).toDate();
  }
  return null;
}

export async function ensureSchedulesRegistered(): Promise<void> {
  // Gate: no QStash credentials → nothing to register. Local dev without
  // a tunnel falls into this path; that's correct.
  if (!process.env.QSTASH_TOKEN) return;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!baseUrl) return;
  // Skip in non-production runtimes where re-registering across hot reloads
  // would just churn QStash. A local production build on a loopback URL never
  // gets here: instrumentation.ts skips it (QStash refuses loopback
  // destinations anyway), so test locally through a tunnel URL.
  if (process.env.NODE_ENV !== "production") return;

  const db = getAdminDb();
  const markerRef = db.doc(MARKER_PATH);

  // 24h cache check. Skip the QStash round-trip on hot cold-starts.
  try {
    const snap = await markerRef.get();
    if (snap.exists) {
      const data = snap.data() ?? {};
      const lastUrl = data.baseUrl as string | undefined;
      const lastAt = tsToDate(data.registeredAt);
      if (
        lastUrl === baseUrl &&
        data.scheduleVersion === scheduleVersion() &&
        lastAt &&
        Date.now() - lastAt.getTime() < SKIP_AGE_MS
      ) {
        return;
      }
    }
  } catch (err) {
    // Marker read failures aren't fatal — fall through and re-register.
    console.warn("[schedules] marker read failed; will re-register", err);
  }

  const client = new Client({
    token: process.env.QSTASH_TOKEN,
    ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
  });

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const s of activeSchedules()) {
    try {
      await client.schedules.create({
        scheduleId: s.scheduleId,
        destination: `${baseUrl}${s.path}`,
        cron: s.cron,
      });
      results.push({ id: s.scheduleId, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      console.warn(
        `[schedules] failed to register ${s.scheduleId}: ${message}`
      );
      results.push({ id: s.scheduleId, ok: false, error: message });
    }
  }

  // Update marker even on partial failure so cold starts don't pound
  // QStash. A 24-hour delay before the next attempt is acceptable — a
  // schedule that failed once isn't expected to succeed on the next cold
  // start a minute later.
  try {
    await markerRef.set(
      {
        baseUrl,
        scheduleVersion: scheduleVersion(),
        registeredAt: FieldValue.serverTimestamp(),
        scheduleIds: activeSchedules().map((s) => s.scheduleId),
        lastResults: results,
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("[schedules] marker write failed", err);
  }
}
