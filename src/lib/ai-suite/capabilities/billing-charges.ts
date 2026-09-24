import "server-only";

import {
  assignPlanToSubAccount,
  BillingError,
  createOneTimeCharge,
  listChargesForSubAccount,
} from "@/lib/server/billing-service";
import { type BillingInterval } from "@/types/billing";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, fmtMoney } from "./helpers";

export const BILLING_CHARGE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "assign_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Assign a billing plan to a sub-account (start charging)",
    description:
      "Assign a Client-Billing plan to one sub-account and start the checkout/subscription. Resolve the sub-account's id with list_sub_accounts and the plan's id with list_billing_plans first — never guess ids. A fresh assignment returns a checkout link the client pays; switching a live subscription re-prices it immediately.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        planId: {
          type: "string",
          description:
            "Plan id, exactly as returned by list_billing_plans or create_billing_plan.",
        },
        planName: {
          type: "string",
          description: "The plan's name, for the confirmation card.",
        },
        interval: {
          type: "string",
          enum: ["month", "year"],
          description:
            "Billing cadence. Defaults to month. Use year only if the plan has an annual price.",
        },
        specialPrice: {
          type: "number",
          description:
            "Optional per-client price override in dollars, for the chosen cadence. Omit to use the plan's standard price.",
        },
      },
      required: ["subAccountId", "subAccountName", "planId", "planName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const planId = str(raw, "planId");
      if (!planId) {
        return {
          ok: false,
          error:
            "the plan id is required — look it up first with list_billing_plans",
        };
      }
      const interval: BillingInterval =
        r.interval === "year" ? "year" : "month";
      let specialPriceCents: number | null = null;
      if (r.specialPrice !== undefined && r.specialPrice !== null) {
        if (
          typeof r.specialPrice !== "number" ||
          !Number.isFinite(r.specialPrice) ||
          r.specialPrice <= 0
        ) {
          return {
            ok: false,
            error:
              "the special price must be a number greater than 0, or omitted",
          };
        }
        specialPriceCents = Math.round(r.specialPrice * 100);
        if (specialPriceCents < 100) {
          return {
            ok: false,
            error: "the special price must be at least 1.00",
          };
        }
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          planId,
          planName: str(raw, "planName"),
          interval,
          specialPriceCents,
        },
      };
    },
    summarize: (args) => {
      const cadence = args.interval === "year" ? "annual" : "monthly";
      const special =
        args.specialPriceCents != null
          ? ` at a special price of ${((args.specialPriceCents as number) / 100).toLocaleString("en-US")}`
          : "";
      return `Assign plan “${args.planName}” (${cadence}) to “${
        args.subAccountName || args.subAccountId
      }”${special}.`;
    },
    execute: async (ctx, args) => {
      let result;
      try {
        result = await assignPlanToSubAccount({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          planId: args.planId as string,
          specialPriceCents: (args.specialPriceCents as number | null) ?? null,
          interval: args.interval as BillingInterval,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      if (result.status === "pending" && result.checkoutUrl) {
        return {
          resultText: `Assigned “${args.planName}” to “${who}”. The workspace is now behind an activation screen until payment. Checkout link to send the client:\n${result.checkoutUrl}`,
          ref: { kind: "subAccount", id: args.subAccountId as string },
        };
      }
      return {
        resultText: `Switched “${who}” to the “${args.planName}” plan — the live subscription was re-priced (prorated) and the plan's features applied immediately.`,
        ref: { kind: "subAccount", id: args.subAccountId as string },
      };
    },
  },
  {
    name: "create_one_time_charge",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel:
      "Charge a sub-account client once (e.g. “Web design — $500”) via a payment link",
    description:
      "Create a ONE-TIME charge for a sub-account's client (e.g. a web design fee) and get a Stripe payment link to send them. Not a subscription — a single payment, independent of any plan (works for comped clients too). Resolve the sub-account's id with list_sub_accounts first — never guess ids. The description appears on the client's checkout page, so keep it professional.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        description: {
          type: "string",
          description:
            "What the charge is for — shown to the client at checkout, e.g. “Web design”. 1–120 chars.",
        },
        amount: {
          type: "number",
          description: "Amount in whole currency units (dollars), e.g. 500.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code, lowercase. Defaults to usd.",
        },
      },
      required: ["subAccountId", "subAccountName", "description", "amount"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const description = str(raw, "description");
      if (!description || description.length > 120) {
        return {
          ok: false,
          error:
            "a description (1–120 characters) is required — it's what the client sees at checkout",
        };
      }
      const amount = r.amount;
      if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return { ok: false, error: "an amount greater than 0 is required" };
      }
      const amountCents = Math.round(amount * 100);
      if (amountCents < 100) {
        return { ok: false, error: "the amount must be at least 1.00" };
      }
      const currency = (str(raw, "currency") || "usd").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          description,
          amountCents,
          currency,
        },
      };
    },
    summarize: (args) =>
      `One-time charge for “${args.subAccountName || args.subAccountId}”: ${
        args.description
      } — ${fmtMoney((args.amountCents as number) / 100, (args.currency as string).toUpperCase())} (single payment, not a subscription).`,
    execute: async (ctx, args) => {
      // Duplicate guard: an identical PENDING charge (same description +
      // amount) almost certainly means "re-send the link", not "bill twice".
      const existing = await listChargesForSubAccount(
        ctx.agencyId,
        args.subAccountId as string
      ).catch((err) => {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      });
      const dup = existing.find(
        (c) =>
          c.status === "pending" &&
          c.amountCents === (args.amountCents as number) &&
          c.description.trim().toLowerCase() ===
            (args.description as string).trim().toLowerCase()
      );
      if (dup) {
        throw new CapabilityUserError(
          `An identical pending charge already exists (“${dup.description}”). Copy a fresh link for it from the Manage dialog's Billing section instead of billing twice.`
        );
      }
      let result;
      try {
        result = await createOneTimeCharge({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          createdByUid: ctx.uid,
          description: args.description as string,
          amountCents: args.amountCents as number,
          currency: args.currency as string,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      const amt = fmtMoney(
        (args.amountCents as number) / 100,
        (args.currency as string).toUpperCase()
      );
      return {
        resultText: `Created a one-time charge for “${who}”: ${args.description} — ${amt}. Payment link to send the client:\n${result.checkoutUrl}\n\nIt marks itself paid automatically when the client completes checkout.`,
        ref: { kind: "billingCharge", id: result.charge.id },
      };
    },
  },
];
