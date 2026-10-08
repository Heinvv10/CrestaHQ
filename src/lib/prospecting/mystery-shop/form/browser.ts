import "server-only";

import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

/**
 * The headless Chromium the form engine drives: playwright-core's own build,
 * installed by the deploy (`pnpm exec playwright-core install chromium`) into
 * the service user's ~/.cache/ms-playwright — the same cache CI's E2E uses.
 *
 * The launch is the network backstop: every request is answered by the
 * route in network.ts, and should one ever reach Chromium's own stack it
 * meets a proxy that does not exist (127.0.0.1:9, loopback included — Chrome
 * otherwise bypasses the proxy for localhost) instead of the internet. WebRTC
 * may not use UDP outside the proxy, QUIC is off, and background, prefetch
 * and component-update traffic is disabled.
 */

const DEAD_PROXY = "http://127.0.0.1:9";
export const LAUNCH_ARGS = [
  `--proxy-server=${DEAD_PROXY}`,
  "--proxy-bypass-list=<-loopback>",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--dns-prefetch-disable",
  "--disable-quic",
  "--no-pings",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=NetworkPrediction,InterestFeedContentSuggestions,MediaRouter,OptimizationHints,AutofillServerCommunication",
];

/** The same Chromium the health check looks for, launched headless. */
export function launchFormBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: LAUNCH_ARGS });
}

const HEALTH_TTL_MS = 5 * 60_000;
let health: { at: number; ok: boolean } | null = null;

/** Is the engine's Chromium on disk? Cached for 5 minutes. A launch can still fail (the job's `engine_failed`). */
export function formEngineAvailable(now = Date.now()): boolean {
  if (health && now - health.at < HEALTH_TTL_MS) return health.ok;
  let ok: boolean;
  try {
    ok = existsSync(chromium.executablePath());
  } catch (err) {
    console.error("[mystery-shop/form] chromium path lookup failed", err);
    ok = false;
  }
  health = { at: now, ok };
  return ok;
}

/** Test-only: forget the cached health. */
export function resetFormEngineHealth(): void {
  health = null;
}
