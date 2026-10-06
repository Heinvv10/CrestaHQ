import "server-only";

import {
  BillingError,
  createPlanForAgency,
  listPlansForAgency,
} from "@/lib/server/billing-service";
import {
  PLAN_GATE_KEYS,
  type PlanGateKey,
  type PlanGates,
} from "@/types/billing";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, fmtMoney, FEATURE_GATES } from "./helpers";
import { currencyRefusal, defaultBillingCurrency } from "./billing-currency";
import { ASSISTANT_LOCKED_PLAN_FEATURES, PLAN_FEATURES } from "./billing-plan-features";

export const BILLING_PLAN_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_billing_plans",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["chat", "agent"],
    readonly: true,
    menuLabel: "List your Client-Billing plans (price + features)",
    description:
      "List this agency's Client-Billing plans with their id, price, feature count, and status. Use this to resolve a plan's id by name before assigning it (assign_billing_plan) — never guess plan ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List billing plans.",
    execute: async (ctx) => {
      const plans = await listPlansForAgency(ctx.agencyId);
      if (plans.length === 0) {
        return {
          resultText:
            "There are no Client-Billing plans yet. Create one with create_billing_plan.",
        };
      }
      const lines = plans.map((p) => {
        const cur = p.currency.toUpperCase();
        const monthly = `${fmtMoney(p.priceMonthlyCents / 100, cur)}/mo`;
        const annual =
          p.priceAnnualCents != null
            ? `, ${fmtMoney(p.priceAnnualCents / 100, cur)}/yr`
            : "";
        const gateCount = Object.values(p.gates).filter(Boolean).length;
        return `• ${p.name} (id: ${p.id}) — ${monthly}${annual} — ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } — ${p.status}`;
      });
      return { resultText: `Billing plans:\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["chat", "agent"],
    menuLabel: "Create a Client-Billing plan (price + bundled features)",
    description:
      "Create a Client-Billing plan (a monthly price + an optional annual price + a bundle of features) that the agency can charge sub-accounts for. Charges run on the deployment's own payment provider (Stripe or Paystack). Set includeAllFeatures:true for an all-inclusive plan, or pass a `features` list. TWO RULES BEFORE PROPOSING: (1) the plan NAME must come from the user — if they didn't state one explicitly, ask them what to call it; never invent or silently derive a name. (2) call list_billing_plans first and check whether a matching plan already exists (same name, or same price with the same features) — if it does, don't create a duplicate; suggest assign_billing_plan with the existing plan instead. To then charge a client, follow up with assign_billing_plan.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Plan name, e.g. “Pro” or “Gym Junkies”. 1–60 chars.",
        },
        priceMonthly: {
          type: "number",
          description:
            "Monthly price in whole currency units (dollars), e.g. 99 for $99/month.",
        },
        priceAnnual: {
          type: "number",
          description:
            "Optional annual price in dollars (e.g. 990). Omit for a monthly-only plan.",
        },
        currency: {
          type: "string",
          description:
            "ISO 4217 code, lowercase. Omitted, it is the payment provider's own: zar on Paystack, usd on Stripe. It must be one the provider can settle in cents (never jpy or kwd).",
        },
        includeAllFeatures: {
          type: "boolean",
          description:
            "true = bundle every feature into the plan (all-inclusive), except Public API access, which only the agency owner can add. When true, `features` is ignored.",
        },
        features: {
          type: "array",
          items: { type: "string", enum: PLAN_FEATURES },
          description:
            "Specific features to include when includeAllFeatures is not set. Omit for a bare plan (core CRM is always included).",
        },
      },
      required: ["name", "priceMonthly"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a plan name is required" };
      if (name.length > 60) {
        return {
          ok: false,
          error: "the plan name must be 60 characters or fewer",
        };
      }
      const monthly = r.priceMonthly;
      if (
        typeof monthly !== "number" ||
        !Number.isFinite(monthly) ||
        monthly <= 0
      ) {
        return {
          ok: false,
          error: "a monthly price greater than 0 is required",
        };
      }
      const priceMonthlyCents = Math.round(monthly * 100);
      if (priceMonthlyCents < 100) {
        return { ok: false, error: "the monthly price must be at least 1.00" };
      }
      let priceAnnualCents: number | null = null;
      if (r.priceAnnual !== undefined && r.priceAnnual !== null) {
        if (
          typeof r.priceAnnual !== "number" ||
          !Number.isFinite(r.priceAnnual) ||
          r.priceAnnual <= 0
        ) {
          return {
            ok: false,
            error:
              "the annual price must be a number greater than 0, or omitted",
          };
        }
        priceAnnualCents = Math.round(r.priceAnnual * 100);
        if (priceAnnualCents < 100) {
          return { ok: false, error: "the annual price must be at least 1.00" };
        }
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
      const includeAllFeatures = r.includeAllFeatures === true;
      const requested = Array.isArray(r.features) ? (r.features as unknown[]) : [];
      const locked = requested.filter(
        (f) => typeof f === "string" && ASSISTANT_LOCKED_PLAN_FEATURES.includes(f)
      );
      if (locked.length > 0) {
        return {
          ok: false,
          error: `${locked.join(", ")} can only be added to a plan by the agency owner, on the billing page`,
        };
      }
      const notPlan = requested.filter(
        (f) => typeof f === "string" && f in FEATURE_GATES && !PLAN_FEATURES.includes(f)
      );
      if (notPlan.length > 0) {
        return {
          ok: false,
          error: `${notPlan.join(", ")} can't be part of a plan — switch it per sub-account in the Manage dialog`,
        };
      }
      const features = requested.filter(
        (f): f is string => typeof f === "string" && PLAN_FEATURES.includes(f)
      );
      return {
        ok: true,
        args: {
          name,
          priceMonthlyCents,
          priceAnnualCents,
          currency,
          includeAllFeatures,
          features,
        },
      };
    },
    summarize: (args) => {
      const cur = (args.currency as string).toUpperCase();
      const monthly = `${fmtMoney((args.priceMonthlyCents as number) / 100, cur)}/mo`;
      const annual =
        args.priceAnnualCents != null
          ? ` + ${fmtMoney((args.priceAnnualCents as number) / 100, cur)}/yr`
          : "";
      const feat = args.includeAllFeatures
        ? "all features"
        : `${(args.features as string[]).length} feature(s)`;
      return `Create billing plan “${args.name}” at ${monthly}${annual} with ${feat}.`;
    },
    execute: async (ctx, args) => {
      // Build the gate bundle: all PLAN_GATE_KEYS on for includeAllFeatures,
      // otherwise only the named features (mapped through FEATURE_GATES → field).
      // Either way the assistant-locked gates stay off (validate may be skipped).
      const includeAll = args.includeAllFeatures === true;
      const lockedFields = ASSISTANT_LOCKED_PLAN_FEATURES.map(
        (f) => FEATURE_GATES[f].field
      );
      const gates = {} as PlanGates;
      for (const key of PLAN_GATE_KEYS) {
        gates[key] = includeAll && !lockedFields.includes(key);
      }
      if (!includeAll) {
        for (const f of args.features as string[]) {
          if (PLAN_FEATURES.includes(f)) {
            gates[FEATURE_GATES[f].field as PlanGateKey] = true;
          }
        }
      }
      // Duplicate guard (server-side, holds even if the model skipped the
      // list_billing_plans check): refuse an ACTIVE plan with the same name,
      // or one that's an exact functional duplicate (same monthly price +
      // same gate bundle) — assigning the existing plan is strictly better
      // since its gate edits propagate to every client on it.
      const existing = (await listPlansForAgency(ctx.agencyId)).filter(
        (p) => p.status === "active"
      );
      const wantedName = (args.name as string).trim().toLowerCase();
      const nameClash = existing.find(
        (p) => p.name.trim().toLowerCase() === wantedName
      );
      if (nameClash) {
        throw new CapabilityUserError(
          `A plan named “${nameClash.name}” already exists (id: ${nameClash.id}). Assign it with assign_billing_plan, or pick a different name.`
        );
      }
      const twin = existing.find(
        (p) =>
          p.priceMonthlyCents === (args.priceMonthlyCents as number) &&
          p.currency === (args.currency as string) &&
          PLAN_GATE_KEYS.every((k) => p.gates[k] === gates[k])
      );
      if (twin) {
        throw new CapabilityUserError(
          `The plan “${twin.name}” (id: ${twin.id}) already has this exact price and feature bundle. Assign that plan with assign_billing_plan instead of creating a duplicate.`
        );
      }

      let plan;
      try {
        plan = await createPlanForAgency({
          agencyId: ctx.agencyId,
          name: args.name as string,
          description: null,
          priceMonthlyCents: args.priceMonthlyCents as number,
          priceAnnualCents: (args.priceAnnualCents as number | null) ?? null,
          currency: args.currency as string,
          gates,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const cur = plan.currency.toUpperCase();
      const monthly = `${fmtMoney(plan.priceMonthlyCents / 100, cur)}/mo`;
      const annual =
        plan.priceAnnualCents != null
          ? ` and ${fmtMoney(plan.priceAnnualCents / 100, cur)}/yr`
          : "";
      const gateCount = Object.values(plan.gates).filter(Boolean).length;
      return {
        resultText: `Created plan “${plan.name}” (id: ${plan.id}) — ${monthly}${annual}, ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } bundled. Assign it to a sub-account with assign_billing_plan to start charging.`,
        ref: { kind: "billingPlan", id: plan.id },
      };
    },
  },
];
