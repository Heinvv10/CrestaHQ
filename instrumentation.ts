/**
 * Next.js instrumentation hook — runs once per server cold start. We use
 * it to fire a single liveness ping to gitpage so the upstream team knows
 * this deployment is alive, and so the website-builder UI gets the
 * agency-subscription status cached for its first render.
 *
 * Only runs on the Node.js runtime — the heartbeat depends on
 * firebase-admin, which can't run on the Edge runtime where the
 * middleware lives.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Install API-key log redaction BEFORE anything else writes a log line.
  // Idempotent — safe to call on every cold start. Patches console.* so
  // any `lsk_<live|test>_*` token in any future log call gets its secret
  // half masked out.
  const { installLogRedaction } = await import("./src/lib/api/redact");
  installLogRedaction();

  // Auto-register the LeadStack daily cron schedules in QStash. Lets
  // buyers skip the "click into QStash dashboard, create schedules"
  // onboarding step — the schedules appear on the first production
  // cold start after env vars are set. Idempotent via stable
  // scheduleIds + cached for 24h via a Firestore marker doc.
  const { ensureSchedulesRegistered } = await import(
    "./src/lib/qstash/register-schedules"
  );

  // Defer the import so Edge bundles never see firebase-admin.
  const { sendHeartbeat } = await import("./src/lib/gitpage/heartbeat");

  // AWAITED, not fire-and-forget: on serverless the instance is frozen the
  // moment the response is sent, so a floating promise here may never
  // settle — the schedules and the status cache then silently never write.
  // Run both concurrently so the cold-start cost is the slower of the two
  // (each has its own internal timeout), and swallow failures individually
  // so neither can block boot.
  await Promise.all([
    ensureSchedulesRegistered().catch((err) => {
      console.warn("[instrumentation] schedule registration failed", err);
    }),
    sendHeartbeat().catch((err) => {
      console.warn("[instrumentation] gitpage heartbeat threw", err);
    }),
  ]);
}
