import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { getSubscription } from "@/lib/firestore/webhook-subscriptions";
import { sendDirectTestDelivery } from "@/lib/webhooks/direct-test";
import {
  detectAutomationUrl,
  n8nProductionUrl,
} from "@/lib/webhooks/validate-url";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/types/webhooks";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";

export const WEBHOOK_TEST_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "send_webhook_test",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Send a test event to an existing webhook (verify n8n / Make / Zapier is receiving)",
    description:
      "Send ONE signed sample event to an EXISTING webhook subscription and report whether the endpoint answered — the in-chat equivalent of the send-test button under Settings → Webhooks. Use when the user wants to (re)verify an endpoint, e.g. their n8n node is now listening after an earlier test failed. Resolve the webhookId with list_webhooks first — never guess ids. Optionally pass eventType to test a specific event the subscription covers (defaults to its first subscribed event). This does NOT create or modify the webhook; it only fires one test delivery (which appears in Logs → Webhooks like any other delivery).",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        url: {
          type: "string",
          description:
            "The webhook's destination URL — shown to the user in the confirmation so they know which endpoint gets hit.",
        },
        eventType: {
          type: "string",
          enum: [...WEBHOOK_EVENT_TYPES],
          description:
            "Optional: which sample event to send. Must be one the subscription is subscribed to. Omit to use its first subscribed event.",
        },
      },
      required: ["webhookId", "url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const webhookId = str(raw, "webhookId");
      if (!webhookId) {
        return {
          ok: false,
          error: "webhookId is required — resolve it with list_webhooks first",
        };
      }
      const eventType = str(raw, "eventType");
      if (
        eventType &&
        !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType)
      ) {
        return { ok: false, error: `unknown eventType '${eventType}'` };
      }
      return {
        ok: true,
        args: { webhookId, url: str(raw, "url"), eventType },
      };
    },
    summarize: (args) =>
      `Send a signed test ${
        args.eventType ? `“${args.eventType}” ` : ""
      }event to ${args.url || "the webhook"} and check the response.`,
    execute: async (ctx, args) => {
      // Same agency kill switch as create_webhook — webhooks are part of
      // the public-API surface.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // getSubscription is path-scoped under THIS workspace, so a foreign
      // (model-guessed) id simply comes back null.
      const subscription = await getSubscription(
        ctx.subAccountId!,
        args.webhookId as string
      );
      if (!subscription) {
        throw new CapabilityUserError(
          "That webhook wasn't found in this workspace — run list_webhooks and use one of its ids."
        );
      }
      if (subscription.status === "paused") {
        throw new CapabilityUserError(
          "That webhook is paused, so tests won't send. Resume it under Settings → Webhooks first."
        );
      }
      const eventType = (args.eventType as string) || "";
      if (
        eventType &&
        subscription.events.length > 0 &&
        !subscription.events.includes(eventType as WebhookEventType)
      ) {
        throw new CapabilityUserError(
          `That webhook isn't subscribed to '${eventType}' — it covers: ${subscription.events.join(
            ", "
          )}.`
        );
      }

      const test = await sendDirectTestDelivery(
        subscription,
        eventType ? (eventType as WebhookEventType) : undefined
      );
      const urlInfo = detectAutomationUrl(subscription.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      if (test.ok) {
        let text = `✅ Test “${test.type}” event delivered to ${subscription.url} — the endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          text += ` Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. For an always-on hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            subscription.url
          )}.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `⚠️ The test “${test.type}” event to ${subscription.url} failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }).`;
      if (isN8nTestUrl) {
        text += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then send another test. For an always-on hook: activate the workflow, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
          subscription.url
        )}.`;
      } else if (urlInfo.tool === "n8n") {
        text += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it and try again.`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then try again.`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
];
