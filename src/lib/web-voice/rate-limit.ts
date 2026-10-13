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
