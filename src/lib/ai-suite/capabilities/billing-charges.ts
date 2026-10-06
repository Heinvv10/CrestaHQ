import "server-only";

import {
  BillingError,
  createOneTimeCharge,
  listChargesForSubAccount,
} from "@/lib/server/billing-service";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, fmtMoney } from "./helpers";
import { chargePreview, NEEDS_APPROVAL, tenantWide, withoutLabels } from "./billing-proposals";
import { currencyRefusal, defaultBillingCurrency } from "./billing-currency";
import { paddedSubAccountId } from "./agency-support";
import { UNSAFE_TEXT_MESSAGE, UNSAFE_TEXT_RE } from "./text-safety";
import { ASSIGN_BILLING_PLAN } from "./billing-assign";

export const BILLING_CHARGE_CAPABILITIES: AiSuiteCapability[] = [
  ASSIGN_BILLING_PLAN,
  {
    name: "create_one_time_charge",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["chat", "agent"],
    approval: "spend",
    agentArgs: withoutLabels,
    approvalTarget: tenantWide,
    preview: chargePreview,
    menuLabel:
      "Charge a sub-account client once (e.g. “Web design — $500”) via a payment link",
    description:
      "Create a ONE-TIME charge for a sub-account's client (e.g. a web design fee) and get a payment link to send them (on the deployment's own payment provider). Not a subscription — a single payment, independent of any plan (works for comped clients too). Resolve the sub-account's id with list_sub_accounts first — never guess ids. The description appears on the client's checkout page, so keep it professional.",
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
          description:
            "ISO 4217 code, lowercase. Omitted, it is the payment provider's own: zar on Paystack, usd on Stripe. It must be one the provider can settle in cents (never jpy or kwd).",
        },
      },
      required: ["subAccountId", "description", "amount"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const padded = paddedSubAccountId(raw);
      if (padded) return padded;
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
      // Shown to the client at checkout exactly as stored, and to the approver
      // through oneLine, which drops every format character: strict, as the email.
      if (UNSAFE_TEXT_RE.test(description)) return { ok: false, error: `the description ${UNSAFE_TEXT_MESSAGE}` };
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
      const currency = (str(raw, "currency") || defaultBillingCurrency()).toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      const unsettled = currencyRefusal(currency);
      if (unsettled) return { ok: false, error: unsettled };
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          description,
          // Kept so a stored proposal re-validates (the decide route does).
          amount,
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
      if (ctx.apiKey && !ctx.approved) throw new CapabilityUserError(NEEDS_APPROVAL);
      // Approved: exactly the charge the owner reviewed (chargePreview).
      if (ctx.approved) args = { ...args, ...ctx.approved.pinned };
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
