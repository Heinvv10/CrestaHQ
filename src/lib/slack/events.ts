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
// store before the change, so it must not refill the cache, and a post
// queued under an older generation is skipped rather than sent to a hook
// that was disconnected or replaced meanwhile.
const generations = new Map<string, number>();
const generationOf = (subAccountId: string) => generations.get(subAccountId) ?? 0;

/** The hook, and the generation it is valid for. */
async function hookFor(subAccountId: string) {
  const generation = generationOf(subAccountId);
  const hit = cache.get(subAccountId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { hook: hit.hook, generation };
  const hook = await loadSlackHook(subAccountId);
  if (generationOf(subAccountId) === generation) {
    cache.set(subAccountId, { at: Date.now(), hook });
  }
  return { hook, generation };
}

/** Called by the settings routes so a change shows up on the next event. */
export function invalidateSlackHookCache(subAccountId: string): void {
  generations.set(subAccountId, generationOf(subAccountId) + 1);
  cache.delete(subAccountId);
}

/** Post unless the hook changed since `generation` was read (null = skipped). */
function postIfCurrent(
  subAccountId: string,
  generation: number,
  webhookUrl: string,
  message: Parameters<typeof postSlackMessage>[1],
) {
  return throttled(subAccountId, async () =>
    generationOf(subAccountId) === generation ? postSlackMessage(webhookUrl, message) : null,
  );
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
    try {
      return await fn();
    } finally {
      lane.depth -= 1;
      const wait = MIN_GAP_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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
    const { hook, generation } = await hookFor(input.subAccountId);
    if (!hook || !hook.events.includes(input.type)) return;
    const message = buildSlackMessage(input, appUrl(), {
      includeMessagePreview: hook.includeMessagePreview,
    });
    const first = await postIfCurrent(input.subAccountId, generation, hook.webhookUrl, message);
    if (!first) return;
    let result = first;
    let postedUrl = hook.webhookUrl;
    if (result.revoked) {
      // The cache may be stale: another instance might have reconnected with
      // a new URL or disconnected, so re-read before marking the card.
      invalidateSlackHookCache(input.subAccountId);
      const reread = await hookFor(input.subAccountId);
      const fresh = reread.hook;
      if (!fresh) return;
      if (fresh.webhookUrl !== hook.webhookUrl) {
        if (!fresh.events.includes(input.type)) return;
        const retry = await postIfCurrent(input.subAccountId, reread.generation, fresh.webhookUrl, message);
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
