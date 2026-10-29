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

/** A URL separator as it can appear in a log line: plain, JSON-escaped,
 *  or once/twice percent-encoded. */
const SEP = String.raw`(?:\/|\\\/|%2F|%252F)`;
const HOOK_URL_RE = new RegExp(String.raw`https?(?::|%3A|%253A)${SEP}{2}hooks\.slack\.com\.?${SEP}\S*`, "gi");
const SERVICES_PATH_RE = new RegExp(String.raw`${SEP}services${SEP}\S+`, "gi");
/** Slack hook secrets are 24 alphanumerics; Firestore ids (20) are left alone. */
const TOKEN_LIKE_RE = /\b[A-Za-z0-9]{24,}\b/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces webhook URLs in a message bound for a log line with
 * `[slack-url]`: `url` itself and (case-insensitively) its last path segment,
 * the secret, which also catches a URL that was split, encoded, escaped or
 * re-cased on its way into the message; then any Slack hook URL or bare
 * `/services/…` path in any of those encodings, and any 24+ character
 * alphanumeric run (what is left of a hook split across lines).
 */
export function redactSlackUrls(message: string, url?: string): string {
  let out = message;
  if (url) {
    out = out.split(url).join("[slack-url]");
    const token = url.split("/").pop() ?? "";
    if (token.length >= 8) out = out.replace(new RegExp(escapeRe(token), "gi"), "[slack-url]");
  }
  return out
    .replace(HOOK_URL_RE, "[slack-url]")
    .replace(SERVICES_PATH_RE, "[slack-url]")
    .replace(TOKEN_LIKE_RE, "[slack-url]");
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
