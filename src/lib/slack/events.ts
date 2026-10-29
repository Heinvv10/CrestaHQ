import "server-only";

import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";
import { postSlackMessage, redactSlackUrls } from "@/lib/slack/client";
import { buildSlackMessage } from "@/lib/slack/format";
import {
  appUrl,
  loadSlackHook,
  recordSlackResult,
} from "@/lib/server/slack-service";

/**
 * Slack consumer on the webhook event stream, hooked in next to push. Reads
 * the sub-account's hook (cached briefly per instance: a broadcast can emit
 * hundreds of events a minute), skips events that aren't ticked, posts, and
 * stamps the outcome on slackMeta. Never throws: it runs beside webhook
 * delivery and must never affect it.
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map<
  string,
  { at: number; hook: Awaited<ReturnType<typeof loadSlackHook>> }
>();

// Bumped by every invalidation. A load that started before a bump read the
// store before the change, so it must not refill the cache (it would serve
// the old hook for a minute).
const generations = new Map<string, number>();
const generationOf = (subAccountId: string) => generations.get(subAccountId) ?? 0;

type Hook = Awaited<ReturnType<typeof loadSlackHook>>;

async function hookFor(subAccountId: string): Promise<Hook> {
  const generation = generationOf(subAccountId);
  const hit = cache.get(subAccountId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hook;
  const hook = await loadSlackHook(subAccountId);
  if (generationOf(subAccountId) === generation) {
    cache.set(subAccountId, { at: Date.now(), hook });
  }
  return hook;
}

/** Called by the settings routes so a change shows up on the next event. */
export function invalidateSlackHookCache(subAccountId: string): void {
  generations.set(subAccountId, generationOf(subAccountId) + 1);
  cache.delete(subAccountId);
}

/**
 * Post from the lane, after re-reading the hook (the cache, or the store if
 * a settings change cleared it). Skipped (null) only when what the message
 * was built for no longer holds: the URL was replaced or disconnected, the
 * event is no longer ticked, or the preview choice changed. A change that
 * leaves those alone (Send test, ticking another event) posts as queued.
 */
function postIfCurrent(
  subAccountId: string,
  built: { webhookUrl: string; type: EmitWebhookEventInput["type"]; includeMessagePreview: boolean },
  message: Parameters<typeof postSlackMessage>[1],
) {
  return throttled(subAccountId, async () => {
    const current = await hookFor(subAccountId);
    if (
      !current ||
      current.webhookUrl !== built.webhookUrl ||
      !current.events.includes(built.type) ||
      current.includeMessagePreview !== built.includeMessagePreview
    ) {
      return null;
    }
    return postSlackMessage(built.webhookUrl, message);
  });
}

// Slack allows roughly one post per second per webhook. Posts for one
// sub-account are spaced out through a per-instance queue; a bulk import can
// still overflow it, and those extras are dropped rather than 429-stormed.
const MIN_GAP_MS = 1_000;
const MAX_QUEUE = 30;
const lanes = new Map<string, { tail: Promise<void>; depth: number }>();

function throttled<T>(subAccountId: string, fn: () => Promise<T>): Promise<T | null> {
  const lane = lanes.get(subAccountId) ?? { tail: Promise.resolve(), depth: 0 };
  if (lane.depth >= MAX_QUEUE) {
    console.warn(`[slack/events] queue full for ${subAccountId}, dropping post`);
    return Promise.resolve(null);
  }
  lane.depth += 1;
  const run = lane.tail.then(async () => {
    const started = Date.now();
    // A skipped post (fn resolved null) sent nothing, so it holds no gap.
    let sent = true;
    try {
      const out = await fn();
      sent = out !== null;
      return out;
    } finally {
      lane.depth -= 1;
      const wait = MIN_GAP_MS - (Date.now() - started);
      if (sent && wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  });
  lane.tail = run.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(subAccountId, lane);
  return run;
}

export async function dispatchSlackForWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<void> {
  try {
    const hook = await hookFor(input.subAccountId);
    if (!hook || !hook.events.includes(input.type)) return;
    const { includeMessagePreview } = hook;
    const message = buildSlackMessage(input, appUrl(), { includeMessagePreview });
    const first = await postIfCurrent(
      input.subAccountId,
      { webhookUrl: hook.webhookUrl, type: input.type, includeMessagePreview },
      message,
    );
    if (!first) return;
    let result = first;
    let postedUrl = hook.webhookUrl;
    if (result.revoked) {
      // The cache may be stale: another instance might have reconnected with
      // a new URL or disconnected, so re-read before marking the card.
      invalidateSlackHookCache(input.subAccountId);
      const fresh = await hookFor(input.subAccountId);
      if (!fresh) return;
      if (fresh.webhookUrl !== hook.webhookUrl) {
        if (!fresh.events.includes(input.type)) return;
        const retry = await postIfCurrent(
          input.subAccountId,
          { webhookUrl: fresh.webhookUrl, type: input.type, includeMessagePreview },
          message,
        );
        if (!retry) return;
        result = retry;
        postedUrl = fresh.webhookUrl;
      }
    }
    await recordSlackResult(input.subAccountId, postedUrl, result);
    // The re-read above cached the hook from before the revoke landed; drop
    // it so the next event sees needsReconnect instead of posting again.
    if (result.revoked) invalidateSlackHookCache(input.subAccountId);
  } catch (err) {
    console.warn(
      "[slack/events] dispatch failed",
      redactSlackUrls(err instanceof Error ? err.message : String(err)),
    );
  }
}
