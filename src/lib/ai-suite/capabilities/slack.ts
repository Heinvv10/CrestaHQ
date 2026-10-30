import "server-only";

import { SlackError, getSlackConfig, sanitizeSlackEvents, updateSlackSettings } from "@/lib/server/slack-service";
import { invalidateSlackHookCache } from "@/lib/slack/events";
import { DEFAULT_SLACK_EVENTS } from "@/types/slack";
import type { WebhookEventType } from "@/types/webhooks";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { messageBody, oneLine } from "./text-safety";

/**
 * Slack notifications from the assistant (UPSTREAM_PORT_PLAN_1_0_54.md, T2).
 * All three are admin-only, as the slack route is, and none has an agency
 * gate (E1: it spends only the client's own channel). slack_status reads the
 * card's meta (chat and API agents) and never the webhook URL, not even its
 * tail. configure_slack_events is a chat-only write behind a confirm card,
 * through the route's own updateSlackSettings, and writes the event list
 * only: whether inbound-message posts carry the message text is the contact's
 * own words going to a third-party workspace, so only the card changes it.
 * connect_slack is refused in chat: it stores a secret and posts a test
 * message, and the URL must never enter the chat.
 */

const CARD = "Settings Sub-Account → Admin tab → Slack notifications";

const CONNECT_REFUSAL =
  `Slack can only be connected on the card, not through the assistant: the webhook URL is a secret that can post to your channel, and connecting sends a test message. Open ${CARD}, paste the Incoming Webhook URL there (Slack: api.slack.com/apps → Create New App → From scratch → Incoming Webhooks → Activate → Add New Webhook to Workspace → pick the channel → copy the URL), and save. Once it is connected I can change which events post.`;

const URL_PASTED_NOTE =
  " Do not paste the URL into the chat. If you already did, treat it as exposed: revoke it in Slack (Incoming Webhooks → remove it) and create a new one for the card.";

const EVENT_NOT_RECOGNISED = `none of those event names are recognised; use event types such as ${DEFAULT_SLACK_EVENTS.join(", ")}`;

export const SLACK_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "slack_status",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "Check the Slack connection — channel, events posted, last post",
    description:
      `Show whether this workspace posts notifications to a Slack channel (${CARD}): connected or not, the channel name the admin noted, which events are ticked, whether inbound-message posts carry the message text, when the last post went out, and any error (e.g. a revoked webhook URL that needs reconnecting). Never shows the webhook URL. Use for 'is Slack connected?', 'what do we post to Slack?'.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Slack connection.",
    execute: async (ctx) => {
      const cfg = await getSlackConfig(ctx.subAccountId!);
      if (!cfg.connected) {
        return { resultText: `Slack isn't connected for this workspace. An admin connects it on the card: ${CARD}.` };
      }
      const label = oneLine(cfg.channelLabel);
      const events = cfg.events.map((e) => oneLine(e)).filter(Boolean);
      const last = cfg.lastSentAt ? `${cfg.lastSentAt.slice(0, 16).replace("T", " ")} UTC` : "never";
      const error = oneLine(cfg.lastError);
      return {
        resultText: `Slack: connected${label ? ` to ${label}` : ""}${
          cfg.needsReconnect ? " — NEEDS RECONNECT (Slack rejected the webhook URL; an admin pastes a new one on the card)" : ""
        }. Posting on: ${events.length ? events.join(", ") : "no events ticked"}. Inbound message posts ${
          cfg.includeMessagePreview ? "include the message text" : "do not include the message text"
        }. Last post: ${last}.${error ? ` Last error: ${error}` : ""}`,
      };
    },
  },
  {
    name: "configure_slack_events",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Change which events post to Slack",
    description:
      `Replace the list of events that post to the connected Slack channel. Give the full list of event types to keep on (e.g. contact.created, booking.created, message.received, call.missed, quote.accepted, quote.declined, deal.won, order.paid). Check slack_status first and include the ones already on that should stay. Only works once Slack is connected, which is done on the card (${CARD}), not here. It cannot change whether inbound-message posts carry the message text; that is a switch on the card.`,
    parameters: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: { type: "string" },
          description: "Full list of webhook event types to post. An empty list turns every post off.",
        },
      },
      required: ["events"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      if ("includeMessagePreview" in r) {
        return { ok: false, error: "the message-text switch can only be changed on the Slack card, not through the assistant" };
      }
      if (!Array.isArray(r.events)) return { ok: false, error: "events must be a list of event types" };
      const events = sanitizeSlackEvents(r.events);
      // Friendly names ("new lead") sanitise to nothing; saving that would
      // silently switch every post off.
      if (events.length === 0 && r.events.length > 0) return { ok: false, error: EVENT_NOT_RECOGNISED };
      return { ok: true, args: { events } };
    },
    summarize: (args) => {
      const events = args.events as string[];
      return `Post to Slack on: ${events.length ? events.join(", ") : "nothing"}.`;
    },
    execute: async (ctx, args) => {
      try {
        const cfg = await updateSlackSettings(ctx.subAccountId!, { events: args.events as WebhookEventType[] });
        invalidateSlackHookCache(ctx.subAccountId!);
        return { resultText: `Slack events updated: ${cfg.events.length ? cfg.events.join(", ") : "none"}.` };
      } catch (err) {
        if (err instanceof SlackError) throw new CapabilityUserError(err.message);
        throw err;
      }
    },
  },
  {
    name: "connect_slack",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Connect a Slack channel (done on the Slack card, not in chat)",
    description:
      `Call this when the user asks to connect, reconnect or change the Slack channel or webhook URL. It never connects anything: the Slack Incoming Webhook URL is a secret and must not enter the chat, so it is entered on the card (${CARD}). Calling this shows the user how. Never ask the user to paste the URL into the chat.`,
    parameters: {
      type: "object",
      properties: {
        channelLabel: { type: "string", description: "Channel name the user mentioned, e.g. '#sales'. Optional." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const urlPasted = Object.keys(r).some((k) => /url/i.test(k));
      let channelLabel = "";
      if (typeof r.channelLabel === "string") {
        const body = messageBody(r.channelLabel);
        if (body === null) return { ok: false, error: "the channel name contains characters that can't be shown safely" };
        channelLabel = body.slice(0, 60);
      }
      return { ok: true, args: { ...(channelLabel ? { channelLabel } : {}), urlPasted } };
    },
    summarize: (args) => `Connect Slack${args.channelLabel ? ` (${oneLine(args.channelLabel)})` : ""} — done on the card.`,
    chatRefusal: (args) => CONNECT_REFUSAL + (args.urlPasted === true ? URL_PASTED_NOTE : ""),
    execute: async () => {
      throw new CapabilityUserError(CONNECT_REFUSAL);
    },
  },
];
