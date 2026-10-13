/**
 * In-memory per-IP limit on Web Voice STARTS (each start mints a signed URL
 * on the client's ElevenLabs account). Best-effort across serverless
 * instances, same caveat as the web-chat message limiter — the durable
 * protection is the Firestore-backed daily minute cap + concurrency cap in
 * web-voice-usage.ts.
 */

const STARTS_PER_IP_PER_HOUR = 12;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 5000;

const buckets = new Map<string, { count: number; windowStartedAt: number }>();

export function checkVoiceStart(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const rec = buckets.get(ip);
  if (!rec || now - rec.windowStartedAt > WINDOW_MS) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(ip, { count: 1, windowStartedAt: now });
    return { ok: true };
  }
  if (rec.count >= STARTS_PER_IP_PER_HOUR) {
    return {
      ok: false,
      retryAfterSec: Math.ceil((rec.windowStartedAt + WINDOW_MS - now) / 1000),
    };
  }
  rec.count += 1;
  return { ok: true };
}

/**
 * Ours, not upstream: limits on `/voice/event`, which costs the client's
 * ElevenLabs key a lookup per `connected` ping. Per grant (a token's own
 * call needs a `connected` and an `ended`, plus a few resends) and per IP,
 * in memory like the start limit — best-effort across instances.
 */
const EVENTS_PER_GRANT = 6;
const EVENTS_PER_IP_PER_HOUR = 120;
const grantEvents = new Map<string, number>();
const ipEvents = new Map<string, { count: number; windowStartedAt: number }>();

export function checkVoiceEvent(ip: string, grantId: string): boolean {
  const now = Date.now();
  const used = grantEvents.get(grantId) ?? 0;
  if (used >= EVENTS_PER_GRANT) return false;
  let rec = ipEvents.get(ip);
  if (!rec || now - rec.windowStartedAt > WINDOW_MS) rec = { count: 0, windowStartedAt: now };
  if (rec.count >= EVENTS_PER_IP_PER_HOUR) return false;
  for (const map of [grantEvents, ipEvents] as Map<string, unknown>[]) {
    if (map.size >= MAX_TRACKED_IPS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  rec.count += 1;
  ipEvents.set(ip, rec);
  grantEvents.set(grantId, used + 1);
  return true;
}

/** At most one config-triggered usage sweep per sub-account per minute. */
const CONFIG_SWEEP_MS = 60 * 1000;
const configSweeps = new Map<string, number>();

export function claimConfigSweep(subAccountId: string): boolean {
  const now = Date.now();
  const last = configSweeps.get(subAccountId);
  if (last !== undefined && now - last < CONFIG_SWEEP_MS) return false;
  if (configSweeps.size >= MAX_TRACKED_IPS) {
    const oldest = configSweeps.keys().next().value;
    if (oldest !== undefined) configSweeps.delete(oldest);
  }
  configSweeps.set(subAccountId, now);
  return true;
}
