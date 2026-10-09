import "server-only";

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

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
 *
 * Speculation rules (`<script type="speculationrules">` prefetch / prerender)
 * are fetched by the browser process, outside the route — no launch flag
 * stops them in this build, but the "Preload pages: never" preference does.
 * So each run gets its own throwaway profile carrying that preference
 * (deleted on close), launched as a persistent context.
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

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** One run's browser: its only context, and how to shut it down (and delete its profile). */
export interface FormBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

/** The same Chromium the health check looks for, headless, in a fresh profile with preloading off. */
export async function launchFormBrowser(args: string[] = LAUNCH_ARGS): Promise<FormBrowser> {
  const dir = await mkdtemp(join(tmpdir(), "lsms-form-"));
  const gone = () => rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "Default"));
    // net.network_prediction_options 2 = never preload pages (speculation rules included).
    await writeFile(join(dir, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 2 } }));
    const context = await chromium.launchPersistentContext(dir, {
      executablePath: chromium.executablePath(), headless: true, args,
      serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true, userAgent: USER_AGENT, locale: "en-ZA",
      viewport: { width: 1280, height: 900 },
    });
    return { context, close: () => context.close().finally(gone) };
  } catch (err) {
    await gone();
    throw err;
  }
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
