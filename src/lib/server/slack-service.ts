import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { postSlackMessage, type SlackPostResult } from "@/lib/slack/client";
import { slackTestMessage } from "@/lib/slack/format";
import {
  DEFAULT_SLACK_EVENTS,
  isSlackWebhookUrl,
  type SlackConfigResponse,
  type SlackMeta,
  type SlackPrivateDoc,
} from "@/types/slack";
import type { WebhookEventType } from "@/types/webhooks";
import { WEBHOOK_EVENT_CATEGORIES } from "@/lib/webhooks/event-categories";
import type { SubAccountDoc } from "@/types";

/**
 * The only reader and writer of `subAccounts/{id}/private/slack`. The card
 * only ever sees `slackMeta`; the URL never leaves the server.
 *
 * Every write that depends on the current connection runs in a transaction
 * that re-reads it: a status stamp lands only while the URL it posted to is
 * still the stored one, so a slow post can't flag a hook that was replaced
 * or disconnected meanwhile.
 */

export class SlackError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function privateRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/private/slack`);
}
function subRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}`);
}

export function appUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/\/$/, "");
}

function tsToIso(v: unknown): string | null {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

export function serializeSlackMeta(
  meta: Partial<SlackMeta> | null | undefined,
): SlackConfigResponse {
  return {
    connected: meta?.connected === true,
    channelLabel: meta?.channelLabel ?? null,
    urlTail: meta?.urlTail ?? null,
    events: Array.isArray(meta?.events) ? meta.events : [],
    lastSentAt: tsToIso(meta?.lastSentAt),
    lastError: meta?.lastError ?? null,
    needsReconnect: meta?.needsReconnect === true,
  };
}

function metaOf(data: unknown): Partial<SlackMeta> | undefined {
  return (data as Partial<SubAccountDoc> | undefined)?.slackMeta ?? undefined;
}

export async function getSlackConfig(
  subAccountId: string,
): Promise<SlackConfigResponse> {
  const snap = await subRef(subAccountId).get();
  return serializeSlackMeta(metaOf(snap.data()));
}

/** Only events the picker can show; anything without a category is dropped. */
export function sanitizeSlackEvents(raw: unknown): WebhookEventType[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(
    WEBHOOK_EVENT_CATEGORIES.flatMap((c) => c.events),
  );
  const out: WebhookEventType[] = [];
  for (const v of raw) {
    if (typeof v === "string" && known.has(v) && !out.includes(v as WebhookEventType)) {
      out.push(v as WebhookEventType);
    }
  }
  return out;
}

/** Validates the URL, proves it with a test post, then stores both docs. */
export async function connectSlack(opts: {
  subAccountId: string;
  uid: string;
  webhookUrl: string;
  /** Omitted = keep the existing label on a reconnect. */
  channelLabel?: string | null;
  events?: WebhookEventType[];
}): Promise<SlackConfigResponse> {
  const url = opts.webhookUrl.trim();
  if (!isSlackWebhookUrl(url)) {
    throw new SlackError(
      "That doesn't look like a Slack Incoming Webhook URL (it starts with https://hooks.slack.com/services/).",
      400,
    );
  }
  const test = await postSlackMessage(url, slackTestMessage(appUrl(), opts.subAccountId));
  if (!test.ok) {
    throw new SlackError(test.error ?? "Slack rejected the test message.", 502);
  }

  await getAdminDb().runTransaction(async (tx) => {
    const existing = metaOf((await tx.get(subRef(opts.subAccountId))).data());
    // Explicit list wins; a reconnect keeps whatever was ticked (even nothing).
    const events =
      opts.events ??
      (existing?.connected && Array.isArray(existing.events)
        ? existing.events
        : DEFAULT_SLACK_EVENTS);
    const privateDoc: SlackPrivateDoc = {
      webhookUrl: url,
      connectedByUid: opts.uid,
      connectedAt: FieldValue.serverTimestamp(),
    };
    const meta: SlackMeta = {
      connected: true,
      channelLabel:
        opts.channelLabel === undefined
          ? existing?.channelLabel ?? null
          : opts.channelLabel?.trim().slice(0, 60) || null,
      urlTail: url.slice(-6),
      events,
      lastSentAt: FieldValue.serverTimestamp(),
      lastError: null,
      needsReconnect: false,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(privateRef(opts.subAccountId), privateDoc);
    tx.set(
      subRef(opts.subAccountId),
      { slackMeta: meta, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  });
  return getSlackConfig(opts.subAccountId);
}

export async function updateSlackEvents(
  subAccountId: string,
  events: WebhookEventType[],
): Promise<SlackConfigResponse> {
  await getAdminDb().runTransaction(async (tx) => {
    const meta = metaOf((await tx.get(subRef(subAccountId))).data());
    if (!meta?.connected) {
      throw new SlackError("Connect a Slack channel first.", 400);
    }
    tx.update(subRef(subAccountId), {
      "slackMeta.events": events,
      "slackMeta.updatedAt": FieldValue.serverTimestamp(),
    });
  });
  return getSlackConfig(subAccountId);
}

/** The stored URL, or null when there is none or it is not a Slack hook. */
async function storedUrl(subAccountId: string): Promise<string | null> {
  const priv = (await privateRef(subAccountId).get()).data() as
    | Partial<SlackPrivateDoc>
    | undefined;
  if (!priv?.webhookUrl) return null;
  if (!isSlackWebhookUrl(priv.webhookUrl)) {
    console.warn(`[slack] stored webhook URL for ${subAccountId} is not a Slack hook; refusing to post`);
    return null;
  }
  return priv.webhookUrl;
}

export async function sendSlackTest(
  subAccountId: string,
): Promise<SlackConfigResponse> {
  const url = await storedUrl(subAccountId);
  if (!url) {
    throw new SlackError("Connect a Slack channel first.", 400);
  }
  const result = await postSlackMessage(url, slackTestMessage(appUrl(), subAccountId));
  await recordSlackResult(subAccountId, url, result);
  if (!result.ok) {
    throw new SlackError(result.error ?? "Slack rejected the test message.", 502);
  }
  return getSlackConfig(subAccountId);
}

/** null, not a `connected: false` object: `hasChannelConnection` (and the
 *  teardown guard) read any non-null `slackMeta` as a live connection. */
export async function disconnectSlack(subAccountId: string): Promise<void> {
  const batch = getAdminDb().batch();
  batch.delete(privateRef(subAccountId));
  batch.set(
    subRef(subAccountId),
    { slackMeta: null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await batch.commit();
}

/** Read the hook for a post; null when not connected, revoked or invalid. */
export async function loadSlackHook(
  subAccountId: string,
): Promise<{ webhookUrl: string; events: WebhookEventType[] } | null> {
  const meta = metaOf((await subRef(subAccountId).get()).data());
  if (!meta?.connected || meta.needsReconnect) return null;
  const webhookUrl = await storedUrl(subAccountId);
  if (!webhookUrl) return null;
  return {
    webhookUrl,
    events: Array.isArray(meta.events) ? meta.events : [],
  };
}

const STAMP_MIN_INTERVAL_MS = 60_000;
const lastStamp = new Map<string, { at: number; ok: boolean }>();

/**
 * Best-effort status stamp for a post to `postedUrl`. The sub-account doc is
 * hot (every member's onSnapshot), so successes are stamped at most once a
 * minute per instance unless they clear an error; failures always land.
 * Skipped when the stored URL is no longer `postedUrl` (reconnected or
 * disconnected since the post). Never throws.
 */
export async function recordSlackResult(
  subAccountId: string,
  postedUrl: string,
  result: SlackPostResult,
): Promise<void> {
  const prev = lastStamp.get(subAccountId);
  if (
    result.ok &&
    prev?.ok &&
    Date.now() - prev.at < STAMP_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastStamp.set(subAccountId, { at: Date.now(), ok: result.ok });
  try {
    await getAdminDb().runTransaction(async (tx) => {
      const priv = (await tx.get(privateRef(subAccountId))).data() as
        | Partial<SlackPrivateDoc>
        | undefined;
      if (priv?.webhookUrl !== postedUrl) return;
      tx.update(
        subRef(subAccountId),
        result.ok
          ? {
              "slackMeta.lastSentAt": FieldValue.serverTimestamp(),
              "slackMeta.lastError": null,
              "slackMeta.needsReconnect": false,
            }
          : {
              "slackMeta.lastError": (result.error ?? "Post failed").slice(0, 300),
              // Only a revoked hook flips the card; a transient failure must
              // not clear a reconnect flag another instance just set.
              ...(result.revoked ? { "slackMeta.needsReconnect": true } : {}),
            },
      );
    });
  } catch (err) {
    console.warn(
      "[slack] status stamp failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
