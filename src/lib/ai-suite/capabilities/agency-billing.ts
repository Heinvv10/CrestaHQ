import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isReachable } from "@/lib/api/agent-reach";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { BillingError, billingStripeIsConfigured, compSubAccount, mintCheckoutLink } from "@/lib/server/billing-service";
import {
  billingDateToMillis,
  effectiveBillingState,
  formatBillingPrice,
  formatBillingPriceWithInterval,
  isMrrEligible,
  monthlyEquivalentCents,
  type EffectiveBillingState,
} from "@/lib/billing/status";
import type { SubAccountBilling } from "@/types/billing";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability, type PreviewRow } from "./types";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { tenantWide, withoutLabels } from "./billing-proposals";
import { paddedSubAccountId, subAccountInAgency } from "./agency-support";

/**
 * Agency billing tools from upstream 1.0.40 (UPSTREAM_PORT_PLAN.md, N2b),
 * on the same billing-service the Manage dialog uses, so they hold on
 * Paystack as on Stripe:
 *   - billing_overview: a read, chat and agent. An agent key sees only the
 *     sub-accounts it reaches. MRR is the agency billing page's own figure
 *     (active + grace, annual ÷ 12, per currency).
 *   - comp_client: cancels a live subscription, which can't be undone, so
 *     chat only, behind a confirm card.
 *   - resend_checkout_link: hands out a payable link and makes every older
 *     one stop working, so it is never a chat action; an agent's call waits
 *     for the owner's approval (outbound), which pins the plan the link pays.
 */

const FILTERS = ["all", "needs-attention", "active", "comped"] as const;
const ATTENTION: EffectiveBillingState[] = ["pending", "grace", "lapsed"];
const ORDER: Record<EffectiveBillingState, number> = { lapsed: 0, grace: 1, pending: 2, active: 3, comped: 4 };
const SHOWN = 40;

/** Chat has no approval queue: the owner mints the link in the Manage dialog. */
const LINK_CHAT_REFUSAL =
  "A fresh checkout link stops every earlier link working and goes to the client, so I can't make one from here. Open the sub-account's Manage dialog → Billing and use Send link.";

const subAccountIdParams = (purpose: string) => ({
  subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
  subAccountName: { type: "string", description: `Its name, for ${purpose}.` },
});

function validateSubAccount(raw: unknown) {
  const padded = paddedSubAccountId(raw);
  if (padded) return padded;
  const subAccountId = str(raw, "subAccountId");
  if (!subAccountId) {
    return { ok: false as const, error: "the sub-account id is required — look it up with list_sub_accounts" };
  }
  return { ok: true as const, args: { subAccountId, subAccountName: str(raw, "subAccountName") } };
}

const billingOf = (data: FirebaseFirestore.DocumentData | undefined) =>
  (data?.billing ?? null) as SubAccountBilling | null;

/** What a fresh link would pay for, read now; refused where none can be minted. */
async function linkPlan(ctx: AiSuiteActionContext, subAccountId: unknown) {
  if (!billingStripeIsConfigured()) {
    throw new CapabilityUserError("No payment provider is configured on this deployment, so a checkout link couldn't be paid.");
  }
  const sub = await subAccountInAgency(ctx.agencyId, subAccountId);
  const billing = billingOf(sub.data());
  if (!billing || billing.status === "comped" || !billing.planId) {
    throw new CapabilityUserError("This client has no plan assigned: assign one before sending a checkout link.");
  }
  if (billing.status === "active") {
    throw new CapabilityUserError("This client already has an active subscription: card changes go through the billing portal.");
  }
  const rows: PreviewRow[] = [
    { label: "Sub-account", value: oneLine(sub.data()?.name ?? sub.id) },
    {
      label: "Plan",
      value: `“${oneLine(billing.planName ?? billing.planId)}” at ${formatBillingPriceWithInterval(billing.priceCents, billing.currency, billing.billingInterval)}`,
    },
    // The stored status, not the derived one: a preview may not read the clock.
    { label: "Billing status", value: billing.status },
    {
      label: "Link",
      value: "A new checkout link for this plan; every earlier link stops working. It is shown on approval, nothing is sent to the client.",
    },
  ];
  return { sub, rows, pinned: { subAccountId: sub.id, planId: billing.planId, priceCents: billing.priceCents, status: billing.status } };
}

export const AGENCY_BILLING_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "billing_overview",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "See every client's billing state — who's paying, pending, in grace, or lapsed",
    description:
      "List this agency's sub-accounts with their Client-billing state: comped (not billed), pending (plan assigned, checkout not completed), active, grace (renewal failed, inside the grace window), or lapsed (paywalled). filter 'needs-attention' = pending + grace + lapsed. Use for 'who hasn't paid?', 'which clients are past due?', 'what's my MRR?'.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: [...FILTERS], description: "Default 'all'." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const filter = str(raw, "filter") || "all";
      if (!(FILTERS as readonly string[]).includes(filter)) {
        return { ok: false, error: "filter must be all, needs-attention, active, or comped" };
      }
      return { ok: true, args: { filter } };
    },
    summarize: (args) => `Show billing overview (${args.filter}).`,
    execute: async (ctx, args) => {
      const snap = await getAdminDb().collection("subAccounts").where("agencyId", "==", ctx.agencyId).get();
      // An agent key reads only the sub-accounts it may act in.
      const docs = ctx.apiKey ? snap.docs.filter((d) => isReachable(d.data(), ctx.agencyId)) : snap.docs;
      const rows = docs.map((d) => {
        const data = d.data();
        const billing = billingOf(data);
        const graceMs = billingDateToMillis(billing?.graceUntil ?? null);
        return {
          id: d.id,
          name: (data.name as string) || "(unnamed)",
          number: typeof data.accountNumber === "number" ? ` #${data.accountNumber}` : "",
          state: effectiveBillingState(billing),
          billing,
          graceUntil: graceMs === null ? null : new Date(graceMs),
        };
      });
      // As the agency billing page rolls it up, so the two never disagree.
      const mrr = new Map<string, number>();
      for (const r of rows) {
        const b = r.billing;
        if (!isMrrEligible(r.state) || typeof b?.priceCents !== "number" || !b.currency) continue;
        mrr.set(b.currency, (mrr.get(b.currency) ?? 0) + monthlyEquivalentCents(b.priceCents, b.billingInterval));
      }
      const mrrLine = mrr.size
        ? `MRR (active + grace, annual ÷ 12): ${[...mrr].map(([c, cents]) => formatBillingPrice(Math.round(cents), c)).join(" + ")}.`
        : "MRR: none yet (no paying subscriptions).";
      const wanted = rows.filter((r) =>
        args.filter === "all" ? true : args.filter === "needs-attention" ? ATTENTION.includes(r.state) : r.state === args.filter
      );
      if (wanted.length === 0) return { resultText: `No sub-accounts match “${args.filter}”. ${mrrLine}` };
      wanted.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
      const lines = wanted.slice(0, SHOWN).map((r) => {
        const b = r.billing;
        const plan = r.state !== "comped" && b?.planName ? `, ${b.planName}` : "";
        const price = r.state !== "comped" && typeof b?.priceCents === "number"
          ? ` ${formatBillingPriceWithInterval(b.priceCents, b.currency, b.billingInterval)}`
          : "";
        const grace = r.state === "grace" && r.graceUntil ? `, grace ends ${r.graceUntil.toISOString().slice(0, 10)}` : "";
        return `- ${r.name}${r.number} — ${r.state.toUpperCase()}${plan}${price}${grace} — id: ${r.id}`;
      });
      const counts = (["active", "pending", "grace", "lapsed", "comped"] as const)
        .map((s) => `${rows.filter((r) => r.state === s).length} ${s}`)
        .join(", ");
      const more = wanted.length > SHOWN ? `\n(+${wanted.length - SHOWN} more — see Agency → Client billing)` : "";
      return {
        resultText: `Client billing (${counts}):\n${lines.join("\n")}${more}\n${mrrLine}`,
        ...(more ? { truncated: true as const } : {}),
      };
    },
  },
  {
    name: "comp_client",
    level: "agency",
    requiredRole: "agencyOwner",
    // Cancelling a subscription can't be undone: chat only, behind a card.
    surfaces: ["chat"],
    menuLabel: "Comp a client — stop billing them (cancels their subscription)",
    description:
      "Mark a sub-account as comped: it's no longer billed, any live subscription on the payment provider is CANCELLED, and the workspace is never paywalled. Feature gates stay as they are (change them with set_feature_gate). Resolve the sub-account's id with list_sub_accounts first — never guess ids. Confirm the user really wants to stop charging this client.",
    parameters: {
      type: "object",
      properties: subAccountIdParams("the confirmation card"),
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: validateSubAccount,
    summarize: (args) =>
      `Comp “${args.subAccountName || args.subAccountId}” — stop billing them and cancel any active subscription.`,
    execute: async (ctx, args) => {
      const sub = await subAccountInAgency(ctx.agencyId, args.subAccountId);
      try {
        await compSubAccount({ agencyId: ctx.agencyId, subAccountId: sub.id });
      } catch (err) {
        if (err instanceof BillingError) throw new CapabilityUserError(err.message);
        throw err;
      }
      return {
        resultText: `“${(sub.data()?.name as string) || sub.id}” is now comped — no further charges, any subscription cancelled, and the workspace won't be paywalled. Their feature gates are unchanged.`,
        ref: { kind: "subAccount", id: sub.id },
      };
    },
  },
  {
    name: "resend_checkout_link",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["agent"],
    approval: "outbound",
    agentArgs: withoutLabels,
    approvalTarget: tenantWide,
    preview: async (ctx, args) => {
      const { rows, pinned } = await linkPlan(ctx, args.subAccountId);
      return { rows, pinned };
    },
    // Agent-only; were it ever offered in chat, it is refused before a card.
    chatRefusal: () => LINK_CHAT_REFUSAL,
    menuLabel: "Get a fresh checkout link for a client who hasn't paid yet",
    description:
      "Mint a new secure checkout link for a sub-account whose plan is assigned but not paid (pending, or a lapsed renewal), for you to send the client; the agency owner approves it first. Re-minting invalidates older links. Resolve the sub-account's id with list_sub_accounts (or billing_overview) first — never guess ids. Not for active subscriptions (they use the billing portal) or comped clients (assign a plan first).",
    parameters: {
      type: "object",
      properties: subAccountIdParams("the confirmation card"),
      // The display name is optional: an agent's is dropped (withoutLabels).
      required: ["subAccountId"],
      additionalProperties: false,
    },
    validate: validateSubAccount,
    summarize: (args) =>
      `Mint a fresh checkout link for “${args.subAccountName || args.subAccountId}” (older links stop working).`,
    execute: async (ctx, args) => {
      // Chat and any unapproved call: refused here, whatever surface asked.
      if (!ctx.approved) throw new CapabilityUserError(LINK_CHAT_REFUSAL);
      const { sub, pinned } = await linkPlan(ctx, args.subAccountId);
      if (canonical(pinned) !== canonical(ctx.approved.pinned ?? null)) {
        throw new CapabilityUserError("The client's plan or billing status changed since this was reviewed; no link was made.");
      }
      // Minting rotates the token first: without a base URL the old link would die and no new one exist.
      if (!process.env.NEXT_PUBLIC_APP_URL?.trim()) {
        throw new CapabilityUserError("NEXT_PUBLIC_APP_URL isn't configured, so no checkout link can be built.");
      }
      let url: string;
      try {
        url = await mintCheckoutLink({ agencyId: ctx.agencyId, subAccountId: sub.id });
      } catch (err) {
        if (err instanceof BillingError) throw new CapabilityUserError(err.message);
        throw err;
      }
      return {
        resultText: `New checkout link for “${(sub.data()?.name as string) || sub.id}”: ${url}\nSend it to the client — their plan activates automatically when they pay. Any earlier link is now invalid.`,
        ref: { kind: "subAccount", id: sub.id },
      };
    },
  },
];
