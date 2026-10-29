import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { formatBillingPrice } from "@/lib/billing/status";
import { usageCurrency } from "@/lib/billing/currency";
import {
  computeOverage,
  getEffectiveQuotas,
  getEffectiveRates,
  sanitizeUsageQuotas,
  usageMonthKey,
  usageRebillingState,
} from "@/lib/server/usage-meter";
import type { UsageMonthDoc, UsageQuotas } from "@/types/usage";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { assertCardNames, paddedSubAccountId, subAccountInAgency } from "./agency-support";

/**
 * Usage tools from upstream 1.0.40 (UPSTREAM_PORT_PLAN.md, N2b), over the
 * usage meter the agency's usage route reads: sub_account_usage is a read
 * for chat and agent; set_usage_limits changes when a client's sends pause,
 * so it is chat only, behind a confirm card.
 */

const LIMIT_KEYS = [
  "emailsPerMonth",
  "smsSegmentsPerMonth",
  "whatsappPerMonth",
  "aiTokensPerMonth",
  "voiceMinutesPerMonth",
] as const;
/** The ledger field each limit caps, and how many ledger units one limit unit is. */
const LEDGER: Record<(typeof LIMIT_KEYS)[number], [keyof UsageMonthDoc, number]> = {
  emailsPerMonth: ["emailsSent", 1],
  smsSegmentsPerMonth: ["smsSegments", 1],
  whatsappPerMonth: ["whatsappMessages", 1],
  aiTokensPerMonth: ["aiTokens", 1],
  voiceMinutesPerMonth: ["voiceSeconds", 60],
};
const LIMIT_UNITS: Record<(typeof LIMIT_KEYS)[number], string> = {
  emailsPerMonth: "emails",
  smsSegmentsPerMonth: "SMS segments",
  whatsappPerMonth: "WhatsApp messages",
  aiTokensPerMonth: "AI tokens",
  voiceMinutesPerMonth: "voice minutes",
};

function validateTarget(raw: unknown) {
  const padded = paddedSubAccountId(raw);
  if (padded) return padded;
  const subAccountId = str(raw, "subAccountId");
  if (!subAccountId) {
    return { ok: false as const, error: "the sub-account id is required — look it up with list_sub_accounts" };
  }
  return { ok: true as const, subAccountId, subAccountName: str(raw, "subAccountName") };
}

const n = (v: number) => v.toLocaleString("en-US");

export const AGENCY_USAGE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "sub_account_usage",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "See a sub-account's usage this month against its limits",
    description:
      "Show one sub-account's current-month usage — emails, SMS segments, WhatsApp messages, AI tokens, voice minutes — against its effective limits (workspace override → plan → unlimited), plus any accrued overage at the plan's rates (only while the client is rebilled). Resolve the sub-account's id with list_sub_accounts first — never guess ids. Use for 'how much SMS has Acme used?', 'is anyone near their limit?'.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the reply." },
      },
      required: ["subAccountId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const t = validateTarget(raw);
      return t.ok ? { ok: true, args: { subAccountId: t.subAccountId, subAccountName: t.subAccountName } } : t;
    },
    summarize: (args) => `Show usage for “${args.subAccountName || args.subAccountId}”.`,
    execute: async (ctx, args) => {
      const subSnap = await subAccountInAgency(ctx.agencyId, args.subAccountId);
      const sub = subSnap.data()!;
      const month = usageMonthKey();
      const usageSnap = await getAdminDb().doc(`subAccounts/${subSnap.id}/usage/${month}`).get();
      const usage = (usageSnap.data() ?? {}) as UsageMonthDoc;
      const subject = sub as Parameters<typeof getEffectiveQuotas>[1];
      const [quotas, rates] = await Promise.all([
        getEffectiveQuotas(subSnap.id, subject),
        getEffectiveRates(subSnap.id, subject),
      ]);
      // Reported only for a rebilled client, as the usage route does.
      const rebilling = await usageRebillingState(sub);
      const overage = computeOverage(usage, quotas, rates);
      const line = (label: string, used: number, limit: number | null | undefined) => {
        const capped = typeof limit === "number" && limit > 0;
        const pct = capped ? ` (${Math.round((used / limit) * 100)}%${used >= limit ? " — CAPPED" : ""})` : "";
        return `- ${label}: ${n(used)} / ${capped ? n(limit) : "unlimited"}${pct}`;
      };
      const lines = [
        line("Emails", usage.emailsSent ?? 0, quotas?.emailsPerMonth),
        line("SMS segments", usage.smsSegments ?? 0, quotas?.smsSegmentsPerMonth),
        line("WhatsApp messages", usage.whatsappMessages ?? 0, quotas?.whatsappPerMonth),
        line("AI tokens", usage.aiTokens ?? 0, quotas?.aiTokensPerMonth),
        line("Voice minutes", Math.round((usage.voiceSeconds ?? 0) / 60), quotas?.voiceMinutesPerMonth),
      ];
      const source = sub.usageQuotas
        ? "workspace override"
        : sub.billing?.planId && quotas
          ? `plan “${sub.billing.planName ?? sub.billing.planId}”`
          : "none set (unlimited)";
      // As the Manage dialog's usage section shows it (the usage route).
      const currency = usageCurrency(sub.billing);
      const overLine = !rebilling.active
        ? "Usage rebilling is off for this client, so overage isn't valued."
        : overage.totalCents > 0
          ? `Accrued overage this month: ${formatBillingPrice(overage.totalCents, currency)} — invoice it with a one-time charge.`
          : "No overage accrued.";
      return {
        resultText: `Usage for “${(sub.name as string) || subSnap.id}” — ${month} (limits from: ${source}):\n${lines.join("\n")}\n${overLine} Capped channels pause until the month resets or the limit is raised.`,
      };
    },
  },
  {
    name: "set_usage_limits",
    level: "agency",
    requiredRole: "agencyOwner",
    // A limit pauses a client's sends when hit: chat only, behind a card.
    surfaces: ["chat"],
    menuLabel: "Set (or clear) a sub-account's monthly usage limits",
    description:
      "Set per-workspace monthly usage limits that OVERRIDE the plan's included allowances for one sub-account: emails, SMS segments, WhatsApp messages, AI tokens, voice minutes. Only the fields given are set — omit a unit to leave it unlimited (the plan's limit for it no longer applies); pass clear=true to remove the override entirely (the plan's limits, if any, apply again). Resolve the sub-account's id with list_sub_accounts first — never guess ids, and pass its name exactly as listed. Before proposing, run sub_account_usage and tell the user this month's usage against the new limits: a limit already reached pauses that channel at once. Limits take effect within a few minutes; when hit, that channel pauses for the workspace until the month resets.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "Sub-account id from list_sub_accounts." },
        subAccountName: { type: "string", description: "Its name, for the confirmation card." },
        ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, { type: "integer", minimum: 1 }])),
        clear: { type: "boolean", description: "true to remove the workspace override." },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const t = validateTarget(raw);
      if (!t.ok) return t;
      // The card names the client by this; execute checks it is the real one.
      if (!t.subAccountName) return { ok: false, error: "the sub-account's name is required, exactly as list_sub_accounts shows it" };
      const r = (raw ?? {}) as Record<string, unknown>;
      const clear = r.clear === true;
      const limits: UsageQuotas = {};
      for (const key of LIMIT_KEYS) {
        const v = r[key];
        if (v === undefined || v === null) continue;
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
          return { ok: false, error: `${key} must be a whole number of at least 1` };
        }
        limits[key] = v;
      }
      if (clear && Object.keys(limits).length > 0) {
        return { ok: false, error: "give limits or clear=true, not both" };
      }
      if (!clear && Object.keys(limits).length === 0) {
        return { ok: false, error: "give at least one limit, or clear=true to remove the override" };
      }
      return { ok: true, args: { subAccountId: t.subAccountId, subAccountName: t.subAccountName, clear, limits } };
    },
    summarize: (args) => {
      const who = args.subAccountName || args.subAccountId;
      if (args.clear) {
        return `Remove the usage-limit override on “${who}” (plan limits apply again, or unlimited).`;
      }
      const l = args.limits as UsageQuotas;
      const parts = LIMIT_KEYS.filter((k) => typeof l[k] === "number").map((k) => `${n(l[k]!)} ${LIMIT_UNITS[k]}`);
      return `Set monthly limits on “${who}”: ${parts.join(", ")} (every other unit unlimited, whatever the plan includes).`;
    },
    execute: async (ctx, args) => {
      const snap = await subAccountInAgency(ctx.agencyId, args.subAccountId);
      assertCardNames(snap, args.subAccountName);
      const quotas = args.clear === true ? null : sanitizeUsageQuotas(args.limits);
      // Nothing valid to set is never read as "clear".
      if (args.clear !== true && !quotas) throw new CapabilityUserError("give at least one limit, or clear=true to remove the override");
      await snap.ref.update({ usageQuotas: quotas, updatedAt: FieldValue.serverTimestamp() });
      const name = (snap.data()?.name as string) || snap.id;
      // This month so far against each new limit: one already reached pauses that channel now.
      const month = usageMonthKey();
      const usage = quotas ? (((await getAdminDb().doc(`subAccounts/${snap.id}/usage/${month}`).get()).data() ?? {}) as UsageMonthDoc) : {};
      const against = LIMIT_KEYS.filter((k) => typeof quotas?.[k] === "number").map((k) => {
        const [field, per] = LEDGER[k];
        const used = Math.round(((usage[field] as number | undefined) ?? 0) / per);
        return `- ${LIMIT_UNITS[k]}: ${n(used)} used of ${n(quotas![k]!)}${used >= quotas![k]! ? " — already reached: paused now until the month resets" : ""}`;
      });
      return {
        resultText: quotas
          ? `Limits saved for “${name}”. Used so far in ${month}:\n${against.join("\n")}\nThey apply within a few minutes; the agency owner is emailed at 80% and 100% of any limit, and a capped channel pauses until the month resets.`
          : `Removed the usage-limit override on “${name}” — the plan's included allowances (if any) apply again.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
];
