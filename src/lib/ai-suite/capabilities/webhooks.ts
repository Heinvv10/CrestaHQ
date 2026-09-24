import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { generateSigningSecret } from "@/lib/api/webhooks/signing";
import {
  createSubscription,
  listSubscriptions,
} from "@/lib/firestore/webhook-subscriptions";
import { sendDirectTestDelivery } from "@/lib/webhooks/direct-test";
import {
  detectAutomationUrl,
  n8nProductionUrl,
  validatePublicUrl,
  validateWebhookUrl,
} from "@/lib/webhooks/validate-url";
import {
  categoryOf,
  eventsAreSingleCategory,
} from "@/lib/webhooks/event-categories";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/types/webhooks";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";

export const WEBHOOK_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_webhooks",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "List this workspace's outbound webhooks and their delivery status",
    description:
      "List this sub-account's outbound webhook subscriptions (id, URL, events, status, last delivery). Use to answer questions about existing webhooks, to check for duplicates before proposing create_webhook, and to resolve the webhookId for send_webhook_test / update_webhook_url.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's webhooks.",
    execute: async (ctx) => {
      const docs = await listSubscriptions(ctx.subAccountId!);
      if (docs.length === 0) {
        return {
          resultText: "This workspace has no webhook subscriptions yet.",
        };
      }
      const lines = docs.map((d) => {
        const events = d.events.length ? d.events.join(", ") : "all events";
        const last =
          d.lastDeliveryStatus != null
            ? `last delivery HTTP ${d.lastDeliveryStatus}`
            : "no deliveries yet";
        return `- [id: ${d.id}] ${d.url} — ${d.mode}, ${d.status}${
          d.pausedReason ? ` (${d.pausedReason})` : ""
        }. Events: ${events}. ${last}.${
          d.description ? ` Label: ${d.description}.` : ""
        }`;
      });
      return {
        resultText: `Webhook subscriptions (${docs.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "create_webhook",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel:
      "Set up an outbound webhook to n8n / Make / Zapier (with a live test to verify it)",
    description:
      "Create an outbound webhook subscription in this sub-account: events here get POSTed to the user's endpoint (n8n, Make, Zapier, custom). Gather two things conversationally before calling: (1) the trigger — which event(s), all from ONE category (contacts, deals, tasks & events, forms, quotes, bookings, AI agents, conversations); offer the closest event types when they describe a goal like 'when a new lead comes in' → contact.created. (2) the destination URL from their automation tool. n8n gotcha — n8n shows TWO URLs per webhook node: a Test URL containing /webhook-test/ (only works while the n8n editor is listening) and a Production URL containing /webhook/ (only works when the workflow is Active). If the user pastes a /webhook-test/ URL, point this out and ask whether they want the Production URL for a permanent hook (same address with /webhook/ instead) — only proceed with the test URL if they say they're just testing right now. After the user confirms, the webhook is created AND a signed test event is sent immediately to verify the endpoint is live.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The destination endpoint URL (e.g. an n8n/Make/Zapier webhook URL). Must be exactly what the user provided.",
        },
        events: {
          type: "array",
          items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
          description:
            "Event types to subscribe to — at least one, all from the same category.",
        },
        description: {
          type: "string",
          description: "Optional short label, e.g. 'n8n new-lead flow'.",
        },
        mode: {
          type: "string",
          enum: ["live", "test"],
          description:
            "Default 'live'. Only use 'test' if the user explicitly wants test-mode API traffic.",
        },
      },
      required: ["url", "events"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const urlCheck = validateWebhookUrl(str(raw, "url"));
      if (!urlCheck.ok)
        return {
          ok: false,
          error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
        };
      const rawEvents = (raw as Record<string, unknown>)?.events;
      const events = Array.isArray(rawEvents)
        ? rawEvents.filter((e): e is WebhookEventType =>
            (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e as string)
          )
        : [];
      if (events.length === 0) {
        return {
          ok: false,
          error: "at least one valid trigger event is required",
        };
      }
      if (!eventsAreSingleCategory(events)) {
        return {
          ok: false,
          error: `all events must be from one category (these span ${[
            ...new Set(events.map((e) => categoryOf(e))),
          ].join(" + ")}) — create one webhook per category`,
        };
      }
      const mode = str(raw, "mode") || "live";
      if (mode !== "live" && mode !== "test") {
        return { ok: false, error: "mode must be 'live' or 'test'" };
      }
      return {
        ok: true,
        args: {
          url: urlCheck.url,
          events,
          description: str(raw, "description").slice(0, 120),
          mode,
        },
      };
    },
    summarize: (args) => {
      const base = `Create a ${args.mode} webhook to ${args.url} for: ${(
        args.events as string[]
      ).join(", ")}. A test event will be sent to verify it.`;
      const info = detectAutomationUrl(args.url as string);
      return info.tool === "n8n" && info.n8nKind === "test"
        ? `${base} ⚠️ This is an n8n TEST URL — it only receives events while the n8n editor is listening. For an always-on hook, use the Production URL instead (same address with /webhook/ instead of /webhook-test/).`
        : base;
    },
    execute: async (ctx, args) => {
      // Same agency gate as the dashboard's webhook mint route — webhooks
      // are part of the public-API surface, so they share the kill switch.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // validate() is sync and string-only; resolve DNS here, as the REST
      // create route does.
      const publicCheck = await validatePublicUrl(args.url as string);
      if (!publicCheck.ok) throw new CapabilityUserError(publicCheck.error);

      const signingSecret = generateSigningSecret();
      const doc = await createSubscription({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        mode: args.mode as "live" | "test",
        url: args.url as string,
        description: (args.description as string) || null,
        events: args.events as WebhookEventType[],
        signingSecret,
        createdByUid: ctx.uid,
      });

      // Liveness check: one synchronous signed test delivery, so the user
      // hears "created AND your endpoint answered" in one breath. The
      // messaging is tool-aware — n8n's test-vs-production URL trap is the
      // top real-world failure mode, so call it out specifically.
      const test = await sendDirectTestDelivery(doc);
      const urlInfo = detectAutomationUrl(doc.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      let verification: string;
      if (test.ok) {
        verification = `✅ Verified live — a test “${test.type}” event was delivered and your endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          verification += ` ⚠️ Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. Once you stop listening, deliveries will silently fail. For a permanent hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            doc.url
          )}.`;
        }
      } else {
        verification = `⚠️ The webhook was created, but the test delivery failed (${
          test.error ?? `HTTP ${test.httpStatus}`
        }). Real events will still be attempted with retries.`;
        if (isN8nTestUrl) {
          verification += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then ask me to send another test (send_webhook_test) — or (better, for an always-on hook) use the Production URL instead: ${n8nProductionUrl(
            doc.url
          )} — the workflow must be set to Active.`;
        } else if (urlInfo.tool === "n8n") {
          verification += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it, then ask me to send another test (send_webhook_test).`;
        } else {
          verification += ` Check the URL is correct and your workflow is listening, then ask me to send another test (send_webhook_test).`;
        }
      }

      return {
        resultText: `Created the webhook to ${doc.url} for ${(
          args.events as string[]
        ).join(
          ", "
        )}.\n${verification}\nSigning secret (shown once — copy it now if you want to verify signatures; n8n/Make work fine without it): ${signingSecret}\nManage it anytime under Settings → Webhooks.`,
        ref: { kind: "webhookSubscription", id: doc.id },
      };
    },
  },
];
