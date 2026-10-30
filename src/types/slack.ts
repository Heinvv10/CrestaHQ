import type { Timestamp, FieldValue } from "firebase/firestore";
import type { WebhookEventType } from "./webhooks";

/**
 * Slack notifications: one Incoming Webhook URL per sub-account, posted to
 * from the webhook event stream. The URL can post to the channel, so it lives
 * in `subAccounts/{id}/private/slack` (Admin SDK only); everything the card
 * shows is on `SubAccountDoc.slackMeta`.
 */

export interface SlackPrivateDoc {
  webhookUrl: string;
  connectedByUid: string;
  connectedAt: Timestamp | FieldValue | Date;
}

export interface SlackMeta {
  connected: boolean;
  /** Free text the admin typed, e.g. "#sales"; never read from Slack. */
  channelLabel: string | null;
  /** Last characters of the URL so the card can show which hook is in place. */
  urlTail: string | null;
  events: WebhookEventType[];
  /**
   * Post the text of inbound messages. Off (the default, and when absent):
   * "New message from <first name>" only. The text is the contact's own
   * words, so posting it to a third-party workspace is the admin's choice.
   */
  includeMessagePreview?: boolean;
  lastSentAt: Timestamp | FieldValue | Date | null;
  /** Set when the last post failed; cleared by the next success. */
  lastError: string | null;
  /** Slack said the hook no longer exists (404/410); needs a new URL. */
  needsReconnect: boolean;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** On by default when a channel is connected: the same set push notifies on. */
export const DEFAULT_SLACK_EVENTS: WebhookEventType[] = [
  "contact.created",
  "message.received",
  "booking.created",
  "call.missed",
  "quote.accepted",
  "quote.declined",
];

export const SLACK_WEBHOOK_URL_RE =
  /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

/** Real hooks are ~80 characters; anything far longer is not one. */
export const SLACK_WEBHOOK_URL_MAX = 300;

/**
 * Whether `raw` is a Slack Incoming Webhook URL: the regex AND a parsed
 * check (https, exactly hooks.slack.com, default port, no credentials,
 * a /services/ path), length-capped. Checked on every stored URL before a
 * post, not only when it is saved.
 */
export function isSlackWebhookUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > SLACK_WEBHOOK_URL_MAX) return false;
  if (!SLACK_WEBHOOK_URL_RE.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "hooks.slack.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.startsWith("/services/")
  );
}

/** Wire shape for the settings card. */
export interface SlackConfigResponse {
  connected: boolean;
  channelLabel: string | null;
  urlTail: string | null;
  events: WebhookEventType[];
  includeMessagePreview: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  needsReconnect: boolean;
}
