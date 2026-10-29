import "server-only";

import { publicFetch } from "@/lib/webhooks/public-fetch";

/**
 * Posts to a Slack Incoming Webhook. Slack answers "ok" (200) on success and
 * a short plain-text error otherwise; 404/410 means the hook was revoked.
 *
 * Goes through `publicFetch`: no redirect is followed (a 3xx is a failure),
 * the connection only opens to public addresses in production, the body
 * read is capped and one deadline covers DNS, connect and read. Callers
 * check the URL with `isSlackWebhookUrl` first; this module only carries
 * the request.
 */

export interface SlackMessage {
  /** Notification/fallback text; Slack shows it in previews. */
  text: string;
  blocks?: unknown[];
}

export interface SlackPostResult {
  ok: boolean;
  error: string | null;
  /** The hook is gone; posting again won't help until the URL is replaced. */
  revoked: boolean;
}

const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024;

/** Slack's error bodies are short codes ("no_service", "invalid_payload");
 *  anything else is not echoed into `lastError`. */
const SLACK_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * Replaces webhook URLs in a message bound for a log line: any Slack hook
 * URL or bare `/services/…` path, and `url` itself plus its last path
 * segment (the secret token), which also catches a URL that was split,
 * encoded or re-cased on its way into the message.
 */
export function redactSlackUrls(message: string, url?: string): string {
  let out = message;
  if (url) {
    out = out.split(url).join("[slack-url]");
    const token = url.split("/").pop() ?? "";
    if (token.length >= 8) out = out.split(token).join("[slack-url]");
  }
  return out
    .replace(/https?:\/\/hooks\.slack\.com\.?\/\S*/gi, "[slack-url]")
    .replace(/\/services\/\S+/gi, "[slack-url]");
}

export async function postSlackMessage(
  webhookUrl: string,
  message: SlackMessage,
): Promise<SlackPostResult> {
  try {
    const res = await publicFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (res.ok) return { ok: true, error: null, revoked: false };
    const raw = (await res.text().catch(() => "")).trim();
    const body = SLACK_ERROR_CODE.test(raw) ? raw : "";
    const revoked = res.status === 404 || res.status === 410;
    return {
      ok: false,
      revoked,
      error: revoked
        ? "Slack no longer accepts this webhook URL. Create a new one and reconnect."
        : `Slack returned ${res.status}${body ? `: ${body}` : "."}`,
    };
  } catch (err) {
    // The message only: a raw error object can carry request details.
    console.warn(
      "[slack/client] post failed",
      redactSlackUrls(err instanceof Error ? err.message : String(err), webhookUrl),
    );
    return { ok: false, revoked: false, error: "Could not reach Slack." };
  }
}
