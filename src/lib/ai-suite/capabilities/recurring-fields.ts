import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { CapabilityUserError, type ValidateResult } from "./types";
import { ISO_DATE_RE } from "./helpers";
import { hasUnsafeText, lookAlikeProblem, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { QUOTE_FIELD_PROPS, quoteFields } from "./quote-fields";

/**
 * The schedule fields an agent may set (create_recurring_schedule /
 * update_recurring_schedule), checked before the schedule routes' own parser
 * (lib/recurring/schedule-input.ts) runs. The status is never among them:
 * pause / resume / cancel are their own capabilities.
 */

const TEMPLATE_KEYS = ["lineItems", "currency", "globalDiscount", "globalTaxPercent", "termsAndNotes", "billedToOrganization", "billingAddress", "paymentDueDays"] as const;
const TEMPLATE_PROPS = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, QUOTE_FIELD_PROPS[k]]));

export const SCHEDULE_PROPS = {
  name: { type: "string", description: "Your label for it; never shown to the customer." },
  cadence: {
    type: "object",
    properties: { unit: { type: "string", enum: ["week", "month", "quarter", "year"] }, interval: { type: "number", description: "1 to 52." } },
    required: ["unit", "interval"],
    additionalProperties: false,
  },
  anchorDay: { type: "number", description: "Day of the month it bills on (month-based cadences)." },
  timezone: { type: "string", description: "Create only: IANA zone (default: the workspace's)." },
  startDateString: { type: "string", description: "Create only: yyyy-mm-dd." },
  endMode: { type: "string", enum: ["never", "on_date", "after_count"] },
  endDateString: { type: "string", description: "With endMode on_date: yyyy-mm-dd." },
  maxCycles: { type: "number", description: "With endMode after_count." },
  reviewFirst: { type: "boolean", description: "Raise each invoice as a draft for a person to send." },
  chargeMode: { type: "string", enum: ["invoice", "card"], description: "card: charge the customer's saved card (ZAR only)." },
  unpaidEscalationThreshold: { type: "number", description: "Unpaid cycles before a task is raised; 0 is off." },
  ...TEMPLATE_PROPS,
};

const CREATE_ONLY = new Set(["timezone", "startDateString"]);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

export function scheduleFields(raw: unknown, mode: "create" | "update" = "create"): ValidateResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const template = quoteFields(Object.fromEntries(TEMPLATE_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])));
  if (!template.ok) return template;
  const out: Record<string, unknown> = { ...template.args };
  for (const k of Object.keys(SCHEDULE_PROPS)) {
    if (r[k] === undefined || k in out) continue;
    if (mode === "update" && CREATE_ONLY.has(k)) return { ok: false, error: `${k} can only be set when the schedule is created` };
    out[k] = r[k];
  }
  if (out.name !== undefined) {
    if (typeof out.name !== "string" || !out.name.trim() || hasUnsafeText(out.name)) return { ok: false, error: `the name must be visible text (${UNSAFE_TEXT_MESSAGE} is refused)` };
    const lookAlike = lookAlikeProblem(out.name, []);
    if (lookAlike) return { ok: false, error: `the name ${lookAlike}` };
  }
  for (const k of ["anchorDay", "maxCycles", "unpaidEscalationThreshold"]) {
    if (out[k] !== undefined && !num(out[k])) return { ok: false, error: `${k} must be a number` };
  }
  for (const k of ["startDateString", "endDateString"]) {
    if (out[k] !== undefined && !(typeof out[k] === "string" && ISO_DATE_RE.test(out[k] as string))) return { ok: false, error: `${k} must be yyyy-mm-dd` };
  }
  if (out.reviewFirst !== undefined && typeof out.reviewFirst !== "boolean") return { ok: false, error: "reviewFirst must be true or false" };
  if (out.timezone !== undefined && typeof out.timezone !== "string") return { ok: false, error: "timezone must be an IANA zone" };
  if (mode === "create") {
    if (!out.name || !out.cadence || !out.startDateString || !out.lineItems) return { ok: false, error: "name, cadence, startDateString and lineItems are required" };
  } else if (!Object.keys(out).length) {
    return { ok: false, error: "give at least one field to change" };
  }
  return { ok: true, args: out };
}

/** Refuses a name that could pass for another schedule's in the sub-account. */
export async function assertScheduleName(subAccountId: string, name: string, selfId: string | null): Promise<void> {
  const snap = await getAdminDb().collection("recurringInvoices").where("subAccountId", "==", subAccountId).get();
  const problem = lookAlikeProblem(name.trim(), snap.docs.filter((d) => d.id !== selfId).map((d) => String(d.data().name ?? "")));
  if (problem) throw new CapabilityUserError(`The name ${problem} (another schedule's).`);
}
