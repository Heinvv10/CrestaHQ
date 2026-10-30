import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  getSubscription,
  updateSubscription,
} from "@/lib/firestore/webhook-subscriptions";
import { sendDirectTestDelivery } from "@/lib/webhooks/direct-test";
import {
  detectAutomationUrl,
  n8nProductionUrl,
  validatePublicUrl,
  validateWebhookUrl,
} from "@/lib/webhooks/validate-url";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";

export const WEBHOOK_URL_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_webhook_url",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel:
      "Point an existing webhook at a new URL (e.g. switch n8n test → production)",
    description:
      "Change the destination URL of an EXISTING webhook subscription, then immediately send a signed test event to the NEW URL and report whether it answered. The main use: after a successful test against an n8n TEST URL, the user activates their n8n workflow and asks to 'switch it to production / make it live' — pass switchToN8nProduction: true and the Production URL is derived server-side from the stored test URL (/webhook-test/ → /webhook/); never compute it yourself. For any other destination change, pass newUrl exactly as the user provided it. Resolve the webhookId with list_webhooks first — never guess ids. Events, signing secret, and the subscription's live/test API mode are all unchanged ('production' here means the destination URL, not the mode). If the webhook was paused (e.g. circuit breaker after failed deliveries to a dead URL), it is resumed as part of the switch.",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        currentUrl: {
          type: "string",
          description:
            "The webhook's CURRENT URL — shown to the user in the confirmation so they know which hook is changing.",
        },
        newUrl: {
          type: "string",
          description:
            "The new destination URL, exactly as the user provided it. Omit when using switchToN8nProduction.",
        },
        switchToN8nProduction: {
          type: "boolean",
          description:
            "True to derive the n8n Production URL from the stored test URL server-side. Mutually exclusive with newUrl.",
        },
      },
      required: ["webhookId", "currentUrl"],
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
      const toProduction =
        (raw as Record<string, unknown>)?.switchToN8nProduction === true;
      const newUrlRaw = str(raw, "newUrl");
      if (toProduction && newUrlRaw) {
        return {
          ok: false,
          error: "pass either newUrl or switchToN8nProduction, not both",
        };
      }
      if (!toProduction && !newUrlRaw) {
        return {
          ok: false,
          error: "either newUrl or switchToN8nProduction is required",
        };
      }
      let newUrl = "";
      if (newUrlRaw) {
        const urlCheck = validateWebhookUrl(newUrlRaw);
        if (!urlCheck.ok) {
          return {
            ok: false,
            error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
          };
        }
        newUrl = urlCheck.url;
      }
      return {
        ok: true,
        args: {
          webhookId,
          currentUrl: str(raw, "currentUrl"),
          newUrl,
          switchToN8nProduction: toProduction,
        },
      };
    },
    summarize: (args) =>
      args.switchToN8nProduction
        ? `Switch the webhook ${
            args.currentUrl || args.webhookId
          } to its n8n Production URL (/webhook-test/ → /webhook/) and send a test to verify it's live.`
        : `Point the webhook ${args.currentUrl || args.webhookId} at ${
            args.newUrl
          } and send a test to verify it's live.`,
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

      let targetUrl: string;
      if (args.switchToN8nProduction) {
        const info = detectAutomationUrl(subscription.url);
        if (info.tool !== "n8n") {
          throw new CapabilityUserError(
            `That webhook's URL (${subscription.url}) doesn't look like an n8n URL, so there's no Production URL to derive — provide the new URL explicitly instead.`
          );
        }
        if (info.n8nKind !== "test") {
          throw new CapabilityUserError(
            `That webhook already points at an n8n Production URL (${subscription.url}) — nothing to switch.`
          );
        }
        targetUrl = n8nProductionUrl(subscription.url);
      } else {
        targetUrl = args.newUrl as string;
      }
      if (targetUrl === subscription.url) {
        throw new CapabilityUserError(
          `That webhook already points at ${targetUrl} — nothing to change.`
        );
      }
      const publicCheck = await validatePublicUrl(targetUrl);
      if (!publicCheck.ok) throw new CapabilityUserError(publicCheck.error);

      // A paused hook (usually the circuit breaker tripping on the old dead
      // URL) is resumed as part of the repoint — the pause reason no longer
      // applies, and updateSubscription resets the failure counter.
      const wasPaused = subscription.status === "paused";
      await updateSubscription(ctx.subAccountId!, subscription.id, {
        url: targetUrl,
        ...(wasPaused ? { status: "active" as const } : {}),
      });

      const test = await sendDirectTestDelivery({
        ...subscription,
        url: targetUrl,
        status: "active",
      });
      const urlInfo = detectAutomationUrl(targetUrl);
      const prefix = `Webhook updated: ${subscription.url} → ${targetUrl}${
        wasPaused ? " (and resumed — it had been paused)" : ""
      }.`;
      if (test.ok) {
        let text = `${prefix}\n✅ Verified live — a test “${test.type}” event was delivered to the new URL and it responded ${test.httpStatus}.`;
        if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
          text += ` Your n8n workflow is live end to end — real events will flow to it from now on.`;
        } else if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "test") {
          text += ` ⚠️ Note: the new URL is an n8n TEST URL — it only responds while the n8n editor is listening.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `${prefix}\n⚠️ But the test to the new URL failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }). Real events will still be attempted with retries.`;
      if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
        text += ` n8n Production URLs only respond once the workflow's Active toggle is ON — publish/activate the workflow in n8n, then ask me to send another test (send_webhook_test).`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then ask me to send another test (send_webhook_test).`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
];
